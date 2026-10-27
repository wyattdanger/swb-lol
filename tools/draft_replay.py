#!/usr/bin/env python3
"""Reconstruct an MTG Arena draft, pack by pack, from Player.log.

Data sources:
  - `Draft.Notify` log lines: the contents of the pack you were looking at
    (draftId, SelfPack, SelfPick, PackCards).
  - `==> EventPlayerDraftMakePick` lines: the card you picked.
  - Arena's local Raw_CardDatabase_*.mtga (SQLite): grpId -> card name.

Usage:
  draft_replay.py [LOG ...] [--draft-id ID] [--json]
Defaults to Player.log and Player-prev.log in Arena's log directory.
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import time
import urllib.parse
import urllib.request
import sys
from collections import OrderedDict
from urllib.parse import quote

LOG_DIR = os.path.expanduser("~/Library/Logs/Wizards Of The Coast/MTGA")
DB_GLOB = os.path.expanduser(
    "~/Library/Application Support/com.wizards.mtga/Downloads/Raw/Raw_CardDatabase_*.mtga"
)

NOTIFY_RE = re.compile(r"Draft\.Notify (\{.*\})\s*$")
PICK_RE = re.compile(r"==> EventPlayerDraftMakePick (\{.*\})\s*$")
DECK_RE = re.compile(r"==> EventSetDeckV3 (\{.*\})\s*$")
EVENT_RE = re.compile(r"==> DraftCompleteDraft (\{.*\})\s*$")


def load_names(grp_ids):
    db = find_card_db()
    if not db:
        return {}
    con = sqlite3.connect(f"file:{quote(db)}?mode=ro", uri=True)
    names = {}
    ids = list(grp_ids)
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        q = ",".join("?" * len(chunk))
        rows = con.execute(
            f"SELECT c.GrpId, l.Loc FROM Cards c "
            f"JOIN Localizations_enUS l ON l.LocId = c.TitleId "
            f"WHERE c.GrpId IN ({q})",
            chunk,
        )
        names.update(rows)
    return names


CARD_TYPES = {1: "Artifact", 2: "Creature", 3: "Enchantment", 4: "Instant", 5: "Land",
              8: "Planeswalker", 10: "Sorcery", 11: "Kindred", 14: "Battle"}
COLORS = {1: "W", 2: "U", 3: "B", 4: "R", 5: "G"}


def load_meta(grp_ids):
    """grpId -> {colors, cost, types, rarity} for the JSON export."""
    db = find_card_db()
    if not db:
        return {}
    con = sqlite3.connect(f"file:{quote(db)}?mode=ro", uri=True)
    meta = {}
    ids = list(grp_ids)
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        q = ",".join("?" * len(chunk))
        for g, colors, types, cost, rarity in con.execute(
            f"SELECT GrpId, Colors, Types, OldSchoolManaText, Rarity FROM Cards WHERE GrpId IN ({q})", chunk
        ):
            ints = lambda v: [int(x) for x in (v or "").split(",") if x]
            meta[g] = {
                "colors": "".join(COLORS.get(c, "") for c in ints(colors)),
                "types": [CARD_TYPES.get(t, str(t)) for t in ints(types)],
                "cost": re.sub(r"o(\w)", r"{\1}", cost or ""),
                "rarity": rarity,
            }
    return meta


from games import find_card_db, parse_games  # noqa: E402  (tools/ is on sys.path when run as a script)

SCHEMA = 1  # bump when data.json changes shape in a way the viewer must handle
HERE = os.path.dirname(os.path.abspath(__file__))


def draft_number(site, draft_id):
    """A draft's number: the folder already holding its data.json, else the next free number."""
    known = {}
    for d in glob.glob(os.path.join(site, "drafts", "*", "data.json")):
        try:
            known[json.load(open(d))["draftId"]] = int(os.path.basename(os.path.dirname(d)))
        except (ValueError, KeyError, json.JSONDecodeError):
            continue
    return known.get(draft_id) or max(known.values(), default=0) + 1


def write_shell(dest):
    """Every draft page is the same tiny shell; the viewer and the data are separate files."""
    with open(os.path.join(HERE, "shell.html")) as src, open(os.path.join(dest, "index.html"), "w") as f:
        f.write(src.read())


def rebuild_shells(site):
    nums = sorted(int(os.path.basename(os.path.dirname(d)))
                  for d in glob.glob(os.path.join(site, "drafts", "*", "data.json")))
    for n in nums:
        write_shell(os.path.join(site, "drafts", str(n)))
    return nums


SCRYFALL_CACHE = os.path.join(HERE, "scryfall_cache.json")
CACHE_VERSION = 2  # v1 held the newest printing's image; bumping this discards old entries
SCRYFALL_HEADERS = {"Accept": "application/json", "User-Agent": "swb-lol-draft-replay/1.0"}
# Printings skipped when choosing the oldest art: promos (one can predate a card's first set), gold-bordered
# tournament decks, memorabilia, oversized cards, and non-English prints. Alpha and Beta are skipped too, so a
# card first printed there shows its Unlimited printing instead.
OLDEST_FILTERS = "-is:promo -border:gold -set_type:memorabilia -is:oversized lang:en -set:lea -set:leb"
# Cards pinned to a specific set's printing instead of their oldest: card name -> set code.
# Basic lands use the full-art Unhinged ones.
PINNED_SETS = {basic: "unh" for basic in ("Plains", "Island", "Swamp", "Mountain", "Forest")}


def _scryfall_get(url, body=None):
    """One polite Scryfall request (they ask for 50-100ms between calls). Tests replace this."""
    time.sleep(0.1)
    headers = dict(SCRYFALL_HEADERS, **({"Content-Type": "application/json"} if body is not None else {}))
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    return json.load(urllib.request.urlopen(req, timeout=20))


def _image(card):
    return (card.get("image_uris") or card["card_faces"][0]["image_uris"])["normal"]


def _first_image(q):
    """Image of the first printing a search returns, with printings sorted oldest first; None if there is none."""
    try:
        results = _scryfall_get("https://api.scryfall.com/cards/search?" + urllib.parse.urlencode(
            {"q": q, "unique": "prints", "order": "released", "dir": "asc"}))["data"]
    except Exception:  # Scryfall answers 404 when a search has no results
        return None
    for card in results:
        try:
            return _image(card)
        except KeyError:
            continue
    return None


def _oldest_image(oracle_id):
    """Image of the card's earliest printing; None if Scryfall has no usable printing."""
    for filters in (OLDEST_FILTERS, ""):  # if the filters exclude every printing, retry without them
        url = _first_image(f"oracleid:{oracle_id} {filters}".strip())
        if url:
            return url
    return None


def game_card_names(game_data):
    """Every card name the game narration mentions (events, opening hands, opponent cards, sideboarding)."""
    names = set(re.findall(r"\{\{(.+?)\}\}", json.dumps(game_data, ensure_ascii=False)))
    for m in game_data:
        for g in m["games"]:
            names |= set(g["opening"]) | set(g["opponentCards"])
            names |= {x["n"] for k in ("in", "out") for x in (g["sideboard"] or {}).get(k, [])}
    return names


def image_map(names, imgs, fallback=None):
    """name -> url for the names that have one, in sorted order so the same draft always serializes the same."""
    fallback = fallback or {}
    return {n: imgs.get(n) or fallback[n] for n in sorted(names) if imgs.get(n) or fallback.get(n)}


def refresh_images(site):
    """Re-pick every card's image URL in each draft's data.json from the card names already saved there.
    Needs no Arena logs. A card whose lookup fails keeps its current URL. Returns the draft numbers touched."""
    touched = []
    for path in sorted(glob.glob(os.path.join(site, "drafts", "*", "data.json"))):
        with open(path) as f:
            data = json.load(f)
        cards = [c for p in data["picks"] for c in p["cards"]] + [c for z in (data.get("deck") or {}).values() for c in z]
        game_names = game_card_names(data.get("games", []))
        imgs = scryfall_images({c["name"] for c in cards} | game_names)
        for c in cards:
            if c["name"] in imgs:
                c["img"] = imgs[c["name"]]
        if "games" in data:
            data["images"] = image_map(game_names, imgs, data.get("images"))
        with open(path, "w") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
        touched.append(int(os.path.basename(os.path.dirname(path))))
    return touched


def scryfall_images(names):
    """card name -> image URL of that card's OLDEST printing. Cached on disk; only unseen names hit the API."""
    cache = {}
    if os.path.exists(SCRYFALL_CACHE):
        with open(SCRYFALL_CACHE) as f:
            cache = json.load(f)
    if cache.get("_v") != CACHE_VERSION or cache.get("filters") != OLDEST_FILTERS:  # the selection rule changed
        cache = {"_v": CACHE_VERSION, "filters": OLDEST_FILTERS, "images": {}}
    images = cache["images"]
    pins = cache.setdefault("pins", {})  # which set each pinned card's cached image was chosen from
    for name, code in PINNED_SETS.items():
        if pins.get(name) != code:  # pin added or changed since this entry was cached: look it up again
            images.pop(name, None)
    todo = sorted(n for n in set(names) if n not in images)
    if todo:
        print(f"# looking up the oldest printing of {len(todo)} cards on Scryfall (first run only)...", file=sys.stderr)
    for i in range(0, len(todo), 75):
        chunk = todo[i : i + 75]
        try:
            data = _scryfall_get("https://api.scryfall.com/cards/collection",
                                 {"identifiers": [{"name": n} for n in chunk]})["data"]
        except Exception as e:  # offline or rate-limited: render without images
            print(f"# scryfall lookup failed ({e}); continuing without images for {len(chunk)} cards", file=sys.stderr)
            continue
        by_name = {}
        for c in data:
            by_name[c["name"]] = by_name[c["name"].split(" // ")[0]] = c
        for n in chunk:
            card = by_name.get(n)
            if card is None:
                # Arena names can differ from Scryfall's in accents (bulk lookup returns them under the accented
                # name), so anything unmapped goes through the fuzzy endpoint, which tolerates that.
                try:
                    card = _scryfall_get("https://api.scryfall.com/cards/named?fuzzy=" + urllib.parse.quote(n))
                except Exception as e:
                    print(f"# no image for {n!r}: {e}", file=sys.stderr)
                    continue
            oracle_id = card.get("oracle_id") or card["card_faces"][0].get("oracle_id")
            code = PINNED_SETS.get(n)
            url = _first_image(f"oracleid:{oracle_id} set:{code}") if code and oracle_id else None
            url = url or (_oldest_image(oracle_id) if oracle_id else None)
            images[n] = url or _image(card)  # fall back to Scryfall's default printing
            if code:
                pins[n] = code
    with open(SCRYFALL_CACHE, "w") as f:
        json.dump(cache, f, indent=1, sort_keys=True)
    return {n: images[n] for n in set(names) if n in images}


def parse(paths):
    """Return {draft_id: {"packs": {(pack, pick): [grpIds]}, "picks": {(pack, pick): grpId}, ...}}"""
    drafts = OrderedDict()
    for path in paths:
        with open(path, errors="replace") as f:
            for line in f:
                if "Draft.Notify" in line:
                    m = NOTIFY_RE.search(line)
                    if not m:
                        continue
                    d = json.loads(m.group(1))
                    dr = drafts.setdefault(d["draftId"], {"packs": {}, "picks": {}, "event": None})
                    key = (d["SelfPack"], d["SelfPick"])
                    # Arena logs each notify twice; identical content, so last-wins is fine.
                    dr["packs"][key] = [int(x) for x in d["PackCards"].split(",") if x]
                elif "EventPlayerDraftMakePick" in line and "==>" in line:
                    m = PICK_RE.search(line)
                    if not m:
                        continue
                    req = json.loads(json.loads(m.group(1))["request"])
                    dr = drafts.setdefault(req["DraftId"], {"packs": {}, "picks": {}, "event": None})
                    dr["picks"][(req["Pack"], req["Pick"])] = req["GrpIds"][0]
                elif "==> EventSetDeckV3" in line:
                    m = DECK_RE.search(line)
                    if not m:
                        continue
                    req = json.loads(json.loads(m.group(1))["request"])
                    for dr in reversed(drafts.values()):
                        if dr["event"] == req.get("EventName"):
                            dr["deck"] = req["Deck"]  # later submissions overwrite earlier ones
                            break
                elif "DraftCompleteDraft" in line and "==>" in line:
                    m = EVENT_RE.search(line)
                    if m and drafts:
                        req = json.loads(json.loads(m.group(1))["request"])
                        next(reversed(drafts.values()))["event"] = req.get("EventName")
    return drafts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logs", nargs="*", help="log files (default: Arena's Player-prev.log then Player.log)")
    ap.add_argument("--draft-id", help="which draft to show (default: the most recent)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    ap.add_argument("--no-images", action="store_true", help="skip Scryfall image lookups (offline / tests)")
    ap.add_argument("--publish", metavar="SITE_DIR",
                    help="write SITE_DIR/drafts/<n>/data.json (the draft's data) and its page shell; "
                         "n is stable per draft, found by scanning existing data files")
    ap.add_argument("--rebuild", metavar="SITE_DIR",
                    help="rewrite every draft page shell under SITE_DIR from tools/shell.html (no logs needed)")
    ap.add_argument("--refresh-images", metavar="SITE_DIR",
                    help="re-pick every card's image URL in each draft's data.json from its saved card names "
                         "(no logs needed; uses the cache, so only unseen names hit Scryfall)")
    args = ap.parse_args()

    if args.refresh_images:
        for n in refresh_images(args.refresh_images):
            print(f"refreshed images in {args.refresh_images}/drafts/{n}/data.json")
        return

    if args.rebuild:
        for n in rebuild_shells(args.rebuild):
            print(f"refreshed {args.rebuild}/drafts/{n}/index.html")
        return

    logs = args.logs or [os.path.join(LOG_DIR, n) for n in ("Player-prev.log", "Player.log")]
    drafts = parse([p for p in logs if os.path.exists(p)])
    if not drafts:
        sys.exit("No draft data found in the logs.")

    draft_id = args.draft_id or list(drafts)[-1]
    if len(drafts) > 1 and not args.draft_id:
        print(f"# {len(drafts)} drafts found; showing the latest. Use --draft-id for another:", file=sys.stderr)
        for d in drafts:
            print(f"#   {d}  ({len(drafts[d]['picks'])} picks)", file=sys.stderr)
    dr = drafts[draft_id]

    deck = dr.get("deck")
    deck_ids = {c["cardId"] for z in ("MainDeck", "Sideboard") for c in (deck or {}).get(z, [])}
    all_ids = {c for pack in dr["packs"].values() for c in pack} | set(dr["picks"].values()) | deck_ids
    names = load_names(all_ids)
    name = lambda g: names.get(g, f"<unknown {g}>")

    if args.json or args.publish:
        meta = load_meta(all_ids)
        game_data = parse_games([p for p in logs if os.path.exists(p)], dr["event"]) if dr["event"] else []
        game_names = game_card_names(game_data)
        imgs = {} if args.no_images else scryfall_images({name(g) for g in all_ids if g in names} | game_names)
        card = lambda g: {"name": name(g), **meta.get(g, {}), **({"img": imgs[name(g)]} if name(g) in imgs else {})}
        out = {"draftId": draft_id, "event": dr["event"], "picks": []}
        if game_data:
            out["games"] = game_data
            out["images"] = image_map(game_names, imgs)
        if deck:
            zone = lambda z: [{**card(c["cardId"]), "qty": c["quantity"]} for c in deck.get(z, [])]
            out["deck"] = {"main": zone("MainDeck"), "side": zone("Sideboard")}
        for key in sorted(dr["packs"]):
            out["picks"].append({
                "pack": key[0], "pick": key[1],
                "picked": name(dr["picks"][key]) if key in dr["picks"] else None,
                "cards": [card(g) for g in dr["packs"][key]],
            })
        if args.publish:
            num = draft_number(args.publish, draft_id)
            dest = os.path.join(args.publish, "drafts", str(num))
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, "data.json"), "w") as f:
                json.dump({"schema": SCHEMA, "number": num, **out}, f, separators=(",", ":"), ensure_ascii=False)
            write_shell(dest)
            print(f"wrote {dest}/data.json  ->  /drafts/{num}")
            return
        json.dump(out, sys.stdout, indent=2)
        print()
        return

    print(f"Draft {draft_id}" + (f"  ({dr['event']})" if dr["event"] else ""))
    cur_pack = None
    for key in sorted(dr["packs"]):
        pack_no, pick_no = key
        if pack_no != cur_pack:
            cur_pack = pack_no
            print(f"\n{'=' * 60}\nPACK {pack_no}\n{'=' * 60}")
        cards = dr["packs"][key]
        picked = dr["picks"].get(key)
        print(f"\nPick {pick_no}  ({len(cards)} cards)")
        for g in cards:
            mark = "  -> " if g == picked else "     "
            print(f"{mark}{name(g)}")
        if picked is None:
            print("     (no pick recorded)")
        elif picked not in cards:
            print(f"     !! picked {name(picked)} which isn't in the logged pack")

    missing = [k for k in dr["packs"] if k not in dr["picks"]]
    print(f"\n{len(dr['packs'])} packs seen, {len(dr['picks'])} picks recorded"
          + (f", {len(missing)} without a pick" if missing else ""))


if __name__ == "__main__":
    main()
