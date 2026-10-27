"""Reconstruct game-by-game narration for a draft event from Arena's Player.log.

Reads the GreToClientEvent game-state messages and matchGameRoomStateChangedEvent
room events. Output is a list of matches; each has games; each game has turns of
plain-text events. Card names are wrapped as {{Card Name}} so the viewer can attach
hover images. The opponent is always just "Opp" (usernames are not kept).
"""
import glob
import json
import os
import re
from collections import Counter
import sqlite3
from urllib.parse import quote

DB_GLOB = os.path.expanduser(
    "~/Library/Application Support/com.wizards.mtga/Downloads/Raw/Raw_CardDatabase_*.mtga"
)
HIDDEN_ZONES = {"Limbo", "Pending", "Revealed", "Command", "Sideboard"}


def find_card_db():
    """Arena's local card database; ARENA_CARD_DB overrides it (used by the tests)."""
    if os.environ.get("ARENA_CARD_DB"):
        return os.environ["ARENA_CARD_DB"]
    dbs = sorted((p for p in glob.glob(DB_GLOB) if os.path.getsize(p) > 0), key=os.path.getmtime)
    return dbs[-1] if dbs else None


def _lookups():
    con = sqlite3.connect(f"file:{quote(find_card_db())}?mode=ro", uri=True)
    cache = {}

    def name(grp):
        if grp not in cache:
            r = con.execute(
                "SELECT l.Loc FROM Cards c JOIN Localizations_enUS l ON l.LocId = c.TitleId WHERE c.GrpId = ?",
                (grp,),
            ).fetchone()
            cache[grp] = r[0] if r else None
        return cache[grp]

    return name


def _det(a, key):
    for d in a.get("details", []):
        if d["key"] == key:
            vals = d.get("valueString") or d.get("valueInt32") or []
            return vals[0] if vals else None
    return None


def _verb(p, word):
    return word if p == "You" else word + "s"


class _Game:
    def __init__(self, num):
        self.num, self.obj, self.zones, self.life = num, {}, {}, {}
        self.turns, self.opening, self.on_play, self.result = [], None, None, None
        self.opp_cards = {}
        self.sideboard = None  # {"in": [...], "out": [...]} vs the deck used in the previous game
        self.mull_reqs, self.started = 0, False  # mulligan hands offered; True once real turn-1 play begins


def parse_games(paths, event):
    name = _lookups()
    matches, cur, pending, last_deck, blk = [], None, None, None, None

    def finish(m):
        if m is None:
            return None
        games = []
        for g in m["games"]:
            if not g.turns and not g.result:
                continue
            games.append({
                "game": g.num, "onPlay": g.on_play, "opening": g.opening or [],
                "turns": g.turns, "result": g.result, "opponentCards": list(g.opp_cards),
                "mulligans": max(g.mull_reqs - 1, 0), "sideboard": g.sideboard,
            })
        return {"match": m["n"], "result": m["result"], "games": games}

    for path in paths:
        for line in open(path, errors="replace"):
            if blk is not None:  # a pretty-printed client->GRE message: collect until the closing brace
                blk.append(line)
                if line.rstrip() == "}":
                    try:
                        payload = json.loads("".join(blk)).get("payload", {})
                        if payload.get("type", "").endswith("SubmitDeckResp") and cur is not None and cur.get("deck"):
                            new = payload["submitDeckResp"]["deck"]["deckCards"]
                            ins, outs = Counter(new) - Counter(cur["deck"]), Counter(cur["deck"]) - Counter(new)
                            fmt = lambda c: sorted(({"n": name(g) or "a card", "q": q} for g, q in c.items()), key=lambda x: x["n"])
                            cur["pending_sb"] = {"in": fmt(ins), "out": fmt(outs)} if ins or outs else None
                            cur["deck"] = new
                    except Exception:
                        pass
                    blk = None
                continue
            if "to Match: ClientToGremessage" in line:
                blk = []
                continue
            if "==> EventEnterPairing" in line:  # the room event itself has no event name; the pairing request does
                try:
                    pending = json.loads(json.loads(line[line.index("{"):])["request"]).get("EventName")
                except Exception:
                    pass
                continue
            if not line.startswith('{ "transactionId"'):
                continue
            if '"matchGameRoomStateChangedEvent"' in line:
                try:
                    ri = json.loads(line)["matchGameRoomStateChangedEvent"]["gameRoomInfo"]
                except Exception:
                    continue
                cfg, st = ri["gameRoomConfig"], ri["stateType"]
                if st.endswith("Playing") and (cur is None or cur["id"] != cfg["matchId"]):
                    cur = {"id": cfg["matchId"], "event": pending, "games": [], "result": None,
                           "me": None, "n": len(matches) + 1, "game": None, "deck": last_deck, "pending_sb": None}
                    matches.append(cur)
                elif st.endswith("MatchCompleted") and cur is not None:
                    for r in ri.get("finalMatchResult", {}).get("resultList", []):
                        if r["scope"] == "MatchScope_Match" and cur["me"]:
                            cur["result"] = "won" if r.get("winningTeamId") == cur["me"] else "lost"
                    cur = None
                continue
            if '"connectResp"' in line and '"greToClientEvent"' in line:  # deck registered for the match
                try:
                    for m in json.loads(line)["greToClientEvent"]["greToClientMessages"]:
                        if m["type"].endswith("ConnectResp"):
                            last_deck = m["connectResp"]["deckMessage"]["deckCards"]
                            if cur is not None and not cur["games"]:  # logged after the room opened: this match's deck
                                cur["deck"] = last_deck
                except Exception:
                    pass
                # no `continue`: the same line also carries the game's first state messages
            if cur is None or '"greToClientEvent"' not in line:
                continue
            try:
                msgs = json.loads(line)["greToClientEvent"]["greToClientMessages"]
            except Exception:
                continue
            for m in msgs:
                if cur["me"] is None and m.get("systemSeatIds"):
                    cur["me"] = m["systemSeatIds"][0]
                if m["type"].endswith("MulliganReq") and cur["game"] is not None:
                    cur["game"].mull_reqs += 1
                g = m.get("gameStateMessage")
                if g and cur["me"]:
                    _state(cur, g, name)

    out = [x for x in (finish(m) for m in matches if m["event"] == event) if x and x["games"]]
    for i, x in enumerate(out, 1):  # number within this event, not across every match in the logs
        x["match"] = i
    return out


def _state(cur, g, name):
    me = cur["me"]
    opp = 3 - me
    who = lambda seat: "You" if seat == me else "Opp"
    gi = g.get("gameInfo")
    if gi:
        if cur["game"] is None or gi.get("gameNumber") != cur["game"].num:
            cur["game"] = _Game(gi.get("gameNumber"))
            cur["game"].sideboard, cur["pending_sb"] = cur["pending_sb"], None
            cur["games"].append(cur["game"])
        if gi.get("stage") == "GameStage_GameOver" and cur["game"].result is None:
            rs = [r for r in gi.get("results", []) if r["scope"] == "MatchScope_Game"]
            if rs:
                cur["game"].result = {"winner": who(rs[-1].get("winningTeamId")),
                                      "reason": rs[-1]["reason"].replace("ResultReason_", "")}
    G = cur["game"]
    if G is None:
        return

    for z in g.get("zones", []):
        Z = G.zones.setdefault(z["zoneId"], {})
        Z["type"], Z["owner"] = z["type"].replace("ZoneType_", ""), z.get("ownerSeatId")
        if "objectInstanceIds" in z:
            Z["ids"] = z["objectInstanceIds"]

    attackers, blockers = {}, []
    for go in g.get("gameObjects", []):
        iid = go["instanceId"]
        prev = G.obj.get(iid, {})
        rec = {"grp": go.get("grpId") or prev.get("grp"), "owner": go.get("ownerSeatId", prev.get("owner")),
               "ctrl": go.get("controllerSeatId", prev.get("ctrl")),
               "type": go.get("type", "").replace("GameObjectType_", ""),
               "atk": go.get("attackState"), "blk": go.get("blockState")}
        if rec["atk"] == "AttackState_Declared" and prev.get("atk") != "AttackState_Declared":
            attackers.setdefault(rec["ctrl"], []).append(iid)
        if rec["blk"] == "BlockState_Declared" and prev.get("blk") != "BlockState_Declared":
            blockers.append((iid, go.get("blockInfo", {}).get("attackerIds", [])))
        G.obj[iid] = rec
        if rec["type"] == "Card" and rec["owner"] == opp and rec["grp"]:
            n = name(rec["grp"])
            if n:
                G.opp_cards.setdefault(n, None)
    for p in g.get("players", []):
        if "lifeTotal" in p:
            G.life.setdefault(p["systemSeatNumber"], p["lifeTotal"])

    def card(iid):
        rec = G.obj.get(iid)
        if not rec or not rec.get("grp"):
            return "a card"
        n = name(rec["grp"]) or "a card"
        return n if rec["type"] == "Token" or n == "a card" else "{{" + n + "}}"

    # Arena emits a turn-1 marker before the mulligans; real play starts once turnInfo reports turn 1.
    just_started = False
    if not G.started and (g.get("turnInfo", {}).get("turnNumber") or 0) >= 1:
        G.started = just_started = True
        hand = [z for z in G.zones.values() if z.get("type") == "Hand" and z.get("owner") == me]
        G.opening = [name(G.obj[i]["grp"]) for z in hand for i in z.get("ids", [])
                     if i in G.obj and G.obj[i].get("grp") and name(G.obj[i]["grp"])]

    def emit(text):
        if G.started and G.turns and (not G.turns[-1]["events"] or G.turns[-1]["events"][-1] != text):
            G.turns[-1]["events"].append(text)

    anns = g.get("annotations", [])
    for a in anns:  # id changes first, so later transfers resolve to the new instance
        if "AnnotationType_ObjectIdChanged" in a["type"]:
            o, n = _det(a, "orig_id"), _det(a, "new_id")
            if o in G.obj and n is not None:
                G.obj.setdefault(n, dict(G.obj[o]))

    for a in anns:
        T = {t.replace("AnnotationType_", "") for t in a["type"]}
        ids = a.get("affectedIds", [])
        if "NewTurnStarted" in T:
            ti = g.get("turnInfo", {})
            if not G.turns:
                G.on_play = who(ti.get("activePlayer"))
            G.turns.append({"turn": ti.get("turnNumber", len(G.turns) + 1), "who": who(ti.get("activePlayer")), "events": []})
        elif "ZoneTransfer" in T:
            cat = _det(a, "category")
            src = G.zones.get(_det(a, "zone_src"), {}).get("type")
            dst = G.zones.get(_det(a, "zone_dest"), {}).get("type")
            for i in ids:
                rec = G.obj.get(i, {})
                if rec.get("type") == "Ability" or dst in HIDDEN_ZONES or src == dst:
                    continue
                if just_started and src == "Hand" and dst == "Library":
                    continue  # London-mulligan bottoming lands in the message that starts play
                c, owner, ctrl = card(i), who(rec.get("owner")), who(rec.get("ctrl"))
                if cat == "PlayLand":
                    emit(f"{ctrl} {_verb(ctrl, 'play')} {c}")
                elif cat == "CastSpell":
                    emit(f"{ctrl} {_verb(ctrl, 'cast')} {c}")
                elif cat == "Resolve":
                    continue  # "X resolves" is noise: the cast line already says it happened
                elif cat == "Draw":
                    emit(f"You draw {c}" if owner == "You" else "Opp draws a card")
                elif cat == "Discard":
                    emit(f"{owner} {_verb(owner, 'discard')} {c}")
                elif cat == "Countered":
                    emit(f"{c} is countered")
                elif cat == "Sacrifice":
                    emit(f"{ctrl} {_verb(ctrl, 'sacrifice')} {c}")
                elif cat == "Destroy":
                    emit(f"{c} is destroyed")
                elif cat and cat.startswith("SBA_"):
                    emit(f"{c} dies")
                elif dst == "Exile":
                    emit(f"{c} is exiled")
                elif dst == "Battlefield":
                    emit(f"{c} returns to the battlefield" if src == "Graveyard" else f"{c} enters the battlefield")
                elif dst == "Hand":
                    emit(f"{owner} {_verb(owner, 'put')} {c} into hand" if src == "Library" else f"{c} returns to hand")
                elif dst == "Graveyard":
                    emit(f"{owner} {_verb(owner, 'mill')} {c}" if src == "Library" else f"{c} goes to the graveyard")
                elif dst == "Library":
                    emit(f"{c} goes to the library")
        elif "ModifiedLife" in T:
            seat, delta = ids[0], _det(a, "life")
            before = G.life.get(seat)
            if before is not None and delta:
                after = before + delta
                p = who(seat)
                emit(f"{p} {_verb(p, 'gain' if delta > 0 else 'lose')} {abs(delta)} life ({before} → {after})")
                G.life[seat] = after
        elif "DamageDealt" in T:
            dmg = _det(a, "damage")
            if dmg and ids:
                tgt = card(ids[0]) if ids[0] in G.obj else who(ids[0])
                emit(f"{card(a.get('affectorId'))} deals {dmg} damage to {tgt}")
        elif "TokenCreated" in T and ids:
            p = who(G.obj.get(ids[0], {}).get("owner"))
            emit(f"{p} {_verb(p, 'create')} {card(ids[0])}")
        elif "CounterAdded" in T and ids:
            n = _det(a, "transaction_amount") or 1
            emit(f"{card(ids[0])} gets {n} counter{'s' if n != 1 else ''}")

    for ctrl, ids in attackers.items():
        p = who(ctrl)
        emit(f"{p} {_verb(p, 'attack')} with " + ", ".join(card(i) for i in ids))
    for blocker, atk in blockers:
        emit(f"{card(blocker)} blocks " + ", ".join(card(i) for i in atk))
