// Build a private content package (.agristudy) from draft source JSON.
// Personal-use only: never ships in dist/ and never leaves this machine.
//
// Usage: node scripts/prepare-content.mjs [--base=private-content]
//           [--source=DIR] [--pages=DIR] [--out=DIR]
// Layout inside --base: source/content.json (+ optional source/verified.json),
// pages/*.png, output to out/.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const BASE = path.resolve(argv.base ?? "private-content");
const SRC = path.resolve(argv.source ?? path.join(BASE, "source"));
const PAGES = path.resolve(argv.pages ?? path.join(BASE, "pages"));
const OUT = path.resolve(argv.out ?? path.join(BASE, "out"));
const CROPS = path.join(OUT, "crops");

function die(msg) {
  console.error(`prepare-content: ${msg}`);
  process.exit(1);
}

async function sips(args) {
  try {
    await run("sips", args);
  } catch (e) {
    die(`sips failed (${args.join(" ")}): ${e.stderr || e.message}`);
  }
}

async function sha256hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function stripNotes(v) {
  if (Array.isArray(v)) return v.map(stripNotes);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "draftNote") continue;
      out[k] = stripNotes(val);
    }
    return out;
  }
  return v;
}

function collectNotes(v, owner, acc) {
  if (v && typeof v === "object") {
    if (typeof v.draftNote === "string" && v.draftNote) acc.push({ owner, note: v.draftNote });
    for (const [k, val] of Object.entries(v)) {
      if (k !== "draftNote") collectNotes(val, owner, acc);
    }
  } else if (Array.isArray(v)) {
    v.forEach(x => collectNotes(x, owner, acc));
  }
}

// Resize a full page image -> jpeg, long edge <= 1600, q80.
async function pageAsset(file, tmp) {
  const src = path.join(PAGES, file);
  if (!existsSync(src)) die(`missing page image: ${src}`);
  const out = path.join(tmp, `page-${file.replace(/\W+/g, "_")}.jpg`);
  await sips(["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1600", src, "--out", out]);
  return readFile(out);
}

// Crop {x,y,w,h} in source pixels (top-left origin) then cap at 1200, jpeg q80.
// sips -c h w --cropOffset y x crops from the top-left offset (y, x).
async function cropImage(crop, name, tmp) {
  const src = path.join(PAGES, crop.file);
  if (!existsSync(src)) die(`missing crop source: ${src}`);
  const stage = path.join(tmp, `${name}-raw.png`);
  const out = path.join(tmp, `${name}.jpg`);
  const { x, y, w, h } = crop;
  for (const n of [x, y, w, h])
    if (!Number.isInteger(n) || n < 0) die(`bad crop geometry for ${name}`);
  const info = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", src]);
  const W = Number(info.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const H = Number(info.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!W || !H) die(`cannot read dimensions of ${src}`);
  if (x + w > W || y + h > H) die(`crop ${name} out of bounds (${x}+${w},${y}+${h} vs ${W}x${H})`);
  await sips(["-c", String(h), String(w), "--cropOffset", String(y), String(x), src, "--out", stage]);
  await sips(["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1200", stage, "--out", out]);
  return readFile(out);
}

async function main() {
  const contentPath = path.join(SRC, "content.json");
  if (!existsSync(contentPath)) die(`content source not found: ${contentPath}`);
  const src = JSON.parse(await readFile(contentPath, "utf8"));
  const verPath = path.join(SRC, "verified.json");
  let verified = { ids: [], pages: [] };
  if (existsSync(verPath)) {
    const v = JSON.parse(await readFile(verPath, "utf8"));
    verified = { ids: v.ids ?? [], pages: v.pages ?? [] };
  }
  const verIds = new Set(verified.ids);
  const verPages = new Set(verified.pages);

  await mkdir(OUT, { recursive: true });
  await rm(CROPS, { recursive: true, force: true });
  await mkdir(CROPS, { recursive: true });
  const tmp = path.join(OUT, ".tmp-prep");
  await mkdir(tmp, { recursive: true });

  const notes = [];
  const assets = [];
  const pageAssetId = file => `src-${file.replace(/\.png$/i, "")}`;
  const madePages = new Set();
  async function ensurePageAsset(file) {
    if (madePages.has(file)) return;
    const bytes = await pageAsset(file, tmp);
    assets.push({
      id: pageAssetId(file),
      mime: "image/jpeg",
      data: Buffer.from(bytes).toString("base64"),
      sha256: await sha256hex(bytes),
    });
    madePages.add(file);
  }

  let cropN = 0;
  const cropFiles = []; // {id, rel}
  const reviewCrops = new Map(); // owner id -> [{rel, alt}]
  async function makeCropAsset(crop, alt, ownerId) {
    const id = `crop-${String(++cropN).padStart(2, "0")}`;
    const bytes = await cropImage(crop, id, tmp);
    assets.push({
      id, mime: "image/jpeg",
      data: Buffer.from(bytes).toString("base64"),
      sha256: await sha256hex(bytes),
    });
    const rel = path.join("crops", `${id}.jpg`);
    await writeFile(path.join(OUT, rel), bytes);
    const entry = { id, file: crop.file, x: crop.x, y: crop.y, w: crop.w, h: crop.h, alt: alt ?? "", rel };
    cropFiles.push(entry);
    if (ownerId) {
      if (!reviewCrops.has(ownerId)) reviewCrops.set(ownerId, []);
      reviewCrops.get(ownerId).push(entry);
    }
    return id;
  }

  const lessons = [];
  for (const l of src.lessons ?? []) {
    collectNotes(l, l.id, notes);
    const blocks = [];
    for (const b of l.blocks ?? []) {
      if (b.type === "image") {
        blocks.push({ type: "image", assetId: await makeCropAsset(b.crop, b.alt, l.id), alt: b.alt ?? "" });
      } else {
        blocks.push({ type: b.type, text: b.text });
      }
    }
    const srcIds = [];
    for (const f of l.sourceAssetIds ?? []) {
      await ensurePageAsset(f);
      srcIds.push(pageAssetId(f));
    }
    lessons.push(stripNotes({
      id: l.id, categoryId: l.categoryId, title: l.title, page: l.page,
      blocks, sourceAssetIds: srcIds, verified: verIds.has(l.id),
    }));
  }

  const questions = [];
  for (const q of src.questions ?? []) {
    collectNotes(q, q.id, notes);
    const imageId = q.image ? await makeCropAsset(q.image, null, q.id) : undefined;
    questions.push(stripNotes({
      id: q.id, revision: q.revision ?? 1, categoryId: q.categoryId,
      lessonId: q.lessonId, kind: q.kind, prompt: q.prompt,
      options: q.options.map((o, i) => ({ id: o.id ?? `o${i + 1}`, text: o.text })),
      correctId: q.correctId, explanation: q.explanation, page: q.page,
      ...(imageId ? { imageId } : {}),
      verified: verIds.has(q.id),
    }));
  }

  const coverage = {
    note: src.coverage?.note ?? "105-137 ページ。下書き段階で原本照合待ち。",
    pages: (src.coverage?.pages ?? []).map(p => ({
      page: p.page,
      status: verPages.has(p.page) ? "verified" : "pending",
      note: p.note ?? "",
    })),
  };

  const pkg = {
    format: "agri-study", schema: 1, kind: "content",
    pack: {
      id: "agri-tomato-nasu",
      version: String(src.version ?? "1"),
      title: src.title ?? "野菜（トマト〜ナス）教材パック",
      categories: (src.categories ?? []).map(stripNotes),
      lessons, questions, assets, coverage,
    },
  };

  const { validatePackage } = await import(pathToFileURL(path.join(ROOT, "..", "web", "package.js")).href);
  try {
    await validatePackage(pkg);
  } catch (e) {
    die(`generated package failed validatePackage: ${e.message}`);
  }

  const file = path.join(OUT, "agri-tomato-nasu.agristudy");
  const text = JSON.stringify(pkg);
  await writeFile(file, text);

  // review.md for human verification against the scans.
  const lines = ["# 内容レビュー（下書き — 原本照合待ち）", ""];
  for (const l of src.lessons ?? []) {
    lines.push(`## lesson ${l.id} (p.${l.page}) ${l.title}`);
    for (const c of reviewCrops.get(l.id) ?? [])
      lines.push(`- crop: out/${c.rel} alt:${c.alt}`);
    const lNotes = notes.filter(n => n.owner === l.id);
    for (const n of lNotes) lines.push(`- draftNote: ${n.note}`);
    lines.push("");
  }
  for (const q of src.questions ?? []) {
    lines.push(`## ${q.kind} ${q.id} (p.${q.page})`);
    for (const c of reviewCrops.get(q.id) ?? [])
      lines.push(`- crop: out/${c.rel}`);
    lines.push(`- 問題: ${q.prompt}`);
    q.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.text}`));
    const idx = q.options.findIndex(o => o.id === q.correctId);
    lines.push(`- 正解: ${idx + 1}`);
    lines.push(`- 解説: ${q.explanation}`);
    for (const n of notes.filter(n => n.owner === q.id)) lines.push(`- draftNote: ${n.note}`);
    lines.push("");
  }
  await writeFile(path.join(OUT, "review.md"), lines.join("\n"));

  const ex = questions.filter(q => q.kind === "example").length;
  const orig = questions.filter(q => q.kind === "original").length;
  const ver = lessons.filter(l => l.verified).length + questions.filter(q => q.verified).length;
  const pending = coverage.pages.filter(p => p.status === "pending").length;
  console.log(`lessons: ${lessons.length}`);
  console.log(`examples: ${ex}`);
  console.log(`originals: ${orig}`);
  console.log(`verified: ${ver}`);
  console.log(`pending pages: ${pending}`);
  console.log(`package bytes: ${Buffer.byteLength(text)}`);
  console.log(`wrote ${file}`);
  console.log(`wrote ${path.join(OUT, "review.md")} + ${cropFiles.length} crops`);
}

main().catch(e => die(e.stack || e.message));
