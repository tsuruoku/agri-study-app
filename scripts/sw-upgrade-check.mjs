// Live SW upgrade proof: with the app already installed under service worker
// version A, a rebuild that changes any shell file must produce a new stamped
// VERSION → new sw.js bytes → browser detects the update → the app shows the
// 「更新する」 notice → clicking it activates the new worker which controls
// the page and owns the only remaining cache.
//
// Same-origin is required (SW scope), so this drives the real dist/ under the
// running preview server. It temporarily appends a comment to web/app.js,
// rebuilds (the real path), then restores both web/app.js and dist/.
//
// Usage: node scripts/sw-upgrade-check.mjs  (requires serve.mjs on :4173)

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const APP = "http://127.0.0.1:4173/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9225;
const APPJS = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "app.js");

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsFor(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  return (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function evaljs(call, expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? "eval error" };
  return r.result?.result?.value;
}
const versionOf = src => src.match(/^const VERSION = "([^"]*)";$/m)?.[1];

const originalAppJs = readFileSync(APPJS, "utf8");
const profile = mkdtempSync(join(tmpdir(), "agri-chrome-upg-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });

try {
  const v1 = versionOf(readFileSync(join(dirname(APPJS), "..", "dist", "sw.js"), "utf8"));
  console.log("installed shell version:", v1);
  if (!v1 || v1 === "dev") throw new Error("dist/sw.js has no stamped version — run build first");

  let call = null;
  for (let i = 0; i < 40 && !call; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find(t => t.type === "page");
      call = await wsFor(page.webSocketDebuggerUrl);
    } catch {}
  }
  await call("Page.enable"); await call("Runtime.enable");
  await call("Page.navigate", { url: APP });
  await sleep(3000);

  const before = await evaljs(call, `(async () => ({
    keys: await caches.keys(),
    controlled: !!navigator.serviceWorker.controller,
  }))()`);
  console.log("before:", JSON.stringify(before));
  if (!before?.controlled) throw new Error("no SW controller after first load");
  if (!before.keys?.some(k => k === `agri-shell-${v1}`))
    throw new Error("active cache does not match installed version");

  // Real upgrade path: change a copied shell file, rebuild → new stamped sw.js.
  writeFileSync(APPJS, originalAppJs + "\n// upgrade-check bump\n");
  await build();
  const v2 = versionOf(readFileSync(join(dirname(APPJS), "..", "dist", "sw.js"), "utf8"));
  console.log("rebuilt shell version:", v2);
  if (v2 === v1) throw new Error("rebuild did not change the stamped version");

  await call("Page.navigate", { url: APP });
  await sleep(3500); // reload → update check → install → waiting

  const notice = await evaljs(call, `(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '更新する');
    return { waiting: !!reg?.waiting, notice: !!btn,
             text: document.getElementById('app').innerText.match(/更新[^\\n]*/)?.[0] ?? null };
  })()`);
  console.log("update offer:", JSON.stringify(notice));
  if (!notice.waiting || !notice.notice) throw new Error("「更新する」 notice/waiting worker missing");

  // The app reloads once the new worker takes control — the eval context dies,
  // so click and then poll from here until the new shell owns everything.
  await evaljs(call, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent === '更新する');
    b?.click(); return !!b;
  })()`);
  let after = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      after = await evaljs(call, `(async () => ({
        keys: await caches.keys(),
        controlled: !!navigator.serviceWorker.controller,
        booted: !!window.__agri,
      }))()`);
    } catch {}
    if (after?.keys?.length === 1 && after.keys[0] === `agri-shell-${v2}` && after.booted) break;
  }
  console.log("after:", JSON.stringify(after));
  if (!after?.controlled || !after.booted) throw new Error("no controller/app after update");
  if (!after.keys?.includes(`agri-shell-${v2}`) || after.keys.length !== 1)
    throw new Error("new version does not exclusively own the cache: " + JSON.stringify(after.keys));

  console.log(`UPGRADE PROOF OK: ${v1} → ${v2}, 更新する shown, new worker controls, old cache gone`);
} catch (e) {
  console.error("sw-upgrade-check error:", e);
  process.exitCode = 1;
} finally {
  chrome.kill("SIGTERM");
  writeFileSync(APPJS, originalAppJs); // restore source
  await build();                       // restore dist to canonical
}
