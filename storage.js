// IndexedDB persistence for the study app. One database, explicit stores,
// promise-wrapped transactions. Validation happens before mutation; writes
// that would partially apply are rolled back by the transaction.

const DB_NAME = "agri-study";
const DB_VERSION = 1;

const STORES = ["pack", "attempts", "segments", "sessions", "settings"];
const DEFAULT_SETTINGS = { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null };

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("IndexedDB request failed"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("transaction failed"));
  });
}

export async function openStore({ idbFactory = globalThis.indexedDB, dbName = DB_NAME } = {}) {
  if (!idbFactory) throw new Error("IndexedDB is not available in this browser");
  const db = await new Promise((resolve, reject) => {
    const r = idbFactory.open(dbName, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("pack")) d.createObjectStore("pack");
      if (!d.objectStoreNames.contains("attempts")) {
        const s = d.createObjectStore("attempts", { keyPath: "id" });
        s.createIndex("instanceId", "instanceId");
      }
      if (!d.objectStoreNames.contains("segments")) d.createObjectStore("segments", { keyPath: "id" });
      if (!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions", { keyPath: "id" });
      if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings");
      if (d.version > DB_VERSION) reject(new Error(`unknown newer database version ${d.version}`));
    };
    r.onsuccess = () => {
      if (r.result.version > DB_VERSION) reject(new Error(`unknown newer database version ${r.result.version}`));
      else resolve(r.result);
    };
    r.onerror = () => reject(r.error || new Error("failed to open database"));
  });

  function run(stores, mode, fn) {
    const tx = db.transaction(stores, mode);
    const done = txDone(tx);
    let out;
    try {
      out = fn(tx);
    } catch (e) {
      try { tx.abort(); } catch {}
      throw e;
    }
    return Promise.resolve(out).then(async v => {
      await done;
      return v;
    });
  }

  return {
    async load() {
      return run(STORES, "readonly", async tx => {
        const [pack, attempts, segments, sessions, settings] = await Promise.all([
          req(tx.objectStore("pack").get("current")),
          req(tx.objectStore("attempts").getAll()),
          req(tx.objectStore("segments").getAll()),
          req(tx.objectStore("sessions").getAll()),
          req(tx.objectStore("settings").get("app")),
        ]);
        return {
          pack: pack ?? null,
          attempts: attempts ?? [],
          segments: segments ?? [],
          sessions: sessions ?? [],
          settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
        };
      });
    },

    async install(pack) {
      // Atomic: pack swap + finishing open sessions in one transaction.
      // A different pack id is rejected so records can never be contaminated
      // by an unrelated pack that reuses question ids; swapping pack families
      // must go through an explicit backup/restore instead.
      return run(["pack", "sessions"], "readwrite", async tx => {
        const current = await req(tx.objectStore("pack").get("current"));
        if (current && current.id !== pack.id)
          throw new Error("installed pack differs: use backup + restore to switch packs");
        tx.objectStore("pack").put(pack, "current");
        const sessions = await req(tx.objectStore("sessions").getAll());
        for (const s of sessions) {
          if (!s.finished) tx.objectStore("sessions").put({ ...s, finished: true });
        }
      });
    },

    async answer(attempt, session) {
      // Atomic attempt + session write; idempotent by instanceId so a retry or
      // double submission records exactly one attempt. Returns the canonical
      // stored attempt — on a duplicate key that is the pre-existing record,
      // so callers always reflect what is actually saved.
      return run(["attempts", "sessions"], "readwrite", async tx => {
        const existing = await req(tx.objectStore("attempts").index("instanceId").get(attempt.instanceId));
        tx.objectStore("sessions").put(session);
        if (existing) return existing;
        tx.objectStore("attempts").add(attempt);
        return attempt;
      });
    },

    async saveSession(session) {
      return run(["sessions"], "readwrite", tx => {
        tx.objectStore("sessions").put(session);
      });
    },

    async saveSegment(segment) {
      // Keyed by stable id: re-saving the same segment overwrites, never doubles.
      return run(["segments"], "readwrite", tx => {
        tx.objectStore("segments").put(segment);
      });
    },

    async saveSettings(settings) {
      return run(["settings"], "readwrite", tx => {
        tx.objectStore("settings").put({ ...DEFAULT_SETTINGS, ...settings }, "app");
      });
    },

    async replace(snapshot) {
      // Full restore: clear + write inside one transaction; any failure aborts
      // and IndexedDB keeps the previous state untouched.
      return run(STORES, "readwrite", async tx => {
        for (const name of STORES) tx.objectStore(name).clear();
        tx.objectStore("pack").put(snapshot.pack, "current");
        for (const a of snapshot.attempts) tx.objectStore("attempts").add(a);
        for (const s of snapshot.segments) tx.objectStore("segments").put(s);
        for (const s of snapshot.sessions) tx.objectStore("sessions").put(s);
        tx.objectStore("settings").put({ ...DEFAULT_SETTINGS, ...snapshot.settings }, "app");
      });
    },
  };
}
