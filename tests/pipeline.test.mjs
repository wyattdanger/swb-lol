// Specs for the log -> data pipeline (tools/draft-replay.mjs and tools/games.mjs).
//
// Run with tests/run.sh. They use a synthetic log (tests/fixture.mjs), so they need no Arena install,
// network, or personal data.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { makeNamer, parseGames } from "../tools/games.mjs";
import { refreshImages } from "../tools/draft-replay.mjs";
import { imageMap } from "../tools/scryfall.mjs";
import { CARDS, EVENT, ME_NAME, OPP_NAME, buildFixture } from "./fixture.mjs";
import { fakeScryfall, card } from "./fake-scryfall.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "tools", "draft-replay.mjs");
const NODE_FLAGS = ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"];

const tmp = mkdtempSync(join(tmpdir(), "pipeline-spec-"));
const { log, db } = buildFixture(tmp);
process.env.ARENA_CARD_DB = db; // for in-process calls into games.mjs (child processes inherit it too)
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Run the generator CLI on the fixture log; returns { stdout, stderr }. Throws if it exits non-zero. */
function cli(...args) {
  const r = spawnSync(process.execPath, [...NODE_FLAGS, SCRIPT, ...args, log], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const data = (draft = "D1") => JSON.parse(cli("--json", "--no-images", "--draft-id", draft).stdout);

describe("draft parsing", () => {
  it("lists each pack seen with the card picked", () => {
    const got = data().picks.map(p => [p.pack, p.pick, p.picked, p.cards.length]);
    assert.deepEqual(got, [[1, 1, "Alpha Land", 4], [1, 2, "Beta Bear", 3], [1, 3, "Gamma Bolt", 2],
      [2, 1, "Eta Charm", 3], [2, 2, "Epsilon Land", 2]]);
  });

  it("does not duplicate picks when Arena logs each notify twice", () => {
    assert.equal(data().picks.length, 5);
  });

  it("defaults to the latest draft and lists the others", () => {
    const r = cli("--json", "--no-images");
    assert.equal(JSON.parse(r.stdout).draftId, "D2");
    assert.match(r.stderr, /2 drafts found/);
  });

  it("captures the submitted deck", () => {
    const deck = data().deck;
    assert.equal(deck.main.reduce((n, c) => n + c.qty, 0), 5);
    assert.deepEqual(deck.side.map(c => c.name), ["Eta Charm"]);
  });

  it("has no deck key for a draft that never submitted one", () => {
    assert.ok(!("deck" in data("D2")));
  });

  it("reads card metadata from the card database", () => {
    const bear = data().picks[0].cards.find(c => c.name === "Beta Bear");
    assert.deepEqual([bear.colors, bear.types, bear.cost], ["G", ["Creature"], "{1}{G}"]);
  });

  it("prints a plain-text replay that marks the pick", () => {
    const out = cli("--draft-id", "D1").stdout;
    assert.match(out, /PACK 1/);
    assert.match(out, /->\s+Alpha Land/);
  });
});

describe("game narration", async () => {
  const matches = await parseGames([log], EVENT);
  const [g1, g2] = matches[0].games;

  it("only reports matches for the requested event", async () => {
    assert.equal(matches.length, 1);
    assert.deepEqual(await parseGames([log], "SomeOtherEvent"), []);
    assert.deepEqual([matches[0].match, matches[0].result], [1, "won"]);
  });

  it("still yields the first game state when ConnectResp shares its log line (regression)", () => {
    // ConnectResp shares a log line with the game's first state. Skipping the whole line once cost a game
    // its opening hand, mulligan count and on-the-play info.
    assert.equal(g1.onPlay, "You");
    assert.equal(g1.mulligans, 1);
    assert.equal(g1.opening.length, 3);
  });

  it("shows the kept hand, not the dealt one, as the opening hand", () => {
    assert.deepEqual(g1.opening, ["Alpha Land", "Beta Bear", "Gamma Bolt"]); // Delta Sorcery was bottomed
  });

  it("does not narrate mulligan bottoming", () => {
    const events = g1.turns.flatMap(t => t.events);
    assert.deepEqual(events.filter(e => e.includes("library")), []);
  });

  it("narrates turn by turn", () => {
    assert.deepEqual(g1.turns.map(t => [t.turn, t.who]), [[1, "You"], [2, "Opp"], [3, "You"]]);
    assert.deepEqual(g1.turns[0].events, ["You play {{Alpha Land}}", "You cast {{Beta Bear}}"]);
    assert.deepEqual(g1.turns[1].events, ["Opp plays {{Epsilon Land}}"]);
    assert.deepEqual(g1.turns[2].events, ["{{Beta Bear}} deals 2 damage to Opp", "Opp loses 2 life (20 → 18)", "You attack with {{Beta Bear}}"]);
  });

  it("records each turn's life totals at its end", () => {
    assert.deepEqual(g1.turns.map(t => t.life), [{ You: 20, Opp: 20 }, { You: 20, Opp: 20 }, { You: 20, Opp: 18 }]);
  });

  it("omits 'resolves' lines", () => {
    const events = matches.flatMap(m => m.games).flatMap(g => g.turns).flatMap(t => t.events);
    assert.deepEqual(events.filter(e => e.endsWith("resolves")), []);
  });

  it("reports each game's result", () => {
    assert.deepEqual(g1.result, { winner: "You", reason: "Game" });
    assert.deepEqual(g2.result, { winner: "You", reason: "Concede" });
  });

  it("has Opp on the play and a kept hand in game two", () => {
    assert.deepEqual([g2.onPlay, g2.mulligans, g2.opening], ["Opp", 0, ["Alpha Land"]]);
  });

  it("has no sideboarding for game one", () => {
    assert.equal(g1.sideboard, null);
  });

  it("diffs sideboarding against the deck registered after the room opens (regression)", () => {
    // ConnectResp (the match's starting deck) is logged after the room-open event, so the match used to start
    // with no deck and the diff silently vanished.
    assert.deepEqual(g2.sideboard, { in: [{ n: "Eta Charm", q: 1 }], out: [{ n: "Delta Sorcery", q: 1 }] });
  });

  it("lists the opponent's cards seen", () => {
    assert.deepEqual(g1.opponentCards, ["Epsilon Land"]);
  });

  it("never puts a username in any output", () => {
    const blob = JSON.stringify(matches) + cli("--json", "--no-images", "--draft-id", "D1").stdout;
    assert.ok(!blob.includes(ME_NAME));
    assert.ok(!blob.includes(OPP_NAME));
  });
});

describe("card names", () => {
  it("keep resolving after garbage collection (a collected database handle finalizes its statements)", { skip: typeof globalThis.gc !== "function" && "run with --expose-gc (tests/run.sh does)" }, async () => {
    // The first JavaScript version let the database handle go out of scope; on a big real log the collector
    // closed it mid-parse and every lookup threw "statement has been finalized". The tiny fixture never showed it.
    const namer = makeNamer();
    for (let i = 0; i < 3; i++) { globalThis.gc(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(namer.name(1), "Alpha Land");
    assert.equal(namer.name(2), "Beta Bear");
    namer.close();
  });
});

describe("landing page", () => {
  it("has an icon link so there is no favicon 404", () => {
    assert.match(readFileSync(join(ROOT, "index.html"), "utf8"), /rel="icon"/);
  });
});

describe("publish", () => {
  const site = () => mkdtempSync(join(tmpdir(), "site-spec-"));
  const publish = (dir, draft) => cli("--publish", dir, "--no-images", "--draft-id", draft);
  const read = (...parts) => readFileSync(join(...parts), "utf8");
  const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort();

  it("writes a data file and a shell and nothing else", () => {
    const dir = site();
    publish(dir, "D1");
    assert.deepEqual(files(dir), ["drafts/1/data.json", "drafts/1/index.html"]);
  });

  it("puts the whole draft in the data file", () => {
    const dir = site();
    publish(dir, "D1");
    const d = JSON.parse(read(dir, "drafts", "1", "data.json"));
    assert.deepEqual([d.schema, d.number, d.draftId], [1, 1, "D1"]);
    assert.deepEqual(d.picks, data().picks);
    assert.deepEqual(d.games, data().games);
    assert.deepEqual(d.deck, data().deck);
    assert.ok(!JSON.stringify(d).includes(ME_NAME) && !JSON.stringify(d).includes(OPP_NAME));
  });

  it("makes the page a small shell with no draft data in it", () => {
    const dir = site();
    publish(dir, "D1");
    const html = read(dir, "drafts", "1", "index.html");
    assert.ok(html.startsWith("<!doctype html>"), "standards mode, not quirks mode");
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /rel="icon"/); // an icon link stops the browser requesting a missing favicon.ico
    assert.ok(html.indexOf("/assets/viewer.js") < html.indexOf("/assets/boot.js"));
    assert.ok(!html.includes("Alpha Land"));
    assert.ok(html.length < 2000);
  });

  it("writes byte-identical pages for every draft, so template changes apply to all", () => {
    const dir = site();
    publish(dir, "D1");
    publish(dir, "D2");
    assert.equal(read(dir, "drafts", "1", "index.html"), read(dir, "drafts", "2", "index.html"));
  });

  it("keeps a draft's number and gives new drafts the next one", () => {
    const dir = site();
    publish(dir, "D1");
    publish(dir, "D2");
    const before = read(dir, "drafts", "1", "data.json");
    publish(dir, "D1"); // republishing keeps its number
    assert.deepEqual(readdirSync(join(dir, "drafts")).sort(), ["1", "2"]);
    assert.equal(read(dir, "drafts", "1", "data.json"), before);
    assert.equal(JSON.parse(read(dir, "drafts", "2", "data.json")).draftId, "D2");
  });

  it("numbers from existing data files, not a separate manifest", () => {
    const dir = site();
    mkdirSync(join(dir, "drafts", "7"), { recursive: true });
    writeFileSync(join(dir, "drafts", "7", "data.json"), JSON.stringify({ draftId: "someone-else" }));
    publish(dir, "D1");
    assert.ok(existsSync(join(dir, "drafts", "8", "data.json")));
  });

  it("rebuilds every shell without logs and leaves the data alone", () => {
    const dir = site();
    publish(dir, "D1");
    publish(dir, "D2");
    const dataBefore = Object.fromEntries(["1", "2"].map(n => [n, read(dir, "drafts", n, "data.json")]));
    const good = read(dir, "drafts", "1", "index.html");
    for (const n of ["1", "2"]) writeFileSync(join(dir, "drafts", n, "index.html"), "stale");
    const r = spawnSync(process.execPath, [...NODE_FLAGS, SCRIPT, "--rebuild", dir], { encoding: "utf8", env: process.env });
    assert.equal(r.status, 0, r.stderr);
    for (const n of ["1", "2"]) {
      assert.equal(read(dir, "drafts", n, "index.html"), good);
      assert.equal(read(dir, "drafts", n, "data.json"), dataBefore[n]);
    }
  });
});

describe("refresh images", () => {
  // --refresh-images re-picks art from the names saved in data.json, with no logs involved.
  const names = Object.values(CARDS).map(c => c[0]);
  const quiet = () => {};

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "refresh-spec-"));
    for (const d of ["D1", "D2"]) cli("--publish", dir, "--no-images", "--draft-id", d);
    const path = n => join(dir, "drafts", String(n), "data.json");
    const cachePath = join(dir, "cache.json");
    const fake = () => fakeScryfall(
      names.map((n, i) => card(n, `O${i}`, `default-${n}.jpg`)),
      Object.fromEntries(names.map((n, i) => [`O${i}`, [card(n, `O${i}`, `new-${n}.jpg`)]])));
    const refresh = get => refreshImages(dir, { get, cachePath, log: quiet });
    const load = n => JSON.parse(readFileSync(path(n), "utf8"));
    return { dir, path, cachePath, fake, refresh, load };
  }
  const strip = d => {
    d = JSON.parse(JSON.stringify(d));
    for (const p of d.picks) for (const c of p.cards) delete c.img;
    for (const z of Object.values(d.deck ?? {})) for (const c of z) delete c.img;
    delete d.images;
    return d;
  };

  it("gives every card and game name its new url without any logs", async () => {
    const s = setup();
    assert.deepEqual(await s.refresh(s.fake().get), [1, 2]);
    const d = s.load(1);
    const cards = [...d.picks.flatMap(p => p.cards), ...Object.values(d.deck).flat()];
    assert.ok(cards.length && cards.every(c => c.img === `new-${c.name}.jpg`));
    assert.equal(d.images["Alpha Land"], "new-Alpha Land.jpg");     // from the narration
    assert.equal(d.images["Eta Charm"], "new-Eta Charm.jpg");       // from the sideboard box
    assert.equal(d.images["Epsilon Land"], "new-Epsilon Land.jpg"); // an opponent card
  });

  it("changes nothing but image urls", async () => {
    const s = setup();
    const before = s.load(1);
    await s.refresh(s.fake().get);
    assert.deepEqual(strip(s.load(1)), strip(before));
  });

  it("refreshes a draft with no games or deck too", async () => {
    const s = setup();
    await s.refresh(s.fake().get);
    assert.ok(s.load(2).picks.flatMap(p => p.cards).every(c => c.img === `new-${c.name}.jpg`));
  });

  it("changes nothing the second time it runs", async () => {
    const s = setup();
    await s.refresh(s.fake().get);
    const once = readFileSync(s.path(1), "utf8");
    await s.refresh(s.fake().get);
    assert.equal(readFileSync(s.path(1), "utf8"), once);
  });

  it("sorts the images map so republishing never makes git noise", async () => {
    const s = setup();
    await s.refresh(s.fake().get);
    const keys = Object.keys(s.load(1).images);
    assert.deepEqual(keys, [...keys].sort());
    assert.deepEqual(Object.keys(imageMap(new Set(["b", "a", "c"]), { a: "1", b: "2", c: "3" })), ["a", "b", "c"]);
  });

  it("skips names with no url and falls back to the old one", () => {
    assert.deepEqual(imageMap(new Set(["a", "b", "c"]), { a: "new" }, { b: "old", a: "stale" }), { a: "new", b: "old" });
  });

  it("keeps the current urls when a lookup fails", async () => {
    const s = setup();
    await s.refresh(s.fake().get);
    const good = readFileSync(s.path(1), "utf8");
    rmSync(s.cachePath); // force real lookups, then make them fail
    await s.refresh(async () => { throw new Error("network down"); });
    assert.equal(readFileSync(s.path(1), "utf8"), good);
  });
});

// The Oct 26 cube draft, as parsed from the author's real logs. Skipped once Arena has rotated it out or on
// any other machine. These numbers were verified against the log by hand.
const LOG_DIR = join(homedir(), "Library/Logs/Wizards Of The Coast/MTGA");
const REAL_EVENT = "CubeDraft_PoweredTraditional_20261020";
const realLogs = ["Player-prev.log", "Player.log"].map(n => join(LOG_DIR, n)).filter(existsSync);
const realLogHasDraft = realLogs.some(p => readFileSync(p, "utf8").includes(REAL_EVENT));
describe("real log regression", { skip: !realLogHasDraft && "that draft is not in this machine's Arena logs" }, () => {
  // [match, game]: [turns, mulligans, opening size, on play, sideboarded?]
  const EXPECTED = { "1,1": [15, 0, 7, "You", false], "1,2": [5, 2, 5, "Opp", true], "2,1": [15, 0, 7, "You", false],
    "2,2": [11, 0, 7, "Opp", true], "3,1": [8, 1, 6, "You", false], "3,2": [6, 0, 7, "Opp", true] };

  it("matches the hand-verified values for every game", async () => {
    const saved = process.env.ARENA_CARD_DB;
    delete process.env.ARENA_CARD_DB; // this one reads Arena's real card database, not the synthetic one
    try {
      const got = {};
      for (const m of await parseGames(realLogs, REAL_EVENT)) {
        for (const g of m.games) got[`${m.match},${g.game}`] = [g.turns.length, g.mulligans, g.opening.length, g.onPlay, Boolean(g.sideboard)];
      }
      assert.deepEqual(got, EXPECTED);
    } finally {
      process.env.ARENA_CARD_DB = saved;
    }
  });
});
