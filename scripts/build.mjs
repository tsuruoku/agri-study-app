// Build the deployable shell: copy exactly the allowlisted web/ files into
// dist/. Never traverses the project root; fails on missing sources or
// unexpected preexisting dist entries rather than deleting anything.
//
// Usage: node scripts/build.mjs

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_FILES, planBuild, checkDistContents, stampSwVersion } from "./build-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");
const DIST = join(ROOT, "dist");

async function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else if (e.isFile()) out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

export async function build() {
  const sources = new Set(await listFiles(WEB));
  const existingDist = await listFiles(DIST);
  const plan = planBuild({ sources, existingDist });
  if (plan.errors.length) {
    for (const e of plan.errors) console.error(`build error: ${e}`);
    process.exitCode = 1;
    return;
  }
  const contents = new Map();
  for (const name of plan.copy) {
    contents.set(name, await readFile(join(WEB, name)));
  }
  let swVersion;
  try {
    swVersion = await stampSwVersion(contents);
  } catch (e) {
    console.error(`build error: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const leaks = checkDistContents(contents);
  if (leaks.length) {
    for (const e of leaks) console.error(`build error: ${e}`);
    process.exitCode = 1;
    return;
  }
  for (const [name, text] of contents) {
    const target = join(DIST, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
    console.log(`dist/${name}`);
  }
  console.log(`built ${contents.size} shell files into dist/ (sw VERSION=${swVersion})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  await build();
}
