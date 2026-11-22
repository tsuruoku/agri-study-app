// Loopback-only preview server for the built shell. Serves only allowlisted
// files inside dist/ on 127.0.0.1:4173 — never the project root or any other
// directory. No directory listing, no path traversal.
//
// Usage: node scripts/serve.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_FILES } from "./build-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const HOST = "127.0.0.1";
const PORT = 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
};

function mimeFor(path) {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? MIME[path.slice(dot)] || "application/octet-stream" : "application/octet-stream";
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const rel = normalize(pathname).replace(/^([/\\])+/, "");
    // Allowlist only — everything else is a 404, including traversal attempts.
    if (!SHELL_FILES.includes(rel)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const file = join(DIST, rel);
    if (!file.startsWith(DIST)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": mimeFor(rel),
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`serving dist/ at http://${HOST}:${PORT}/`);
});
