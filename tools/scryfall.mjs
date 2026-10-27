// Picking each card's art on Scryfall: the oldest non-promo printing (Unlimited instead of Alpha/Beta),
// with the basic lands pinned to Unhinged. Results are cached on disk so only unseen cards cost a request.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_CACHE = join(dirname(fileURLToPath(import.meta.url)), "scryfall_cache.json");
export const CACHE_VERSION = 2; // v1 held the newest printing's image; bumping this discards old entries
const HEADERS = { Accept: "application/json", "User-Agent": "swb-lol-draft-replay/1.0" };
// Printings skipped when choosing the oldest art: promos (one can predate a card's first set), gold-bordered
// tournament decks, memorabilia, oversized cards, and non-English prints. Alpha and Beta are skipped too, so a
// card first printed there shows its Unlimited printing instead.
export const OLDEST_FILTERS = "-is:promo -border:gold -set_type:memorabilia -is:oversized lang:en -set:lea -set:leb";
// Cards pinned to a specific set's printing instead of their oldest: card name -> set code.
// Basic lands use the full-art Unhinged ones.
export const PINNED_SETS = Object.fromEntries(["Plains", "Island", "Swamp", "Mountain", "Forest"].map(b => [b, "unh"]));

// Scryfall asks for 50-100ms between requests: start no more than one every 100ms, however many are in flight.
let nextStart = 0;
async function gate() {
  const now = Date.now();
  const wait = Math.max(0, nextStart - now);
  nextStart = Math.max(now, nextStart) + 100;
  if (wait) await sleep(wait);
}

/** One request to Scryfall: a GET, or a POST when a body is given. Throws on any non-2xx (a search with no hits is a 404). */
export async function httpGet(url, body) {
  await gate();
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? HEADERS : { ...HEADERS, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const hasOwn = (o, k) => Object.hasOwn(o, k);
const imageOf = card => (card.image_uris ?? card.card_faces?.[0]?.image_uris)?.normal;

/** Image of the first printing a search returns (printings sorted oldest first); undefined if there is none. */
async function firstImage(get, q) {
  let results;
  try {
    results = (await get("https://api.scryfall.com/cards/search?" +
      new URLSearchParams({ q, unique: "prints", order: "released", dir: "asc" }))).data;
  } catch {
    return undefined; // Scryfall answers 404 when a search has no results
  }
  for (const card of results) {
    const url = imageOf(card);
    if (url) return url;
  }
  return undefined;
}

/** Image of the card's earliest printing; undefined if Scryfall has no usable printing. */
async function oldestImage(get, oracleId) {
  for (const filters of [OLDEST_FILTERS, ""]) { // if the filters exclude every printing, retry without them
    const url = await firstImage(get, `oracleid:${oracleId} ${filters}`.trim());
    if (url) return url;
  }
  return undefined;
}

/** Run fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

function* chunks(list, size) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

const sortKeys = v => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;

/** Every card name the game narration mentions (events, opening hands, opponent cards, sideboarding). */
export function gameCardNames(gameData) {
  const names = new Set([...JSON.stringify(gameData).matchAll(/\{\{(.+?)\}\}/g)].map(m => m[1]));
  for (const m of gameData) {
    for (const g of m.games) {
      for (const n of [...g.opening, ...g.opponentCards]) names.add(n);
      for (const k of ["in", "out"]) for (const x of g.sideboard?.[k] ?? []) names.add(x.n);
    }
  }
  return names;
}

/** name -> url for the names that have one, in sorted order so the same draft always serializes the same. */
export function imageMap(names, imgs, fallback = {}) {
  const out = {};
  for (const n of [...names].sort()) {
    const url = imgs[n] || fallback[n];
    if (url) out[n] = url;
  }
  return out;
}

/**
 * card name -> image URL of that card's oldest printing. Cached on disk; only unseen names hit the API.
 * Options let the specs inject a fake `get` and a temp `cachePath`.
 */
export async function scryfallImages(names, { get = httpGet, cachePath = DEFAULT_CACHE, log = m => console.error(m), concurrency = 4 } = {}) {
  let cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  if (cache._v !== CACHE_VERSION || cache.filters !== OLDEST_FILTERS) { // the selection rule changed
    cache = { _v: CACHE_VERSION, filters: OLDEST_FILTERS, images: {} };
  }
  const images = cache.images;
  const pins = (cache.pins ??= {}); // which set each pinned card's cached image was chosen from
  for (const [name, code] of Object.entries(PINNED_SETS)) {
    if (pins[name] !== code) delete images[name]; // pin added or changed since this entry was cached: look it up again
  }
  const wanted = [...new Set(names)];
  const todo = wanted.filter(n => !hasOwn(images, n)).sort();
  if (todo.length) log(`# looking up the oldest printing of ${todo.length} cards on Scryfall (first run only)...`);

  for (const chunk of chunks(todo, 75)) {
    let data;
    try {
      ({ data } = await get("https://api.scryfall.com/cards/collection", { identifiers: chunk.map(name => ({ name })) }));
    } catch (e) { // offline or rate-limited: render without images
      log(`# scryfall lookup failed (${e.message}); continuing without images for ${chunk.length} cards`);
      continue;
    }
    const byName = new Map();
    for (const c of data) {
      byName.set(c.name, c);
      byName.set(c.name.split(" // ")[0], c);
    }
    await pool(chunk, concurrency, async n => {
      let card = byName.get(n);
      if (!card) {
        // Arena names can differ from Scryfall's in accents (bulk lookup returns them under the accented name),
        // so anything unmapped goes through the fuzzy endpoint, which tolerates that.
        try {
          card = await get("https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(n));
        } catch (e) {
          log(`# no image for '${n}': ${e.message}`);
          return;
        }
      }
      const oracleId = card.oracle_id ?? card.card_faces?.[0]?.oracle_id;
      const code = hasOwn(PINNED_SETS, n) ? PINNED_SETS[n] : undefined;
      let url = code && oracleId ? await firstImage(get, `oracleid:${oracleId} set:${code}`) : undefined;
      url ||= oracleId ? await oldestImage(get, oracleId) : undefined;
      url ||= imageOf(card); // fall back to Scryfall's default printing
      if (url) images[n] = url;
      if (code) pins[n] = code;
    });
  }
  writeFileSync(cachePath, JSON.stringify(sortKeys(cache), null, 1));
  return Object.fromEntries(wanted.filter(n => hasOwn(images, n)).map(n => [n, images[n]]));
}
