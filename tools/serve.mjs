#!/usr/bin/env node
// Local preview server: a small static server that sends `Cache-Control: no-store`.
//
// A plain static server sends no cache headers, so Safari (and others) can keep showing an old script or
// stylesheet after you edit it. With no-store a normal reload always shows your latest edits.
//
// Usage: npm run serve [-- port]    # serves the repo root at http://127.0.0.1:<port>/ (default 8000)
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

export function makeServer(dir = ROOT) {
  const root = resolve(dir);
  return createServer((req, res) => {
    const send = (status, headers = {}, body = "") => {
      res.writeHead(status, { "Cache-Control": "no-store", ...headers });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, { Allow: "GET, HEAD" }, "Method not allowed");

    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(400, {}, "Bad request"); }
    const file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) return send(404, {}, "Not found"); // never serve outside the root

    let stat;
    try { stat = statSync(file); } catch { return send(404, { "Content-Type": "text/plain" }, "File not found"); }
    if (stat.isDirectory()) {
      if (!pathname.endsWith("/")) return send(301, { Location: pathname + "/" });
      const index = join(file, "index.html");
      try { statSync(index); } catch { return send(404, { "Content-Type": "text/plain" }, "File not found"); }
      return serveFile(index);
    }
    return serveFile(file);

    function serveFile(path) {
      const size = statSync(path).size;
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Content-Length": size });
      if (req.method === "HEAD") return res.end();
      createReadStream(path).pipe(res);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.argv[2]) || 8000;
  makeServer().listen(port, "127.0.0.1", () => console.log(`serving ${ROOT} at http://127.0.0.1:${port}/ (no caching)`));
}
