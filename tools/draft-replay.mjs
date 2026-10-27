#!/usr/bin/env node
// Reconstruct an MTG Arena draft, pack by pack, from Player.log.
//
// Data sources:
//   - `Draft.Notify` log lines: the contents of the pack you were looking at (draftId, SelfPack, SelfPick, PackCards).
//   - `==> EventPlayerDraftMakePick` lines: the card you picked.
//   - `==> EventSetDeckV3` lines: the deck you submitted.
//   - Arena's local Raw_CardDatabase_*.mtga (SQLite): grpId -> card name and details.
//
// Usage (the npm script passes the Node flags SQLite needs):
//   npm run draft -- [LOG ...] [--draft-id ID] [--json] [--no-images]
//   npm run draft -- --publish .          write drafts/<n>/data.json and its page shell
//   npm run draft -- --rebuild .          rewrite every page shell (no logs needed)
//   npm run draft -- --refresh-images .   re-pick card art from saved names (no logs needed)
// Defaults to Player-prev.log and Player.log in Arena's log directory.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOG_DIR, lines, loadMeta, loadNames } from "./arena.mjs";
import { parseGames } from "./games.mjs";
import { gameCardNames, imageMap, scryfallImages } from "./scryfall.mjs";

export const SCHEMA = 1; // bump when data.json changes shape in a way the viewer must handle
const HERE = dirname(fileURLToPath(import.meta.url));

const NOTIFY_RE = /Draft\.Notify (\{.*\})\s*$/;
const PICK_RE = /==> EventPlayerDraftMakePick (\{.*\})\s*$/;
const DECK_RE = /==> EventSetDeckV3 (\{.*\})\s*$/;
const EVENT_RE = /==> DraftCompleteDraft (\{.*\})\s*$/;

const key = (pack, pick) => `${pack}-${pick}`;

/** Every draft found in the logs, in the order first seen: Map(draftId -> { packs, picks, event, deck? }). */
export async function parseDrafts(paths) {
  const drafts = new Map();
  const draft = id => {
    if (!drafts.has(id)) drafts.set(id, { packs: new Map(), picks: new Map(), event: null });
    return drafts.get(id);
  };
  for (const path of paths) {
    for await (const line of lines(path)) {
      if (line.includes("Draft.Notify")) {
        const m = NOTIFY_RE.exec(line);
        if (!m) continue;
        const d = JSON.parse(m[1]);
        // Arena logs each notify twice; identical content, so last-wins is fine.
        draft(d.draftId).packs.set(key(d.SelfPack, d.SelfPick),
          { pack: d.SelfPack, pick: d.SelfPick, ids: d.PackCards.split(",").filter(Boolean).map(Number) });
      } else if (line.includes("EventPlayerDraftMakePick") && line.includes("==>")) {
        const m = PICK_RE.exec(line);
        if (!m) continue;
        const req = JSON.parse(JSON.parse(m[1]).request);
        draft(req.DraftId).picks.set(key(req.Pack, req.Pick), req.GrpIds[0]);
      } else if (line.includes("==> EventSetDeckV3")) {
        const m = DECK_RE.exec(line);
        if (!m) continue;
        const req = JSON.parse(JSON.parse(m[1]).request);
        for (const dr of [...drafts.values()].reverse()) {
          if (dr.event === (req.EventName ?? null)) { dr.deck = req.Deck; break; } // later submissions overwrite earlier ones
        }
      } else if (line.includes("DraftCompleteDraft") && line.includes("==>")) {
        const m = EVENT_RE.exec(line);
        if (m && drafts.size) {
          const req = JSON.parse(JSON.parse(m[1]).request);
          [...drafts.values()].at(-1).event = req.EventName ?? null;
        }
      }
    }
  }
  return drafts;
}

/** The data.json body for one draft (without schema/number): picks, deck, games, and image URLs. */
export async function buildDraftData(dr, draftId, { logs, noImages = false, scryfall = {} } = {}) {
  const deck = dr.deck;
  const deckIds = ["MainDeck", "Sideboard"].flatMap(z => (deck?.[z] ?? []).map(c => c.cardId));
  const allIds = new Set([...[...dr.packs.values()].flatMap(p => p.ids), ...dr.picks.values(), ...deckIds]);
  const names = loadNames(allIds);
  const name = g => names.get(g) ?? `<unknown ${g}>`;
  const meta = loadMeta(allIds);
  const gameData = dr.event ? await parseGames(logs, dr.event) : [];
  const gameNames = gameCardNames(gameData);
  const imgs = noImages ? {} : await scryfallImages(
    new Set([...[...allIds].filter(g => names.has(g)).map(name), ...gameNames]), scryfall);
  const card = g => ({
    name: name(g), ...(meta.get(g) ?? {}),
    ...(Object.hasOwn(imgs, name(g)) ? { img: imgs[name(g)] } : {}),
  });
  const out = { draftId, event: dr.event, picks: [] };
  if (gameData.length) {
    out.games = gameData;
    out.images = imageMap(gameNames, imgs);
  }
  if (deck) {
    const zone = z => (deck[z] ?? []).map(c => ({ ...card(c.cardId), qty: c.quantity }));
    out.deck = { main: zone("MainDeck"), side: zone("Sideboard") };
  }
  for (const p of [...dr.packs.values()].sort((a, b) => a.pack - b.pack || a.pick - b.pick)) {
    const k = key(p.pack, p.pick);
    out.picks.push({ pack: p.pack, pick: p.pick, picked: dr.picks.has(k) ? name(dr.picks.get(k)) : null, cards: p.ids.map(card) });
  }
  return out;
}

/** The draft numbers that already have a data.json under site/drafts, ascending. */
function listDrafts(site) {
  const dir = join(site, "drafts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(d => /^\d+$/.test(d) && existsSync(join(dir, d, "data.json"))).map(Number).sort((a, b) => a - b);
}

/** A draft's number: the folder already holding its data.json, else the next free number. */
export function draftNumber(site, draftId) {
  const known = new Map();
  for (const n of listDrafts(site)) {
    try { known.set(JSON.parse(readFileSync(join(site, "drafts", String(n), "data.json"), "utf8")).draftId, n); } catch { /* skip */ }
  }
  return known.get(draftId) || Math.max(0, ...known.values()) + 1;
}

/** Every draft page is the same tiny shell; the viewer and the data are separate files. */
export function writeShell(dest) {
  copyFileSync(join(HERE, "shell.html"), join(dest, "index.html"));
}

export function rebuildShells(site) {
  const nums = listDrafts(site);
  for (const n of nums) writeShell(join(site, "drafts", String(n)));
  return nums;
}

/**
 * Re-pick every card's image URL in each draft's data.json from the card names already saved there.
 * Needs no Arena logs. A card whose lookup fails keeps its current URL. Returns the draft numbers touched.
 */
export async function refreshImages(site, scryfall = {}) {
  const touched = [];
  for (const n of listDrafts(site)) {
    const path = join(site, "drafts", String(n), "data.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    const cards = [...data.picks.flatMap(p => p.cards), ...Object.values(data.deck ?? {}).flat()];
    const gameNames = gameCardNames(data.games ?? []);
    const imgs = await scryfallImages(new Set([...cards.map(c => c.name), ...gameNames]), scryfall);
    for (const c of cards) if (Object.hasOwn(imgs, c.name)) c.img = imgs[c.name];
    if ("games" in data) data.images = imageMap(gameNames, imgs, data.images);
    writeFileSync(path, JSON.stringify(data));
    touched.push(n);
  }
  return touched;
}

/** The plain-text replay: every pack you saw, with your pick marked. */
export function textReplay(dr, draftId, name) {
  const out = [`Draft ${draftId}` + (dr.event ? `  (${dr.event})` : "")];
  let curPack = null;
  for (const p of [...dr.packs.values()].sort((a, b) => a.pack - b.pack || a.pick - b.pick)) {
    if (p.pack !== curPack) {
      curPack = p.pack;
      out.push(`\n${"=".repeat(60)}\nPACK ${p.pack}\n${"=".repeat(60)}`);
    }
    const picked = dr.picks.get(key(p.pack, p.pick));
    out.push(`\nPick ${p.pick}  (${p.ids.length} cards)`);
    for (const g of p.ids) out.push(`${g === picked ? "  -> " : "     "}${name(g)}`);
    if (picked === undefined) out.push("     (no pick recorded)");
    else if (!p.ids.includes(picked)) out.push(`     !! picked ${name(picked)} which isn't in the logged pack`);
  }
  const missing = [...dr.packs.keys()].filter(k => !dr.picks.has(k));
  out.push(`\n${dr.packs.size} packs seen, ${dr.picks.size} picks recorded` + (missing.length ? `, ${missing.length} without a pick` : ""));
  return out.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const { values: args, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      "draft-id": { type: "string" }, json: { type: "boolean" }, "no-images": { type: "boolean" },
      publish: { type: "string" }, rebuild: { type: "string" }, "refresh-images": { type: "string" },
    },
  });

  if (args["refresh-images"]) {
    for (const n of await refreshImages(args["refresh-images"])) console.log(`refreshed images in ${args["refresh-images"]}/drafts/${n}/data.json`);
    return;
  }
  if (args.rebuild) {
    for (const n of rebuildShells(args.rebuild)) console.log(`refreshed ${args.rebuild}/drafts/${n}/index.html`);
    return;
  }

  const logs = (positionals.length ? positionals : ["Player-prev.log", "Player.log"].map(n => join(LOG_DIR, n))).filter(existsSync);
  const drafts = await parseDrafts(logs);
  if (!drafts.size) { console.error("No draft data found in the logs."); process.exitCode = 1; return; }

  const draftId = args["draft-id"] ?? [...drafts.keys()].at(-1);
  if (drafts.size > 1 && !args["draft-id"]) {
    console.error(`# ${drafts.size} drafts found; showing the latest. Use --draft-id for another:`);
    for (const [id, d] of drafts) console.error(`#   ${id}  (${d.picks.size} picks)`);
  }
  const dr = drafts.get(draftId);
  if (!dr) { console.error(`No draft with id ${draftId} in the logs.`); process.exitCode = 1; return; }

  if (args.json || args.publish) {
    const out = await buildDraftData(dr, draftId, { logs, noImages: args["no-images"] });
    if (args.publish) {
      const num = draftNumber(args.publish, draftId);
      const dest = join(args.publish, "drafts", String(num));
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "data.json"), JSON.stringify({ schema: SCHEMA, number: num, ...out }));
      writeShell(dest);
      console.log(`wrote ${args.publish}/drafts/${num}/data.json  ->  /drafts/${num}`);
    } else {
      console.log(JSON.stringify(out, null, 2));
    }
    return;
  }

  const allIds = new Set([...[...dr.packs.values()].flatMap(p => p.ids), ...dr.picks.values()]);
  const names = loadNames(allIds);
  console.log(textReplay(dr, draftId, g => names.get(g) ?? `<unknown ${g}>`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
