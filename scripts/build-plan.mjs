// Pure, dependency-free build planning for the shell distribution.
// The allowlist is the only thing that may ever reach dist/; anything else —
// source scans, textbook packages, tests, backups — must never ship.

export const SHELL_FILES = [
  "index.html",
  "app.js",
  "dom.js",
  "core.js",
  "storage.js",
  "package.js",
  "timer.js",
  "sw.js",
  "style.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// Strings that must never appear in shipped shell files. Guards against
// accidentally embedding private textbook/source paths in the build.
// (The .agristudy extension and generic 教材/p. labels are product UI text,
// not private content, so they are deliberately not markers.)
const PRIVATE_MARKERS = ["スキャン", "private-content/", "スキャン_トマトからナス"];

export function planBuild({ sources, existingDist }) {
  const errors = [];
  const copy = [];
  for (const name of SHELL_FILES) {
    if (!sources.has(name)) errors.push(`missing required shell file: ${name}`);
    else copy.push(name);
  }
  for (const name of existingDist) {
    if (!SHELL_FILES.includes(name)) errors.push(`unexpected preexisting dist entry: ${name}`);
  }
  return { copy, errors };
}

// The SW cache is immutable per VERSION, so VERSION must change whenever any
// shipped shell file does. The build stamps dist/sw.js's `const VERSION =`
// line with the first 12 hex chars of a SHA-256 over (sorted path + bytes of)
// every shipped file except sw.js itself — identical sources always produce
// the same version, any shell change produces a new one.
const VERSION_LINE = /^const VERSION = "[^"]*";$/m;

export async function stampSwVersion(files) {
  const swRaw = files.get("sw.js");
  const sw = Buffer.isBuffer(swRaw) ? swRaw.toString("utf8") : swRaw;
  if (typeof sw !== "string") throw new Error("sw.js contents missing for version stamping");
  const matches = sw.match(/^const VERSION = "[^"]*";$/gm) ?? [];
  if (matches.length !== 1)
    throw new Error(`sw.js must contain exactly one 'const VERSION = "...";' line, found ${matches.length}`);
  const chunks = [];
  for (const name of [...files.keys()].filter(n => n !== "sw.js").sort()) {
    const v = files.get(name);
    chunks.push(Buffer.from(`${name}\0`), Buffer.isBuffer(v) ? v : Buffer.from(String(v)), Buffer.from("\0"));
  }
  const digest = await crypto.subtle.digest("SHA-256", Buffer.concat(chunks));
  const version = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  files.set("sw.js", sw.replace(VERSION_LINE, `const VERSION = "${version}";`));
  return version;
}

// Returns the list of files whose contents carry private markers.
export function checkDistContents(files) {
  const bad = [];
  for (const [name, text] of files) {
    const s = typeof text === "string" ? text : text.toString("utf8");
    for (const marker of PRIVATE_MARKERS) {
      if (s.includes(marker)) {
        bad.push(`${name} contains private marker: ${marker}`);
        break;
      }
    }
  }
  return bad;
}
