import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../web/storage.js";
import { makePack, attempt, session, segment } from "./fixture.mjs";
import { createIDBFactory } from "./harness/idb-memory.mjs";

function freshFactory() {
  return globalThis.indexedDB ?? createIDBFactory();
}

let dbSeq = 0;
async function store() {
  return openStore({ idbFactory: freshFactory(), dbName: `test-${++dbSeq}` });
}

const defaults = { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null };

test("empty store loads defaults", async () => {
  const s = await store();
  const snap = await s.load();
  assert.equal(snap.pack, null);
  assert.deepEqual(snap.attempts, []);
  assert.deepEqual(snap.sessions, []);
  assert.deepEqual(snap.segments, []);
  assert.deepEqual(snap.settings, defaults);
});

test("settings round-trips through save and load", async () => {
  const s = await store();
  await s.saveSettings({ examDate: "2027-05-01", resumeLessonId: "les-a1", resumeScroll: 40, lastBackupAt: 5 });
  const snap = await s.load();
  assert.equal(snap.settings.examDate, "2027-05-01");
  assert.equal(snap.settings.resumeScroll, 40);
});

test("answer writes attempt and session atomically; retry is idempotent", async () => {
  const s = await store();
  await s.install(await makePack());
  const ses = session({ id: "s1" });
  await s.saveSession(ses);
  const att = attempt({ sessionId: "s1", instanceId: "inst-1" });
  const ses2 = { ...ses, index: 1, answers: [{ instanceId: "inst-1", optionId: "o3" }] };
  await s.answer(att, ses2);
  // Same instanceId again (double-tap / retry) must not double-record.
  await s.answer(att, ses2);
  const snap = await s.load();
  assert.equal(snap.attempts.length, 1);
  assert.equal(snap.sessions.find(x => x.id === "s1").index, 1);
});

test("install preserves records and finishes open sessions", async () => {
  const s = await store();
  await s.install(await makePack());
  const seg = segment();
  await s.saveSegment(seg);
  await s.saveSession(session({ id: "open-1", finished: false }));
  await s.install(await makePack({ version: "2" }));
  const snap = await s.load();
  assert.equal(snap.pack.version, "2");
  assert.equal(snap.segments.length, 1);
  assert.equal(snap.sessions.find(x => x.id === "open-1").finished, true);
});

test("duplicate segment ids dedupe by overwrite", async () => {
  const s = await store();
  const seg = segment({ id: "seg-x", seconds: 3 });
  await s.saveSegment(seg);
  await s.saveSegment(seg);
  const snap = await s.load();
  assert.equal(snap.segments.length, 1);
});

test("replace writes a whole snapshot; failure keeps old data", async () => {
  const s = await store();
  await s.install(await makePack());
  const seg = segment({ id: "keep-me" });
  await s.saveSegment(seg);
  await s.saveSettings({ ...defaults, examDate: "2027-01-01" });

  // Broken snapshot: an attempt missing its required keyPath id aborts the tx.
  await assert.rejects(
    s.replace({
      pack: await makePack({ version: "9" }),
      attempts: [attempt({ id: undefined })],
      segments: [],
      sessions: [],
      settings: { ...defaults },
    })
  );
  const after = await s.load();
  assert.equal(after.pack.version, "1");
  assert.equal(after.segments.length, 1);
  assert.equal(after.segments[0].id, "keep-me");
  assert.equal(after.settings.examDate, "2027-01-01");

  // Valid snapshot replaces everything.
  await s.replace({
    pack: await makePack({ version: "9" }),
    attempts: [attempt({ id: "a1" })],
    segments: [segment({ id: "s9" })],
    sessions: [],
    settings: { ...defaults, examDate: "2028-02-02" },
  });
  const snap2 = await s.load();
  assert.equal(snap2.pack.version, "9");
  assert.equal(snap2.attempts.length, 1);
  assert.equal(snap2.segments[0].id, "s9");
  assert.equal(snap2.settings.examDate, "2028-02-02");
});

test("install rejects a pack with a different id, leaving current data", async () => {
  const s = await store();
  await s.install(await makePack({ id: "pack-one" }));
  await s.saveSegment(segment({ id: "seg-keep" }));
  await assert.rejects(s.install(await makePack({ id: "pack-two" })), /pack/);
  const snap = await s.load();
  assert.equal(snap.pack.id, "pack-one");
  assert.equal(snap.segments[0].id, "seg-keep");
});

test("install allows same-id pack update (version bump)", async () => {
  const s = await store();
  await s.install(await makePack({ id: "pack-one", version: "1" }));
  await s.install(await makePack({ id: "pack-one", version: "2" }));
  assert.equal((await s.load()).pack.version, "2");
});

test("answer returns canonical attempt on duplicate instanceId", async () => {
  const s = await store();
  const att = attempt({ id: "a-first", instanceId: "inst-1" });
  const ses = session();
  const saved1 = await s.answer(att, ses);
  assert.equal(saved1.id, "a-first");
  const retry = attempt({ id: "a-second", instanceId: "inst-1" });
  const saved2 = await s.answer(retry, ses);
  assert.equal(saved2.id, "a-first", "returns the originally saved attempt");
  const snap = await s.load();
  assert.equal(snap.attempts.length, 1);
  assert.equal(snap.attempts[0].id, "a-first");
});
