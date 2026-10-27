// Spec for the local preview server (tools/serve.mjs): it must never let a browser cache what it serves.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeServer } from "../tools/serve.mjs";

const tmp = mkdtempSync(join(tmpdir(), "serve-spec-"));
const site = join(tmp, "site");
mkdirSync(join(site, "sub"), { recursive: true });
writeFileSync(join(site, "a.js"), "console.log(1)");
writeFileSync(join(site, "style.css"), "body{}");
writeFileSync(join(site, "sub", "index.html"), "<p>sub</p>");
writeFileSync(join(tmp, "outside.txt"), "secret"); // next to the served folder, not in it

let server, base, port;
before(async () => {
  server = makeServer(site);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

/** A raw request, so the path is sent exactly as given (fetch would tidy ".." away). */
const raw = (path, method = "GET") => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method }, res => {
    let body = "";
    res.on("data", c => (body += c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on("error", reject);
  req.end();
});

describe("preview server", () => {
  it("serves files and tells browsers never to cache them", async () => {
    const r = await fetch(base + "/a.js");
    assert.equal(await r.text(), "console.log(1)");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("content-type"), /javascript/);
  });

  it("shows edits on the next request", async () => {
    assert.equal(await (await fetch(base + "/a.js")).text(), "console.log(1)");
    writeFileSync(join(site, "a.js"), "console.log(2)");
    assert.equal(await (await fetch(base + "/a.js")).text(), "console.log(2)");
  });

  it("makes errors uncacheable too", async () => {
    const r = await fetch(base + "/missing.js");
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  it("sends the right content types", async () => {
    assert.match((await fetch(base + "/style.css")).headers.get("content-type"), /text\/css/);
  });

  it("redirects a folder to its trailing slash and serves its index page", async () => {
    const r = await fetch(base + "/sub", { redirect: "manual" });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/sub/");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(await (await fetch(base + "/sub/")).text(), "<p>sub</p>");
  });

  it("answers HEAD with the headers and no body", async () => {
    const r = await raw("/a.js", "HEAD");
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.body, "");
  });

  it("never serves a file outside the folder", async () => {
    for (const path of ["/..%2foutside.txt", "/%2e%2e/outside.txt", "/sub/..%2f..%2foutside.txt"]) {
      const r = await raw(path);
      assert.equal(r.status, 404, path);
      assert.ok(!r.body.includes("secret"), path);
    }
  });

  it("refuses methods other than GET and HEAD", async () => {
    assert.equal((await raw("/a.js", "POST")).status, 405);
  });
});
