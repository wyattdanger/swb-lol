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
    dbs = sorted((p for p in glob.glob(DB_GLOB) if os.path.getsize(p) > 0), key=os.path.getmtime)
    if not dbs:
        return {}
    con = sqlite3.connect(f"file:{quote(dbs[-1])}?mode=ro", uri=True)
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
    dbs = sorted((p for p in glob.glob(DB_GLOB) if os.path.getsize(p) > 0), key=os.path.getmtime)
    if not dbs:
        return {}
    con = sqlite3.connect(f"file:{quote(dbs[-1])}?mode=ro", uri=True)
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


from games import parse_games  # noqa: E402  (tools/ is on sys.path when run as a script)

SCRYFALL_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scryfall_cache.json")


def scryfall_images(names):
    """card name -> Scryfall 'normal' image URL. Cached on disk; only unseen names hit the API."""
    cache = json.load(open(SCRYFALL_CACHE)) if os.path.exists(SCRYFALL_CACHE) else {}
    todo = sorted(n for n in set(names) if n not in cache)
    for i in range(0, len(todo), 75):
        chunk = todo[i : i + 75]
        req = urllib.request.Request(
            "https://api.scryfall.com/cards/collection",
            data=json.dumps({"identifiers": [{"name": n} for n in chunk]}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "swb-lol-draft-replay/1.0"},
        )
        try:
            resp = json.load(urllib.request.urlopen(req, timeout=20))
            data = resp["data"]
        except Exception as e:  # offline or rate-limited: render without images
            print(f"# scryfall lookup failed ({e}); continuing without images for {len(chunk)} cards", file=sys.stderr)
            continue
        by_name = {}
        for c in data:
            uris = c.get("image_uris") or c["card_faces"][0]["image_uris"]
            by_name[c["name"]] = by_name[c["name"].split(" // ")[0]] = uris["normal"]
        for n in chunk:
            if n in by_name:
                cache[n] = by_name[n]
        # Arena names can differ from Scryfall's in accents (bulk lookup returns them under the accented name),
        # so anything left unmapped goes through the fuzzy endpoint, which tolerates that.
        for n in chunk:
            if n in cache:
                continue
            try:
                c = json.load(urllib.request.urlopen(urllib.request.Request(
                    "https://api.scryfall.com/cards/named?fuzzy=" + urllib.parse.quote(n),
                    headers={"Accept": "application/json", "User-Agent": "swb-lol-draft-replay/1.0"}), timeout=20))
                cache[n] = (c.get("image_uris") or c["card_faces"][0]["image_uris"])["normal"]
            except Exception as e:
                print(f"# no image for {n!r}: {e}", file=sys.stderr)
    with open(SCRYFALL_CACHE, "w") as f:
        json.dump(cache, f, indent=1, sort_keys=True)
    return cache


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
    ap.add_argument("--publish", metavar="SITE_DIR",
                    help="write the viewer page to SITE_DIR/drafts/<n>/index.html; n is stable per draft (tools/drafts.json)")
    args = ap.parse_args()

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
        game_names = set(re.findall(r"\{\{(.+?)\}\}", json.dumps(game_data, ensure_ascii=False)))
        game_names |= {n for m in game_data for g in m["games"] for n in g["opening"] + g["opponentCards"]}
        game_names |= {x["n"] for m in game_data for g in m["games"] for x in (g["sideboard"] or {}).get("in", []) + (g["sideboard"] or {}).get("out", [])}
        imgs = scryfall_images({name(g) for g in all_ids if g in names} | game_names)
        card = lambda g: {"name": name(g), **meta.get(g, {}), **({"img": imgs[name(g)]} if name(g) in imgs else {})}
        out = {"draftId": draft_id, "event": dr["event"], "picks": []}
        if game_data:
            out["games"] = game_data
            out["images"] = {n: imgs[n] for n in game_names if n in imgs}
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
            here = os.path.dirname(os.path.abspath(__file__))
            manifest_path = os.path.join(here, "drafts.json")
            manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
            if draft_id not in manifest:
                manifest[draft_id] = max(manifest.values(), default=0) + 1
                with open(manifest_path, "w") as f:
                    json.dump(manifest, f, indent=2)
                    f.write("\n")
            num = manifest[draft_id]
            tpl = open(os.path.join(here, "viewer.template.html")).read()
            page = tpl.replace("__DATA__", json.dumps(out, separators=(",", ":")).replace("</", "<\\/"))
            page = page.replace("<title>", '<meta name="robots" content="noindex">\n<title>', 1)
            dest = os.path.join(args.publish, "drafts", str(num))
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, "index.html"), "w") as f:
                f.write(page)
            print(f"wrote {dest}/index.html  ->  /drafts/{num}")
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
