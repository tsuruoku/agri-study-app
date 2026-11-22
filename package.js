// Package validation for .agristudy JSON files. Imports never execute markup
// and accept only validated, checksummed data.

const FORMAT = "agri-study";
const SCHEMA = 1;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const MAX_STRING = 100_000;
const MAX_QUESTIONS = 2000;
const MAX_LESSONS = 500;
const MAX_ASSETS = 200;
const OPTION_COUNT = 5;

class PackageError extends Error {}

function fail(msg) {
  throw new PackageError(msg);
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v, name, { nonempty = false } = {}) {
  if (typeof v !== "string") fail(`${name} must be a string`);
  if (v.length > MAX_STRING) fail(`${name} exceeds maximum string length of ${MAX_STRING}`);
  if (/https?:\/\//i.test(v)) fail(`${name} must not contain remote URLs`);
  if (nonempty && v.trim() === "") fail(`${name} must not be empty`);
  return v;
}

function num(v, name, { int = false, min = null } = {}) {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name} must be a finite number`);
  if (int && !Number.isInteger(v)) fail(`${name} must be an integer`);
  if (min !== null && v < min) fail(`${name} must be >= ${min}`);
  return v;
}

function bool(v, name) {
  if (typeof v !== "boolean") fail(`${name} must be boolean`);
  return v;
}

function arr(v, name, { max = null } = {}) {
  if (!Array.isArray(v)) fail(`${name} must be an array`);
  if (max !== null && v.length > max) fail(`${name} exceeds maximum of ${max}`);
  return v;
}

function ids(list, name) {
  const seen = new Set();
  for (const item of list) {
    str(item.id, `${name} id`, { nonempty: true });
    if (seen.has(item.id)) fail(`duplicate ${name} id: ${item.id}`);
    seen.add(item.id);
  }
  return seen;
}

function dateStr(v, name, nullable = false) {
  if (v === null && nullable) return v;
  str(v, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(`${name} must be YYYY-MM-DD`);
  return v;
}

async function sha256hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function b64ToBytes(b64, name) {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0)
    fail(`${name} is not valid base64`);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    fail(`${name} is not valid base64`);
  }
}

function validateAttempt(a, i, qById) {
  if (!isObj(a)) fail(`attempts[${i}] must be an object`);
  str(a.id, `attempts[${i}].id`, { nonempty: true });
  str(a.sessionId, `attempts[${i}].sessionId`);
  str(a.instanceId, `attempts[${i}].instanceId`, { nonempty: true });
  str(a.questionId, `attempts[${i}].questionId`, { nonempty: true });
  // Unknown questionId is allowed: the question may have been retired by a
  // newer pack version. Structurally valid retired history stays restorable.
  const q = qById.get(a.questionId);
  num(a.revision, `attempts[${i}].revision`, { int: true, min: 0 });
  str(a.optionId, `attempts[${i}].optionId`, { nonempty: true });
  bool(a.correct, `attempts[${i}].correct`);
  num(a.at, `attempts[${i}].at`, { min: 0 });
  if (q && a.revision === q.revision) {
    // Current-revision attempts must be consistent with the question as it
    // exists now; older-revision history is kept without these checks.
    if (!q.options.some(o => o.id === a.optionId))
      fail(`attempts[${i}] optionId not in question options`);
    if (a.correct !== (a.optionId === q.correctId))
      fail(`attempts[${i}] correct flag inconsistent with optionId`);
  }
}

function validateSegment(s, i) {
  if (!isObj(s)) fail(`segments[${i}] must be an object`);
  str(s.id, `segments[${i}].id`, { nonempty: true });
  num(s.start, `segments[${i}].start`, { min: 0 });
  num(s.end, `segments[${i}].end`, { min: 0 });
  if (s.end < s.start) fail(`segments[${i}].end before start`);
  num(s.seconds, `segments[${i}].seconds`, { min: 0 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(typeof s.date === "string" ? s.date : ""))
    fail(`segments[${i}].date must be YYYY-MM-DD`);
  str(s.zone, `segments[${i}].zone`);
  if (s.mode !== "lesson" && s.mode !== "quiz") fail(`segments[${i}].mode invalid`);
}

function validateSession(s, i, qById) {
  if (!isObj(s)) fail(`sessions[${i}] must be an object`);
  str(s.id, `sessions[${i}].id`, { nonempty: true });
  arr(s.questions, `sessions[${i}].questions`);
  for (const q of s.questions) {
    str(q.id, `sessions[${i}].question.id`, { nonempty: true });
    num(q.revision, `sessions[${i}].question.revision`, { int: true, min: 1 });
  }
  num(s.index, `sessions[${i}].index`, { int: true, min: 0 });
  if (s.lessonId !== undefined) str(s.lessonId, `sessions[${i}].lessonId`, { nonempty: true });
  arr(s.answers, `sessions[${i}].answers`);
  for (const a of s.answers) {
    str(a.instanceId, `sessions[${i}].answer.instanceId`, { nonempty: true });
    str(a.optionId, `sessions[${i}].answer.optionId`, { nonempty: true });
  }
  bool(s.finished, `sessions[${i}].finished`);
  if (!s.finished) {
    // An unfinished session is resumable, so every question it points at must
    // still exist at the same revision and the index must be in bounds.
    if (s.index >= s.questions.length) fail(`sessions[${i}].index out of bounds`);
    for (const qref of s.questions) {
      const q = qById.get(qref.id);
      if (!q) fail(`sessions[${i}] references unknown question`);
      if (q.revision !== qref.revision) fail(`sessions[${i}] question ${qref.id} revision mismatch`);
    }
  }
}

function validateSettings(s) {
  if (!isObj(s)) fail("settings must be an object");
  if (s.examDate !== null) dateStr(s.examDate, "settings.examDate");
  if (s.resumeLessonId !== null) str(s.resumeLessonId, "settings.resumeLessonId");
  num(s.resumeScroll, "settings.resumeScroll", { min: 0 });
  if (s.lastBackupAt !== null) num(s.lastBackupAt, "settings.lastBackupAt", { min: 0 });
}

export async function validatePackage(value, { maxImageBytes = MAX_IMAGE_BYTES } = {}) {
  if (!isObj(value)) fail("package must be an object");
  if (value.format !== FORMAT) fail(`format must be "${FORMAT}"`);
  if (value.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
  if (value.kind !== "content" && value.kind !== "backup") fail(`kind must be "content" or "backup"`);

  const refs = await validatePack(value.pack, maxImageBytes);

  if (value.kind === "backup" || value.records !== undefined) {
    if (!isObj(value.records)) fail("records must be an object for backup packages");
    const r = value.records;
    const attempts = arr(r.attempts, "records.attempts");
    attempts.forEach((a, i) => validateAttempt(a, i, refs.qById));
    const segments = arr(r.segments, "records.segments");
    segments.forEach(validateSegment);
    const sessions = arr(r.sessions, "records.sessions");
    sessions.forEach((s, i) => validateSession(s, i, refs.qById));
    validateSettings(r.settings);
    ids(attempts, "attempt");
    ids(segments, "segment");
    ids(sessions, "session");
    const instIds = new Set();
    for (const a of attempts) {
      if (instIds.has(a.instanceId)) fail(`duplicate attempt instanceId: ${a.instanceId}`);
      instIds.add(a.instanceId);
    }
  }
  return { kind: value.kind, pack: value.pack, records: value.records };
}

async function validatePack(pack, limit) {
  if (!isObj(pack)) fail("pack must be an object");
  str(pack.id, "pack.id", { nonempty: true });
  str(pack.version, "pack.version", { nonempty: true });
  str(pack.title, "pack.title", { nonempty: true });

  const categories = arr(pack.categories, "pack.categories");
  ids(categories, "category");
  const catIds = new Set(categories.map(c => {
    str(c.title, "category.title", { nonempty: true });
    return c.id;
  }));

  const assets = arr(pack.assets, "pack.assets", { max: MAX_ASSETS });
  ids(assets, "asset");
  let imageBytes = 0;
  const assetIds = new Set();
  const decoded = [];
  for (const a of assets) {
    str(a.id, "asset.id");
    if (a.mime !== "image/jpeg" && a.mime !== "image/png")
      fail(`asset ${a.id} mime must be image/jpeg or image/png`);
    const bytes = b64ToBytes(a.data, `asset ${a.id} data`);
    imageBytes += bytes.length;
    if (!/^[0-9a-f]{64}$/i.test(a.sha256)) fail(`asset ${a.id} sha256 must be 64 hex chars`);
    assetIds.add(a.id);
    decoded.push([a, bytes]);
  }
  if (imageBytes > limit) fail(`decoded image total ${imageBytes} exceeds image size limit`);
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const JPEG_SIG = [0xff, 0xd8, 0xff];
  for (const [a, bytes] of decoded) {
    if ((await sha256hex(bytes)).toLowerCase() !== a.sha256.toLowerCase())
      fail(`asset ${a.id} sha256 checksum mismatch`);
    const sig = a.mime === "image/png" ? PNG_SIG : JPEG_SIG;
    if (bytes.length < sig.length || sig.some((b, j) => bytes[j] !== b))
      fail(`asset ${a.id} binary signature does not match ${a.mime}`);
  }

  const lessons = arr(pack.lessons, "pack.lessons", { max: MAX_LESSONS });
  ids(lessons, "lesson");
  const lessonIds = new Set();
  for (const l of lessons) {
    str(l.id, "lesson.id");
    if (!catIds.has(l.categoryId)) fail(`lesson ${l.id} has unknown categoryId`);
    str(l.title, "lesson.title", { nonempty: true });
    num(l.page, `lesson ${l.id} page`);
    arr(l.blocks, `lesson ${l.id} blocks`);
    for (const b of l.blocks) {
      if (!isObj(b)) fail("lesson block must be an object");
      if (b.type === "text") str(b.text, "lesson block text");
      else if (b.type === "image") {
        if (!assetIds.has(b.assetId)) fail(`lesson ${l.id} references unknown assetId`);
        str(b.alt, "lesson image alt");
      } else fail(`lesson ${l.id} has unknown block type`);
    }
    if (l.sourceAssetIds !== undefined) {
      arr(l.sourceAssetIds, `lesson ${l.id} sourceAssetIds`, { max: 50 });
      for (const aid of l.sourceAssetIds) {
        str(aid, `lesson ${l.id} sourceAssetIds entry`, { nonempty: true });
        if (!assetIds.has(aid)) fail(`lesson ${l.id} sourceAssetIds references unknown assetId`);
      }
    }
    bool(l.verified, `lesson ${l.id} verified`);
    lessonIds.add(l.id);
  }

  const questions = arr(pack.questions, "pack.questions", { max: MAX_QUESTIONS });
  ids(questions, "question");
  const qById = new Map();
  for (const q of questions) {
    str(q.id, "question.id");
    num(q.revision, `question ${q.id} revision`, { int: true, min: 1 });
    if (!catIds.has(q.categoryId)) fail(`question ${q.id} has unknown categoryId`);
    if (!lessonIds.has(q.lessonId)) fail(`question ${q.id} has unknown lessonId`);
    if (q.kind !== "example" && q.kind !== "original" && q.kind !== "past") fail(`question ${q.id} has invalid kind`);
    str(q.prompt, `question ${q.id} prompt`, { nonempty: true });
    arr(q.options, `question ${q.id} options`);
    if (q.options.length !== OPTION_COUNT)
      fail(`question ${q.id} must have exactly ${OPTION_COUNT} options`);
    ids(q.options, `question ${q.id} option`);
    for (const o of q.options) str(o.text, `question ${q.id} option text`, { nonempty: true });
    if (!q.options.some(o => o.id === q.correctId))
      fail(`question ${q.id} correctId must reference an option`);
    str(q.explanation, `question ${q.id} explanation`);
    num(q.page, `question ${q.id} page`);
    if (q.imageId !== undefined && q.imageId !== null && !assetIds.has(q.imageId))
      fail(`question ${q.id} references unknown imageId`);
    bool(q.verified, `question ${q.id} verified`);
    qById.set(q.id, q);
  }

  if (!isObj(pack.coverage)) fail("pack.coverage must be an object");
  str(pack.coverage.note, "pack.coverage.note");
  arr(pack.coverage.pages, "pack.coverage.pages");
  for (const p of pack.coverage.pages) {
    num(p.page, "coverage page");
    if (p.status !== "verified" && p.status !== "pending") fail("coverage status must be verified or pending");
    str(p.note, "coverage note");
  }

  return { catIds, lessonIds, qById };
}

// Lightweight re-check of a pack already stored locally, used once at boot
// before the app may claim it is ready. Full hashing of every asset is part
// of this validation; it runs at boot only, never per render.
export async function validateStoredPack(pack) {
  const out = await validatePackage({ format: FORMAT, schema: SCHEMA, kind: "content", pack });
  return out.pack;
}

export async function readPackage(file) {
  const size = typeof file.size === "number" ? file.size : 0;
  if (size > MAX_FILE_BYTES) fail(`file size ${size} exceeds ${MAX_FILE_BYTES}`);
  const text = await file.text();
  if (text.length > MAX_FILE_BYTES) fail(`file text length exceeds ${MAX_FILE_BYTES}`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("file is not valid JSON");
  }
  return validatePackage(value);
}

export function serializeBackup(snapshot) {
  return JSON.stringify({
    format: FORMAT,
    schema: SCHEMA,
    kind: "backup",
    pack: snapshot.pack,
    records: {
      attempts: snapshot.attempts,
      segments: snapshot.segments,
      sessions: snapshot.sessions,
      settings: snapshot.settings,
    },
  });
}
