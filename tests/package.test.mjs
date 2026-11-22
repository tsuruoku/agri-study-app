import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePackage, readPackage, serializeBackup } from "../web/package.js";
import { makePackage, makePack, question, attempt, session, segment, PNG_B64 } from "./fixture.mjs";

function fakeFile(text, size = null) {
  return { size: size === null ? text.length : size, text: async () => text };
}

test("valid content package validates", async () => {
  const pkg = await makePackage();
  const out = await validatePackage(pkg);
  assert.equal(out.kind, "content");
  assert.equal(out.pack.id, "fixture-pack");
  assert.equal(out.pack.questions.length, 7);
});

test("readPackage parses JSON from a file-like object", async () => {
  const pkg = await makePackage();
  const out = await readPackage(fakeFile(JSON.stringify(pkg)));
  assert.equal(out.pack.id, "fixture-pack");
});

test("rejects wrong format, schema and kind", async () => {
  await assert.rejects(validatePackage({ ...(await makePackage()), format: "other" }), /format/);
  await assert.rejects(validatePackage({ ...(await makePackage()), schema: 2 }), /schema/);
  await assert.rejects(validatePackage({ ...(await makePackage()), kind: "x" }), /kind/);
  await assert.rejects(validatePackage("nope"), /object|package/i);
  await assert.rejects(validatePackage(null), /object|package/i);
});

test("rejects duplicate ids", async () => {
  for (const key of ["categories", "lessons", "questions", "assets"]) {
    const pkg = await makePackage();
    pkg.pack[key].push({ ...pkg.pack[key][0] });
    await assert.rejects(validatePackage(pkg), new RegExp(`duplicate|${key}`, "i"));
  }
});

test("rejects 4-option and 6-option questions", async () => {
  for (const count of [4, 6]) {
    const pkg = await makePackage();
    pkg.pack.questions[0].options = Array.from({ length: count }, (_, i) => ({ id: `x${i}`, text: "x" }));
    pkg.pack.questions[0].correctId = "x0";
    await assert.rejects(validatePackage(pkg), /5|option/i);
  }
});

test("rejects missing or unknown correctId", async () => {
  let pkg = await makePackage();
  pkg.pack.questions[0].correctId = "nope";
  await assert.rejects(validatePackage(pkg), /correctId|correct/i);
  pkg = await makePackage();
  delete pkg.pack.questions[0].correctId;
  await assert.rejects(validatePackage(pkg), /correctId|correct/i);
});

test("rejects unknown references", async () => {
  let pkg = await makePackage();
  pkg.pack.questions[0].categoryId = "ghost";
  await assert.rejects(validatePackage(pkg), /category/i);
  pkg = await makePackage();
  pkg.pack.questions[0].lessonId = "ghost";
  await assert.rejects(validatePackage(pkg), /lesson/i);
  pkg = await makePackage();
  pkg.pack.questions[0].imageId = "ghost";
  await assert.rejects(validatePackage(pkg), /asset|image/i);
  pkg = await makePackage();
  pkg.pack.lessons[0].blocks[1].assetId = "ghost";
  await assert.rejects(validatePackage(pkg), /asset|image/i);
});

test("rejects svg assets and remote URLs anywhere in pack strings", async () => {
  let pkg = await makePackage();
  pkg.pack.assets[0].mime = "image/svg+xml";
  await assert.rejects(validatePackage(pkg), /mime|svg/i);
  pkg = await makePackage();
  pkg.pack.lessons[0].blocks[0].text = "see https://evil.example/x";
  await assert.rejects(validatePackage(pkg), /url|http/i);
  pkg = await makePackage();
  pkg.pack.questions[0].prompt = "図 http://x.test/a.png";
  await assert.rejects(validatePackage(pkg), /url|http/i);
});

test("rejects invalid base64 and mismatched sha256", async () => {
  let pkg = await makePackage();
  pkg.pack.assets[0].data = "!!!not-base64!!!";
  await assert.rejects(validatePackage(pkg), /base64/i);
  pkg = await makePackage();
  pkg.pack.assets[0].sha256 = "0".repeat(64);
  await assert.rejects(validatePackage(pkg), /sha256|checksum/i);
  pkg = await makePackage();
  pkg.pack.assets[0].sha256 = "xyz";
  await assert.rejects(validatePackage(pkg), /sha256|checksum/i);
});

test("rejects count bounds and oversized strings", async () => {
  const pkg = await makePackage();
  pkg.pack.questions = Array.from({ length: 2001 }, (_, i) => question(`qq${i}`));
  await assert.rejects(validatePackage(pkg), /2000|questions/i);
  const pkg2 = await makePackage();
  pkg2.pack.lessons[0].blocks[0].text = "あ".repeat(100001);
  await assert.rejects(validatePackage(pkg2), /100000|string|size/i);
});

test("rejects files over 100 MiB and images over 80 MiB decoded", async () => {
  await assert.rejects(readPackage(fakeFile("{}", 101 * 1024 * 1024)), /size|100/i);
  const pkg = await makePackage();
  // Injected small limit exercises the decoded-size guard without a huge fixture.
  await assert.rejects(validatePackage(pkg, { maxImageBytes: 1 }), /image|asset|size/i);
  // Default limits allow the fixture.
  await validatePackage(pkg);
});

test("markup in strings is inert data, never executed", async () => {
  const pkg = await makePackage();
  pkg.pack.title = '<script>throw new Error("run")</script>';
  const out = await validatePackage(pkg);
  assert.equal(out.pack.title, '<script>throw new Error("run")</script>');
});

test("backup kind validates records; bad attempt references reject", async () => {
  const pack = await makePack();
  const records = {
    attempts: [attempt({ questionId: "q1" })],
    segments: [segment()],
    sessions: [session()],
    settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null },
  };
  const out = await validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack, records });
  assert.equal(out.kind, "backup");

  // A questionId that no longer exists is kept as retired history.
  const retired = structuredClone(records);
  retired.attempts[0].questionId = "ghost";
  const ok = await validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack, records: retired });
  assert.equal(ok.records.attempts.length, 1);

  // Structurally invalid records still reject.
  const bad = structuredClone(records);
  delete bad.attempts[0].id;
  await assert.rejects(
    validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack, records: bad }),
    /attempts/
  );
});

test("old-revision historical attempts with foreign optionId are preserved", async () => {
  const pack = await makePack();
  const records = {
    attempts: [attempt({ questionId: "q1", revision: 99, optionId: "retired-opt" })],
    segments: [],
    sessions: [],
    settings: { examDate: "2027-05-01", resumeLessonId: "les-a1", resumeScroll: 12.5, lastBackupAt: 1 },
  };
  const out = await validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack, records });
  assert.equal(out.records.attempts[0].optionId, "retired-opt");

  // Same-revision attempt must reference a real option.
  records.attempts[0].revision = 1;
  await assert.rejects(
    validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack, records }),
    /option/i
  );
});

test("rejects invalid record field types", async () => {
  const pack = await makePack();
  const mk = (records) =>
    validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack, records });
  await assert.rejects(mk({ attempts: [attempt({ at: -5 })], segments: [], sessions: [],
    settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null } }), /at|time|finite/i);
  await assert.rejects(mk({ attempts: [], segments: [segment({ seconds: -1 })], sessions: [],
    settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null } }), /seconds|finite/i);
  await assert.rejects(mk({ attempts: [], segments: [segment({ date: "Nov 14" })], sessions: [],
    settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null } }), /date/i);
});

test("serializeBackup emits a valid backup package", async () => {
  const pack = await makePack();
  const snapshot = {
    pack,
    attempts: [attempt()],
    segments: [segment()],
    sessions: [session()],
    settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null },
  };
  const text = serializeBackup(snapshot);
  const out = await validatePackage(JSON.parse(text));
  assert.equal(out.kind, "backup");
  assert.equal(out.records.attempts.length, 1);
});

test("lesson sourceAssetIds must reference known assets", async () => {
  const pkg = await makePackage();
  const out = await validatePackage(pkg);
  assert.equal(out.pack.lessons[0].sourceAssetIds[0], "ast-2");
  pkg.pack.lessons[0].sourceAssetIds = ["missing-asset"];
  await assert.rejects(validatePackage(pkg), /sourceAssetIds|asset/);
});

test("asset mime must match binary signature", async () => {
  const pkg = await makePackage();
  pkg.pack.assets[0].mime = "image/jpeg"; // PNG bytes labelled JPEG
  await assert.rejects(validatePackage(pkg), /signature|mime/);
});

test("backup keeps retired history for removed questions", async () => {
  // v1 pack with attempts, then v2 drops q1 entirely.
  const v1 = await makePack();
  const att = attempt({ id: "a-old", questionId: "q1", instanceId: "inst-old" });
  const finishedSes = session({ id: "ses-old", finished: true, questions: [{ id: "q1", revision: 1 }] });
  const v2 = await makePack({ version: "2" });
  v2.questions = v2.questions.filter(q => q.id !== "q1");
  const backup = {
    format: "agri-study", schema: 1, kind: "backup",
    pack: v2,
    records: {
      attempts: [att],
      segments: [segment({ id: "seg-x" })],
      sessions: [finishedSes],
      settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null },
    },
  };
  const out = await validatePackage(backup);
  assert.equal(out.records.attempts.length, 1);
});

test("backup validates current-revision correctness and option refs", async () => {
  const v2 = await makePack({ version: "2" });
  const records = over => ({
    attempts: [attempt(over)],
    segments: [], sessions: [],
    settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null },
  });
  // wrong option id at current revision
  await assert.rejects(validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack: v2, records: records({ optionId: "nope" }) }), /option/);
  // 'correct' inconsistent with chosen option
  await assert.rejects(validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack: v2, records: records({ optionId: "o1", correct: true }) }), /correct/);
  // older revision history is kept without option checks
  const out = await validatePackage({ format: "agri-study", schema: 1, kind: "backup", pack: v2, records: records({ revision: 0 }) });
  assert.equal(out.records.attempts.length, 1);
});

test("backup rejects duplicate record ids", async () => {
  const mk = async records => validatePackage({
    format: "agri-study", schema: 1, kind: "backup", pack: await makePack(),
    records: { segments: [], sessions: [], settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null }, ...records },
  });
  await assert.rejects(mk({ attempts: [attempt({ id: "dup" }), attempt({ id: "dup", instanceId: "i2" })] }), /duplicate/);
  await assert.rejects(mk({ attempts: [attempt({ id: "a1", instanceId: "same" }), attempt({ id: "a2", instanceId: "same" })] }), /duplicate|instanceId/);
  await assert.rejects(mk({ attempts: [], segments: [segment({ id: "d" }), segment({ id: "d" })] }), /duplicate/);
  await assert.rejects(mk({ attempts: [], sessions: [session({ id: "d" }), session({ id: "d", finished: true })] }), /duplicate/);
});

test("unfinished session must have resolvable questions and in-bounds index", async () => {
  const mk = async (ses) => validatePackage({
    format: "agri-study", schema: 1, kind: "backup", pack: await makePack(),
    records: { attempts: [], segments: [], sessions: [ses], settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null } },
  });
  await assert.rejects(mk(session({ id: "s1", questions: [{ id: "ghost", revision: 1 }] })), /unknown question/);
  await assert.rejects(mk(session({ id: "s2", index: 5 })), /index/);
  await assert.rejects(mk(session({ id: "s3", questions: [{ id: "q1", revision: 99 }] })), /revision/);
  // finished sessions may keep retired refs
  const out = await mk(session({ id: "s4", finished: true, index: 9, questions: [{ id: "ghost", revision: 1 }] }));
  assert.equal(out.records.sessions.length, 1);
});

test("session lessonId is optional, a nonempty string, and round-trips", async () => {
  const mk = async ses => validatePackage({
    format: "agri-study", schema: 1, kind: "backup", pack: await makePack(),
    records: { attempts: [], segments: [], sessions: [ses], settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null } },
  });
  const out = await mk(session({ id: "sl", lessonId: "les-a1" }));
  assert.equal(out.records.sessions[0].lessonId, "les-a1");
  await mk(session({ id: "sn" })); // absent is fine
  await assert.rejects(mk(session({ id: "snum", lessonId: 5 })), /lessonId/);
  await assert.rejects(mk(session({ id: "sempty", lessonId: "" })), /lessonId/);
  await assert.rejects(mk(session({ id: "sobj", lessonId: { x: 1 } })), /lessonId/);
});
