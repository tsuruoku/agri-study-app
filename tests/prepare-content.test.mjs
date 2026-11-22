import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG_B64 } from "./fixture.mjs";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { validatePackage } from "../web/package.js";

const run = promisify(execFile);
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "prepare-content.mjs");
const NODE = process.execPath;

// Minimal PNG encoder (zlib builtin) + BMP pixel reader for crop assertions.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function pngEncode(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
// Decode an image via `sips -s format bmp`, return mean pixel luminance.
async function meanLuminance(imgPath, tmp) {
  const bmpPath = path.join(tmp, "px.bmp");
  await run("sips", ["-s", "format", "bmp", imgPath, "--out", bmpPath]);
  const b = await readFile(bmpPath);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = Math.abs(b.readInt32LE(22));
  const stride = Math.ceil((w * 3) / 4) * 4;
  let sum = 0, n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = off + y * stride + x * 3;
      sum += (b[o] + b[o + 1] + b[o + 2]) / 3;
      n++;
    }
  return sum / n;
}

async function setup({ verified = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "prep-"));
  await mkdir(path.join(base, "source"), { recursive: true });
  await mkdir(path.join(base, "pages"), { recursive: true });
  const png = Buffer.from(PNG_B64, "base64");
  await writeFile(path.join(base, "pages", "p1.png"), png);
  await writeFile(path.join(base, "pages", "p2.png"), png);
  const content = {
    version: "1",
    title: "テスト用教材パック",
    categories: [{ id: "cat-a", title: "テスト野菜" }],
    lessons: [{
      id: "les-1", categoryId: "cat-a", title: "テスト節", page: 105,
      blocks: [
        { type: "text", text: "テスト本文。", draftNote: "節内のメモ" },
        { type: "image", crop: { file: "p1.png", x: 0, y: 0, w: 1, h: 1 }, alt: "テスト図" },
      ],
      sourceAssetIds: ["p1.png"],
      draftNote: "節のメモ",
    }],
    questions: [{
      id: "q-1", revision: 1, categoryId: "cat-a", lessonId: "les-1",
      kind: "original", prompt: "テスト設問",
      options: [1, 2, 3, 4, 5].map(n => ({ text: `選択肢${n}` })),
      correctId: "o2", explanation: "テスト解説", page: 105,
      image: { file: "p2.png", x: 0, y: 0, w: 1, h: 1 },
      draftNote: "設問のメモ",
    }],
    coverage: { pages: [{ page: 105, status: "pending", note: "テスト" }] },
  };
  await writeFile(path.join(base, "source", "content.json"), JSON.stringify(content));
  if (verified) {
    await writeFile(path.join(base, "source", "verified.json"),
      JSON.stringify({ ids: ["les-1", "q-1"], pages: [105] }));
  }
  return base;
}

async function build(base) {
  return run(NODE, [SCRIPT, `--base=${base}`], { cwd: path.dirname(SCRIPT) });
}

test("prepare-content builds a valid package and strips draftNote", async () => {
  const base = await setup();
  await build(base);
  const pkg = JSON.parse(await readFile(path.join(base, "out", "agri-tomato-nasu.agristudy"), "utf8"));
  await validatePackage(pkg);
  assert.equal(JSON.stringify(pkg).includes("draftNote"), false);
  assert.equal(JSON.stringify(pkg).includes("テスト本文"), true);
  assert.equal(pkg.pack.lessons[0].verified, false);
  assert.equal(pkg.pack.questions[0].verified, false);
  assert.equal(pkg.pack.coverage.pages[0].status, "pending");
  assert.ok(pkg.pack.assets.length >= 3, "page + 2 crops");
  assert.ok(existsSync(path.join(base, "out", "crops", "crop-01.jpg")));
  assert.ok(existsSync(path.join(base, "out", "review.md")));
  const review = await readFile(path.join(base, "out", "review.md"), "utf8");
  assert.ok(review.includes("節のメモ") && review.includes("設問のメモ"));
});

test("verified.json is applied to ids and pages", async () => {
  const base = await setup({ verified: true });
  await build(base);
  const pkg = JSON.parse(await readFile(path.join(base, "out", "agri-tomato-nasu.agristudy"), "utf8"));
  await validatePackage(pkg);
  assert.equal(pkg.pack.lessons[0].verified, true);
  assert.equal(pkg.pack.questions[0].verified, true);
  assert.equal(pkg.pack.coverage.pages[0].status, "verified");
});

test("crop offset is top-left (y,x): off-center rect crops the rect, not elsewhere", async () => {
  const base = await setup();
  // 400x300 white image with a solid black 50x40 rect at x=300,y=20 (off-center).
  const W = 400, H = 300, RX = 300, RY = 20, RW = 50, RH = 40;
  const px = Buffer.alloc(W * H * 3, 255);
  for (let y = RY; y < RY + RH; y++)
    for (let x = RX; x < RX + RW; x++)
      px.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3);
  await writeFile(path.join(base, "pages", "p1.png"), pngEncode(W, H, px));
  const content = JSON.parse(await readFile(path.join(base, "source", "content.json"), "utf8"));
  content.lessons[0].blocks = [
    { type: "image", crop: { file: "p1.png", x: RX, y: RY, w: RW, h: RH }, alt: "rect" },
  ];
  delete content.questions[0].image;
  await writeFile(path.join(base, "source", "content.json"), JSON.stringify(content));
  await build(base);
  const mean = await meanLuminance(path.join(base, "out", "crops", "crop-01.jpg"), path.join(base, "out"));
  assert.ok(mean < 80, `crop should be predominantly dark (black rect), got mean ${mean.toFixed(1)}`);
});

test("out/crops is cleared before writing (no stale crops)", async () => {
  const base = await setup();
  const content = JSON.parse(await readFile(path.join(base, "source", "content.json"), "utf8"));
  delete content.questions[0].image;
  await writeFile(path.join(base, "source", "content.json"), JSON.stringify(content));
  await mkdir(path.join(base, "out", "crops"), { recursive: true });
  await writeFile(path.join(base, "out", "crops", "stale-99.jpg"), "stale");
  await build(base);
  assert.equal(existsSync(path.join(base, "out", "crops", "stale-99.jpg")), false);
  assert.equal(existsSync(path.join(base, "out", "crops", "crop-01.jpg")), true);
});

test("missing page image fails nonzero", async () => {
  const base = await setup();
  const content = JSON.parse(await readFile(path.join(base, "source", "content.json"), "utf8"));
  content.lessons[0].sourceAssetIds = ["nope.png"];
  await writeFile(path.join(base, "source", "content.json"), JSON.stringify(content));
  await assert.rejects(build(base));
});
