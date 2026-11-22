// Service worker tests using a fake SW global environment. The worker script
// is imported fresh per environment via a query-string module specifier.

import { test } from "node:test";
import assert from "node:assert/strict";

const SCOPE = "http://127.0.0.1:4173/";
const SW_SOURCE = await (await import("node:fs/promises")).readFile(new URL("../web/sw.js", import.meta.url), "utf8");
const CUR = `agri-shell-${SW_SOURCE.match(/const VERSION = "([^"]+)";/)[1]}`;

class FakeCache {
  constructor() {
    this.map = new Map();
  }
  async put(request, response) {
    this.map.set(new Request(request).url, response);
  }
  async match(request) {
    return this.map.get(new Request(request).url);
  }
  async addAll(list) {
    // Atomic like the real API: stage everything first; one failure aborts all.
    const staged = new Map();
    for (const item of list) {
      const res = await fetch(new Request(item));
      staged.set(new Request(item).url, res);
    }
    for (const [k, v] of staged) this.map.set(k, v);
  }
}

let seq = 0;
async function loadWorker({ responses = {}, failUrls = [] } = {}) {
  const stores = new Map();
  const handlers = {};
  const fetchCalls = [];
  const self = {
    registration: { scope: SCOPE },
    location: { origin: "http://127.0.0.1" },
    skipped: false,
    claimed: false,
    addEventListener: (n, f) => (handlers[n] = f),
    skipWaiting() {
      self.skipped = true;
    },
    clients: {
      claim() {
        self.claimed = true;
        return Promise.resolve();
      },
    },
  };
  const caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name);
    },
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
  };
  const g = globalThis;
  const prev = { self: g.self, caches: g.caches, fetch: g.fetch };
  g.self = self;
  g.caches = caches;
  g.fetch = async req => {
    const url = new Request(req).url;
    fetchCalls.push(url);
    if (failUrls.some(u => url.endsWith(u))) throw new Error("network fail");
    return new Response(responses[url] ?? `NET:${url}`);
  };
  await import(`../web/sw.js?case=${++seq}`);
  return {
    self,
    caches,
    stores,
    handlers,
    fetchCalls,
    restore() {
      g.self = prev.self;
      g.caches = prev.caches;
      g.fetch = prev.fetch;
    },
  };
}

function evt() {
  const pending = [];
  return { waitUntil: p => pending.push(p), pending };
}

async function install(env) {
  const e = evt();
  env.handlers.install(e);
  await Promise.all(e.pending);
}

async function fetchEnv(env, url, mode = "no-cors") {
  const req = new Request(url);
  if (mode === "navigate") {
    // undici forbids constructing navigate-mode requests; override the
    // getter to simulate a real navigation FetchEvent.
    Object.defineProperty(req, "mode", { get: () => "navigate" });
  }
  const e = { request: req, responded: null };
  e.respondWith = r => (e.responded = r);
  env.handlers.fetch(e);
  return e.responded ? await e.responded : null;
}

function message(env, data, ports = []) {
  env.handlers.message({ data, ports });
}

test("install caches the full allowlisted shell; CHECK_CACHE reports ok", async () => {
  const env = await loadWorker();
  try {
    await install(env);
    const cache = env.stores.get(CUR);
    assert.ok(cache, "v2 cache exists");
    assert.ok(cache.map.size >= 12);
    const result = await new Promise(res => {
      message(env, { type: "CHECK_CACHE" }, [{ postMessage: res }]);
      setTimeout(() => res(null), 500);
    });
    assert.equal(result.ok, true);
  } finally {
    env.restore();
  }
});

test("navigation is served from the worker's own cache without network", async () => {
  const indexUrl = `${SCOPE}index.html`;
  const env = await loadWorker({ responses: { [indexUrl]: "CACHED-INDEX" } });
  try {
    await install(env);
    env.fetchCalls.length = 0;
    const res = await fetchEnv(env, `${SCOPE}`, "navigate");
    assert.equal(await res.text(), "CACHED-INDEX");
    assert.equal(env.fetchCalls.length, 0, "no network request on cache hit");
  } finally {
    env.restore();
  }
});

test("non-allowlisted URL passes to network and is never cached", async () => {
  const env = await loadWorker();
  try {
    await install(env);
    // The worker must not intercept non-allowlisted URLs at all — no
    // respondWith means the browser's normal network path handles them.
    const res = await fetchEnv(env, `${SCOPE}private-content/secret.pdf`);
    assert.equal(res, null);
    const cache = env.stores.get(CUR);
    assert.ok(![...cache.map.keys()].some(u => u.includes("secret.pdf")));
    // A shell-suffix path that is not in the allowlist must not be cached either.
    await fetchEnv(env, `${SCOPE}other/app.js`);
    assert.ok(![...cache.map.keys()].some(u => u.includes("other/app.js")));
  } finally {
    env.restore();
  }
});

test("failed install leaves any previous version cache intact", async () => {
  const env = await loadWorker({ failUrls: ["style.css"] });
  try {
    // Pre-existing v1 cache standing in for the previously installed worker.
    const v1 = await env.caches.open("agri-shell-v1");
    await v1.put(new Request(`${SCOPE}index.html`), new Response("OLD-INDEX"));
    const e = evt();
    env.handlers.install(e);
    await assert.rejects(Promise.all(e.pending));
    assert.deepEqual([...env.stores.keys()], ["agri-shell-v1", CUR]);
    // v2 cache was staged but nothing committed atomically.
    assert.equal(env.stores.get(CUR).map.size, 0);
    // v1 still serves.
    const res = await env.stores.get("agri-shell-v1").match(`${SCOPE}index.html`);
    assert.equal(await res.text(), "OLD-INDEX");
  } finally {
    env.restore();
  }
});

test("activate removes older agri-shell caches and claims clients", async () => {
  const env = await loadWorker();
  try {
    const v1 = await env.caches.open("agri-shell-v1");
    await v1.put(new Request(`${SCOPE}index.html`), new Response("OLD"));
    await env.caches.open("unrelated-cache");
    await install(env);
    const e = evt();
    env.handlers.activate(e);
    await Promise.all(e.pending);
    assert.deepEqual([...env.stores.keys()].sort(), [CUR, "unrelated-cache"]);
    assert.equal(env.self.claimed, true);
  } finally {
    env.restore();
  }
});

test("SKIP_WAITING message triggers skipWaiting", async () => {
  const env = await loadWorker();
  try {
    message(env, { type: "SKIP_WAITING" });
    assert.equal(env.self.skipped, true);
  } finally {
    env.restore();
  }
});

test("CHECK_CACHE reports not-ok when an entry is missing", async () => {
  const env = await loadWorker();
  try {
    await install(env);
    const cache = env.stores.get(CUR);
    cache.map.delete(`${SCOPE}timer.js`);
    const result = await new Promise(res => {
      message(env, { type: "CHECK_CACHE" }, [{ postMessage: res }]);
      setTimeout(() => res(null), 500);
    });
    assert.equal(result.ok, false);
  } finally {
    env.restore();
  }
});
