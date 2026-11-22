// Test-only fixture builder. All content is artificial — it is NOT textbook
// material and must never be shipped in dist/ or a real package.

// 1x1 transparent PNG.
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function question(id, over = {}) {
  return {
    id,
    revision: 1,
    categoryId: "cat-a",
    lessonId: "les-a1",
    kind: "original",
    prompt: `テスト用の設問です（${id}）。教材の内容ではありません。`,
    options: [1, 2, 3, 4, 5].map(n => ({ id: `o${n}`, text: `選択肢${n}` })),
    correctId: "o3",
    explanation: "テスト用の解説文です。",
    page: 105,
    verified: true,
    ...over,
  };
}

export async function makePack(over = {}) {
  const img = b64ToBytes(PNG_B64);
  const pack = {
    id: "fixture-pack",
    version: "1",
    title: "テスト用教材パック（仮の内容）",
    categories: [
      { id: "cat-a", title: "テスト野菜A" },
      { id: "cat-b", title: "テスト野菜B" },
    ],
    lessons: [
      {
        id: "les-a1",
        categoryId: "cat-a",
        title: "テスト節A1",
        page: 105,
        blocks: [
          { type: "text", text: "テスト用の解説文です。教材の内容ではありません。" },
          { type: "image", assetId: "ast-1", alt: "テスト用図版" },
        ],
        sourceAssetIds: ["ast-2"],
        verified: true,
      },
      {
        id: "les-a2",
        categoryId: "cat-a",
        title: "テスト節A2",
        page: 107,
        blocks: [{ type: "text", text: "二つ目のテスト節。" }],
        verified: true,
      },
      {
        id: "les-b1",
        categoryId: "cat-b",
        title: "テスト節B1（未整備）",
        page: 130,
        blocks: [{ type: "text", text: "まだ照合していないテスト節。" }],
        verified: false,
      },
    ],
    questions: [
      question("q1", { lessonId: "les-a1" }),
      question("q2", { lessonId: "les-a1", kind: "example" }),
      question("q3", { lessonId: "les-a2" }),
      question("q4", { lessonId: "les-a2", imageId: "ast-1" }),
      question("q5", { lessonId: "les-a1" }),
      question("q6", { lessonId: "les-b1", categoryId: "cat-b" }),
      question("q7", { lessonId: "les-b1", categoryId: "cat-b", verified: false }),
    ],
    assets: [
      { id: "ast-1", mime: "image/png", data: PNG_B64, sha256: await sha256hex(img) },
      { id: "ast-2", mime: "image/png", data: PNG_B64, sha256: await sha256hex(img) },
    ],
    coverage: {
      pages: [
        { page: 105, status: "verified", note: "" },
        { page: 106, status: "pending", note: "照合中のテストページ" },
      ],
      note: "テスト用の対応表です。",
    },
    ...over,
  };
  return pack;
}

export async function makePackage(over = {}) {
  return { format: "agri-study", schema: 1, kind: "content", pack: await makePack(), ...over };
}

export function attempt(over = {}) {
  return {
    id: `att-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "ses-1",
    instanceId: `inst-${Math.random().toString(36).slice(2, 10)}`,
    questionId: "q1",
    revision: 1,
    optionId: "o3",
    correct: true,
    at: 1700000000000,
    ...over,
  };
}

export function session(over = {}) {
  return {
    id: "ses-1",
    questions: [{ id: "q1", revision: 1 }],
    index: 0,
    answers: [],
    finished: false,
    ...over,
  };
}

export function segment(over = {}) {
  return {
    id: `seg-${Math.random().toString(36).slice(2, 10)}`,
    start: 1700000000000,
    end: 1700000002000,
    seconds: 2,
    date: "2023-11-14",
    zone: "Asia/Tokyo",
    mode: "lesson",
    ...over,
  };
}
