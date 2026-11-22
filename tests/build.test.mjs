import { test } from "node:test";
import assert from "node:assert/strict";
import { SHELL_FILES, planBuild, checkDistContents, stampSwVersion } from "../scripts/build-plan.mjs";

test("planBuild copies exactly the allowlist", () => {
  const plan = planBuild({ sources: new Set(SHELL_FILES), existingDist: [] });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual([...plan.copy].sort(), [...SHELL_FILES].sort());
});

test("planBuild fails when an allowlisted source is missing", () => {
  const missing = SHELL_FILES[0];
  const plan = planBuild({ sources: new Set(SHELL_FILES.filter(f => f !== missing)), existingDist: [] });
  assert.ok(plan.errors.some(e => e.includes(missing)));
});

test("planBuild fails on unexpected preexisting dist entries", () => {
  const plan = planBuild({ sources: new Set(SHELL_FILES), existingDist: ["secret.pdf", "subdir/x.txt"] });
  assert.ok(plan.errors.some(e => e.includes("secret.pdf")));
  assert.ok(plan.errors.some(e => e.includes("subdir/x.txt")));
});

test("allowlisted preexisting dist entries are fine to overwrite", () => {
  const plan = planBuild({ sources: new Set(SHELL_FILES), existingDist: [...SHELL_FILES] });
  assert.deepEqual(plan.errors, []);
});

test("checkDistContents flags private content markers", () => {
  assert.equal(checkDistContents(new Map([["app.js", "ordinary app code"]])).length, 0);
  const bad = checkDistContents(new Map([
    ["app.js", "スキャン_トマトからナス"],
    ["x.js", "private-content/secret"],
  ]));
  assert.ok(bad.length >= 1);
});

test("shell allowlist contains the required app files and no tests or private paths", () => {
  for (const f of ["index.html", "app.js", "core.js", "storage.js", "package.js", "timer.js", "sw.js", "style.css", "manifest.webmanifest"]) {
    assert.ok(SHELL_FILES.includes(f), `missing ${f}`);
  }
  assert.ok(!SHELL_FILES.some(f => f.includes("test") || f.includes("private") || f.endsWith(".pdf")));
});

test("sw VERSION is stamped from shell content hash", async () => {
  const files = new Map([["app.js", "a"], ["sw.js", 'const VERSION = "dev";\n']]);
  const v = await stampSwVersion(files);
  assert.match(v, /^[0-9a-f]{12}$/);
  assert.ok(files.get("sw.js").includes(`const VERSION = "${v}";`));
});

test("version changes when a shell file changes; identical rebuild is stable", async () => {
  const mk = app => new Map([["app.js", app], ["sw.js", 'const VERSION = "dev";']]);
  const a1 = await stampSwVersion(mk("A"));
  const a2 = await stampSwVersion(mk("A"));
  const b = await stampSwVersion(mk("B"));
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test("missing or duplicated VERSION line fails stamping", async () => {
  await assert.rejects(
    stampSwVersion(new Map([["app.js", "a"], ["sw.js", "no version line"]])),
    /exactly one/);
  await assert.rejects(
    stampSwVersion(new Map([["app.js", "a"], ["sw.js", 'const VERSION = "a";\nconst VERSION = "b";']])),
    /exactly one/);
});
