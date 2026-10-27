// Specs for choosing each card's oldest printing (tools/scryfall.mjs).
//
// A fake Scryfall replaces the network, so these run offline. They pin down which request picks the art: one
// search per card, printings sorted oldest first, promos and other oddities filtered out.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_VERSION, OLDEST_FILTERS, scryfallImages } from "../tools/scryfall.mjs";
import { card, fakeScryfall, twoFaced } from "./fake-scryfall.mjs";

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

/** A fresh cache file path, and a runner that looks names up through the given fake. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "scryfall-spec-"));
  dirs.push(dir);
  const cachePath = join(dir, "cache.json");
  return { cachePath, run: (fake, names) => scryfallImages(names, { get: fake.get ?? fake, cachePath, log: () => {} }) };
}
const qOf = url => new URL(url).searchParams;

describe("oldest printing", () => {
  it("uses the oldest printing, not Scryfall's default", async () => {
    const fake = fakeScryfall([card("Bolt", "O1", "default-newest.jpg")],
      { O1: [card("Bolt", "O1", "1993.jpg"), card("Bolt", "O1", "2020.jpg")] });
    assert.deepEqual(await setup().run(fake, ["Bolt"]), { Bolt: "1993.jpg" });
  });

  it("asks for printings sorted oldest first, without promos or oddities", async () => {
    const fake = fakeScryfall([card("Bolt", "O1", "d.jpg")], { O1: [card("Bolt", "O1", "old.jpg")] });
    await setup().run(fake, ["Bolt"]);
    const q = qOf(fake.searchesMade()[0]);
    assert.deepEqual([q.get("unique"), q.get("order"), q.get("dir")], ["prints", "released", "asc"]);
    for (const part of ["oracleid:O1", "-is:promo", "-border:gold", "-set_type:memorabilia", "-is:oversized", "lang:en", "-set:lea", "-set:leb"]) {
      assert.ok(q.get("q").includes(part), part);
    }
  });

  it("skips a promo that predates the first set", async () => {
    const promo = { ...card("Push", "O2", "promo-fnm.jpg"), promo: true };
    const fake = fakeScryfall([card("Push", "O2", "d.jpg")], { O2: [promo, card("Push", "O2", "first-set.jpg")] });
    assert.deepEqual(await setup().run(fake, ["Push"]), { Push: "first-set.jpg" });
  });

  it("retries without the filters when they exclude every printing", async () => {
    const onlyPromo = { ...card("Rare", "O3", "promo-only.jpg"), promo: true };
    const fake = fakeScryfall([card("Rare", "O3", "d.jpg")], { O3: [onlyPromo] });
    assert.deepEqual(await setup().run(fake, ["Rare"]), { Rare: "promo-only.jpg" });
    assert.equal(fake.searchesMade().length, 2);
  });

  it("falls back to the default printing when no search works", async () => {
    const fake = fakeScryfall([card("Odd", "O4", "default.jpg")], {});
    assert.deepEqual(await setup().run(fake, ["Odd"]), { Odd: "default.jpg" });
  });

  it("shows a card first printed in Alpha as its Unlimited printing", async () => {
    const prints = ["lea", "leb", "2ed", "m10"].map(code => ({ ...card("Tutor", "OT", `${code}.jpg`), set: code }));
    const fake = fakeScryfall([card("Tutor", "OT", "default.jpg")], { OT: prints });
    assert.deepEqual(await setup().run(fake, ["Tutor"]), { Tutor: "2ed.jpg" });
  });

  it("still gives a card printed only in Alpha or Beta an image", async () => {
    const prints = [{ ...card("Ante", "OA", "lea.jpg"), set: "lea" }, { ...card("Ante", "OA", "leb.jpg"), set: "leb" }];
    const fake = fakeScryfall([card("Ante", "OA", "default.jpg")], { OA: prints });
    assert.deepEqual(await setup().run(fake, ["Ante"]), { Ante: "lea.jpg" });
  });

  it("discards a cache built under a different rule", async () => {
    const s = setup();
    writeFileSync(s.cachePath, JSON.stringify({ _v: CACHE_VERSION, filters: "lang:en", images: { Bolt: "alpha.jpg" } }));
    const fake = fakeScryfall([card("Bolt", "O1", "d.jpg")], { O1: [{ ...card("Bolt", "O1", "2ed.jpg"), set: "2ed" }] });
    assert.deepEqual(await s.run(fake, ["Bolt"]), { Bolt: "2ed.jpg" });
  });

  it("uses the front face of double-faced cards", async () => {
    const fake = fakeScryfall([twoFaced("Jace // Jace2", "O5", "d-front.jpg")], { O5: [twoFaced("Jace // Jace2", "O5", "old-front.jpg")] });
    assert.deepEqual(await setup().run(fake, ["Jace"]), { Jace: "old-front.jpg" });
  });

  it("finds Arena names without accents by fuzzy match", async () => {
    const accented = card("Troll of Khazad-dûm", "O6", "d.jpg");
    const fake = fakeScryfall([], { O6: [card("Troll of Khazad-dûm", "O6", "ltr.jpg")] }, { "Troll of Khazad-dum": accented });
    assert.deepEqual(await setup().run(fake, ["Troll of Khazad-dum"]), { "Troll of Khazad-dum": "ltr.jpg" });
  });

  it("skips a card Scryfall cannot find without breaking the rest", async () => {
    const fake = fakeScryfall([card("Bolt", "O1", "d.jpg")], { O1: [card("Bolt", "O1", "old.jpg")] });
    assert.deepEqual(await setup().run(fake, ["Bolt", "Nonexistent Card"]), { Bolt: "old.jpg" });
  });

  it("makes one search per card", async () => {
    const fake = fakeScryfall([card("A", "OA", "a.jpg"), card("B", "OB", "b.jpg")],
      { OA: [card("A", "OA", "a-old.jpg")], OB: [card("B", "OB", "b-old.jpg")] });
    await setup().run(fake, ["A", "B", "A"]);
    assert.equal(fake.searchesMade().length, 2);
  });

  it("caches results so a second run makes no requests", async () => {
    const s = setup();
    await s.run(fakeScryfall([card("Bolt", "O1", "d.jpg")], { O1: [card("Bolt", "O1", "old.jpg")] }), ["Bolt"]);
    const again = fakeScryfall([], {});
    assert.deepEqual(await s.run(again, ["Bolt"]), { Bolt: "old.jpg" });
    assert.deepEqual(again.calls, []);
  });

  it("discards an old-format cache of newest printings", async () => {
    const s = setup();
    writeFileSync(s.cachePath, JSON.stringify({ Bolt: "stale-newest.jpg" })); // the pre-version cache shape
    const fake = fakeScryfall([card("Bolt", "O1", "d.jpg")], { O1: [card("Bolt", "O1", "old.jpg")] });
    assert.deepEqual(await s.run(fake, ["Bolt"]), { Bolt: "old.jpg" });
    assert.equal(JSON.parse(readFileSync(s.cachePath, "utf8"))._v, CACHE_VERSION);
  });

  it("pins basic lands to the Unhinged printing", async () => {
    const alpha = { ...card("Swamp", "OS", "alpha.jpg"), set: "lea" }, unhinged = { ...card("Swamp", "OS", "unhinged.jpg"), set: "unh" };
    const fake = fakeScryfall([card("Swamp", "OS", "default.jpg")], { OS: [alpha, unhinged] });
    assert.deepEqual(await setup().run(fake, ["Swamp"]), { Swamp: "unhinged.jpg" });
    assert.ok(qOf(fake.searchesMade()[0]).get("q").includes("set:unh"));
  });

  it("does not pin other cards", async () => {
    const fake = fakeScryfall([card("Bolt", "O1", "d.jpg")], { O1: [{ ...card("Bolt", "O1", "oldest.jpg"), set: "lea" }] });
    assert.deepEqual(await setup().run(fake, ["Bolt"]), { Bolt: "oldest.jpg" });
    assert.deepEqual(fake.searchesMade().filter(c => c.includes("set%3Aunh") || c.includes("set:unh")), []);
  });

  it("falls back to a pinned card's oldest printing when the pinned set has none", async () => {
    const fake = fakeScryfall([card("Forest", "OF", "default.jpg")], { OF: [{ ...card("Forest", "OF", "alpha.jpg"), set: "lea" }] });
    assert.deepEqual(await setup().run(fake, ["Forest"]), { Forest: "alpha.jpg" });
  });

  it("looks a basic up again when it was cached before the pin existed", async () => {
    const s = setup();
    writeFileSync(s.cachePath, JSON.stringify({ _v: CACHE_VERSION, filters: OLDEST_FILTERS, images: { Swamp: "old-alpha.jpg", Bolt: "kept.jpg" } }));
    const unhinged = { ...card("Swamp", "OS", "unhinged.jpg"), set: "unh" };
    const fake = fakeScryfall([card("Swamp", "OS", "d.jpg")], { OS: [unhinged] });
    assert.deepEqual(await s.run(fake, ["Swamp", "Bolt"]), { Swamp: "unhinged.jpg", Bolt: "kept.jpg" }); // Bolt came from the cache
    const again = fakeScryfall([], {});
    assert.deepEqual(await s.run(again, ["Swamp"]), { Swamp: "unhinged.jpg" });
    assert.deepEqual(again.calls, []); // the pin is now recorded, so no repeat lookups
  });

  it("returns nothing instead of crashing when offline", async () => {
    const offline = async () => { throw new Error("network down"); };
    assert.deepEqual(await setup().run(offline, ["Bolt"]), {});
  });

  it("spaces its real requests and runs several lookups at once", async () => {
    // With a slow fake, 8 cards through a pool of 4 finish in about 2 rounds, not 8 (and never lose a result).
    const names = Array.from({ length: 8 }, (_, i) => `Card${i}`);
    const base = fakeScryfall(names.map((n, i) => card(n, `O${i}`, `d${i}.jpg`)), Object.fromEntries(names.map((n, i) => [`O${i}`, [card(n, `O${i}`, `old${i}.jpg`)]])));
    let inFlight = 0, peak = 0;
    const slow = async (url, body) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return base.get(url, body);
    };
    const got = await setup().run(slow, names);
    assert.equal(Object.keys(got).length, 8);
    assert.ok(peak > 1 && peak <= 4, `peak concurrency ${peak}`);
  });
});
