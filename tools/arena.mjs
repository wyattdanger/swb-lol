// Arena's local files: where its logs live, its card database, and reading a log line by line.
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (e) {
  throw new Error(
    "node:sqlite is not available. Older Node versions need --experimental-sqlite; the npm scripts pass it. " + e.message,
  );
}

export const LOG_DIR = join(homedir(), "Library/Logs/Wizards Of The Coast/MTGA");
const DB_DIR = join(homedir(), "Library/Application Support/com.wizards.mtga/Downloads/Raw");

export const CARD_TYPES = { 1: "Artifact", 2: "Creature", 3: "Enchantment", 4: "Instant", 5: "Land",
  8: "Planeswalker", 10: "Sorcery", 11: "Kindred", 14: "Battle" };
export const COLORS = { 1: "W", 2: "U", 3: "B", 4: "R", 5: "G" };

/** Arena's local card database; ARENA_CARD_DB overrides it (the specs use this). */
export function findCardDb() {
  if (process.env.ARENA_CARD_DB) return process.env.ARENA_CARD_DB;
  if (!existsSync(DB_DIR)) return null;
  const dbs = readdirSync(DB_DIR)
    .filter(f => f.startsWith("Raw_CardDatabase_") && f.endsWith(".mtga"))
    .map(f => join(DB_DIR, f))
    .filter(p => statSync(p).size > 0)
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return dbs.at(-1) ?? null;
}

export const openCardDb = path => new DatabaseSync(path, { readOnly: true });
export { DatabaseSync };

function* chunks(list, size) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

/** grpId -> English card name, for the ids given. */
export function loadNames(grpIds) {
  const path = findCardDb();
  const names = new Map();
  if (!path) return names;
  const db = openCardDb(path);
  try {
    for (const chunk of chunks([...grpIds], 500)) {
      const rows = db.prepare(
        `SELECT c.GrpId, l.Loc FROM Cards c JOIN Localizations_enUS l ON l.LocId = c.TitleId ` +
        `WHERE c.GrpId IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk);
      for (const r of rows) names.set(r.GrpId, r.Loc);
    }
  } finally {
    db.close();
  }
  return names;
}

const ints = v => (v ?? "").split(",").filter(Boolean).map(Number);

/** grpId -> { colors, types, cost, rarity }, for the ids given. */
export function loadMeta(grpIds) {
  const path = findCardDb();
  const meta = new Map();
  if (!path) return meta;
  const db = openCardDb(path);
  try {
    for (const chunk of chunks([...grpIds], 500)) {
      const rows = db.prepare(
        `SELECT GrpId, Colors, Types, OldSchoolManaText, Rarity FROM Cards ` +
        `WHERE GrpId IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk);
      for (const r of rows) {
        meta.set(r.GrpId, {
          colors: ints(r.Colors).map(c => COLORS[c] ?? "").join(""),
          types: ints(r.Types).map(t => CARD_TYPES[t] ?? String(t)),
          cost: (r.OldSchoolManaText ?? "").replace(/o(\w)/g, "{$1}"),
          rarity: r.Rarity,
        });
      }
    }
  } finally {
    db.close();
  }
  return meta;
}

/** Every line of a file, streamed (the logs are tens of megabytes). Invalid UTF-8 is replaced, not fatal. */
export async function* lines(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}
