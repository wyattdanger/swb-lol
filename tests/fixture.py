"""Builds a tiny synthetic Arena Player.log and card database for the tests.

The log mimics the real line shapes (verified against a real draft) with made-up cards,
so the tests need no Arena install, no network, and no personal data. It holds:

  draft D1 (event "TestDraft"): pack 1 with 3 picks, pack 2 with 2 picks, a submitted deck, one best-of-3 match
    game 1: you on the play, mulligan to 3, a land, a spell, Opp's turn, an attack, you win
    game 2: Opp on the play, you sideboard (Delta Sorcery out, Eta Charm in), Opp concedes
  draft D2 (event "TestDraft2"): 1 pick, no deck, no matches

The ConnectResp line in game 1 comes after the match-room "Playing" event and also carries
the game's first state message. That is the shape a past bug mishandled (the parser skipped
the whole line and lost the opening hand).
"""
import json
import os
import sqlite3

ME_NAME, OPP_NAME = "TestMeName", "TestOppName"  # must never appear in any output

CARDS = {  # grpId: (name, colors, types, cost)
    1: ("Alpha Land", "", "5", ""),
    2: ("Beta Bear", "5", "2", "o1oG"),
    3: ("Gamma Bolt", "4", "4", "oR"),
    4: ("Delta Sorcery", "2", "10", "o2oU"),
    5: ("Eta Charm", "3", "4", "oB"),
    6: ("Epsilon Land", "", "5", ""),
}

D1, D2 = "D1", "D2"
EVENT, EVENT2 = "TestDraft", "TestDraft2"
DECK = [1, 1, 2, 3, 4]  # as registered at match start
DECK_AFTER_SIDEBOARD = [1, 1, 2, 3, 5]


def build_card_db(path):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE Cards (GrpId INT, TitleId INT, Colors TEXT, Types TEXT, OldSchoolManaText TEXT, Rarity INT)")
    con.execute("CREATE TABLE Localizations_enUS (LocId INT, Loc TEXT)")
    for grp, (name, colors, types, cost) in CARDS.items():
        con.execute("INSERT INTO Cards VALUES (?,?,?,?,?,4)", (grp, 1000 + grp, colors, types, cost))
        con.execute("INSERT INTO Localizations_enUS VALUES (?,?)", (1000 + grp, name))
    con.commit()
    con.close()


def _json_line(obj):
    """Arena's JSON lines start with '{ ' (brace, space) before the first key."""
    return "{ " + json.dumps(obj)[1:]


def _gre(*msgs):
    return _json_line({"transactionId": "t", "requestId": 1, "timestamp": "1",
                       "greToClientEvent": {"greToClientMessages": list(msgs)}})


def _state(num, gs, seat=1):
    return {"type": "GREMessageType_GameStateMessage", "systemSeatIds": [seat], "msgId": num,
            "gameStateId": num, "gameStateMessage": gs}


def _det(**kv):
    out = []
    for k, v in kv.items():
        out.append({"key": k, "type": "KeyValuePairValueType_string", "valueString": [v]} if isinstance(v, str)
                   else {"key": k, "type": "KeyValuePairValueType_int32", "valueInt32": [v]})
    return out


def _zt(aid, ids, src, dst, category):
    return {"id": aid, "affectedIds": ids, "type": ["AnnotationType_ZoneTransfer"],
            "details": _det(zone_src=src, zone_dest=dst, category=category)}


def _new_turn(aid):
    return {"id": aid, "affectedIds": [], "type": ["AnnotationType_NewTurnStarted"], "details": []}


def _obj(iid, grp, owner, zone, **extra):
    return {"instanceId": iid, "grpId": grp, "type": "GameObjectType_Card", "ownerSeatId": owner,
            "controllerSeatId": owner, "zoneId": zone, "visibility": "Visibility_Public", **extra}


def _zones(hand_me, lib_me=(), battlefield=(), stack=(), hand_opp=()):
    return [
        {"zoneId": 31, "type": "ZoneType_Hand", "ownerSeatId": 1, "objectInstanceIds": list(hand_me)},
        {"zoneId": 32, "type": "ZoneType_Library", "ownerSeatId": 1, "objectInstanceIds": list(lib_me)},
        {"zoneId": 33, "type": "ZoneType_Battlefield", "objectInstanceIds": list(battlefield)},
        {"zoneId": 34, "type": "ZoneType_Graveyard", "ownerSeatId": 1, "objectInstanceIds": []},
        {"zoneId": 35, "type": "ZoneType_Stack", "objectInstanceIds": list(stack)},
        {"zoneId": 36, "type": "ZoneType_Hand", "ownerSeatId": 2, "objectInstanceIds": list(hand_opp)},
    ]


PLAYERS = [{"systemSeatNumber": 1, "lifeTotal": 20}, {"systemSeatNumber": 2, "lifeTotal": 20}]


def _game_over(num, reason):
    return {"type": "GameStateType_Diff",
            "gameInfo": {"matchID": "M1", "gameNumber": num, "stage": "GameStage_GameOver",
                         "results": [{"scope": "MatchScope_Game", "result": "ResultType_WinLoss",
                                      "winningTeamId": 1, "reason": reason}]}}


def build_log(path):
    L = []
    add = L.append
    notify = lambda draft, pack, pick, cards: add(
        "[UnityCrossThreadLogger]Draft.Notify " + json.dumps(
            {"draftId": draft, "SelfPick": pick, "SelfPack": pack, "PackCards": ",".join(map(str, cards))}))
    pick = lambda draft, pack, pk, grp: add(
        "[UnityCrossThreadLogger]==> EventPlayerDraftMakePick " + json.dumps(
            {"id": "x", "request": json.dumps({"DraftId": draft, "GrpIds": [grp], "Pack": pack, "Pick": pk})}))

    # --- draft D1: three picks (Arena logs each Draft.Notify twice) ---
    for pk, (cards, chosen) in enumerate([([1, 2, 3, 4], 1), ([2, 3, 4], 2), ([3, 4], 3)], start=1):
        notify(D1, 1, pk, cards)
        notify(D1, 1, pk, cards)
        pick(D1, 1, pk, chosen)
    for pk, (cards, chosen) in enumerate([([5, 6, 2], 5), ([6, 2], 6)], start=1):
        notify(D1, 2, pk, cards)
        notify(D1, 2, pk, cards)
        pick(D1, 2, pk, chosen)
    add("[UnityCrossThreadLogger]==> DraftCompleteDraft " + json.dumps(
        {"id": "y", "request": json.dumps({"EventName": EVENT, "IsBotDraft": False})}))
    deck = {"MainDeck": [{"cardId": 1, "quantity": 2}, {"cardId": 2, "quantity": 1}, {"cardId": 3, "quantity": 1},
                         {"cardId": 4, "quantity": 1}],
            "Sideboard": [{"cardId": 5, "quantity": 1}]}
    add("[UnityCrossThreadLogger]==> EventSetDeckV3 " + json.dumps(
        {"id": "z", "request": json.dumps({"EventName": EVENT, "Summary": {"DeckId": "d"}, "Deck": deck})}))

    # --- draft D2: one pick, no deck ---
    notify(D2, 1, 1, [1, 2])
    pick(D2, 1, 1, 2)
    add("[UnityCrossThreadLogger]==> DraftCompleteDraft " + json.dumps(
        {"id": "y2", "request": json.dumps({"EventName": EVENT2, "IsBotDraft": False})}))

    # --- match M1 (best of 3) for D1's event ---
    add("[UnityCrossThreadLogger]==> EventEnterPairing " + json.dumps(
        {"id": "p", "request": json.dumps({"EventName": EVENT, "EventCode": None})}))
    room = lambda state, **extra: add(_json_line({
        "transactionId": "t", "requestId": 2, "timestamp": "1",
        "matchGameRoomStateChangedEvent": {"gameRoomInfo": {
            "gameRoomConfig": {"reservedPlayers": [
                {"userId": "u1", "playerName": ME_NAME, "systemSeatId": 1},
                {"userId": "u2", "playerName": OPP_NAME, "systemSeatId": 2}], "matchId": "M1"},
            "stateType": state, **extra}}}))
    room("MatchGameRoomStateType_Playing")

    # game 1: ConnectResp + the first state + a mulligan prompt, all on ONE line (the past regression)
    first = {"type": "GameStateType_Full",
             "gameInfo": {"matchID": "M1", "gameNumber": 1, "stage": "GameStage_Start"},
             "zones": _zones([101, 102, 103, 104]),
             "gameObjects": [_obj(101, 1, 1, 31), _obj(102, 2, 1, 31), _obj(103, 3, 1, 31), _obj(104, 4, 1, 31)],
             "players": PLAYERS, "turnInfo": {"activePlayer": 1}, "annotations": [_new_turn(1)]}
    add(_gre({"type": "GREMessageType_ConnectResp", "systemSeatIds": [1], "msgId": 1,
              "connectResp": {"deckMessage": {"deckCards": DECK, "sideboardCards": [5]}}},
             _state(2, first),
             {"type": "GREMessageType_MulliganReq", "systemSeatIds": [1], "msgId": 3,
              "mulliganReq": {"mulliganType": "MulliganType_London"}}))
    add(_gre({"type": "GREMessageType_MulliganReq", "systemSeatIds": [1], "msgId": 4,
              "mulliganReq": {"mulliganType": "MulliganType_London", "mulliganCount": 1}}))
    # play starts: turn 1 info appears in the same message that bottoms card 104 (must not be narrated)
    add(_gre(_state(5, {"type": "GameStateType_Diff", "turnInfo": {"turnNumber": 1, "activePlayer": 1},
                        "zones": _zones([101, 102, 103], lib_me=[104]),
                        "annotations": [_zt(2, [104], 31, 32, "Put")]})))
    # turn 1: land, spell, spell resolves (no narration for "resolves")
    add(_gre(_state(6, {"type": "GameStateType_Diff", "turnInfo": {"turnNumber": 1, "activePlayer": 1},
                        "zones": _zones([103], battlefield=[101, 102]),
                        "annotations": [_zt(3, [101], 31, 33, "PlayLand"), _zt(4, [102], 31, 35, "CastSpell"),
                                        _zt(5, [102], 35, 33, "Resolve")]})))
    # turn 2: Opp plays a land
    add(_gre(_state(7, {"type": "GameStateType_Diff", "turnInfo": {"turnNumber": 2, "activePlayer": 2},
                        "gameObjects": [_obj(201, 6, 2, 36)],
                        "annotations": [_new_turn(6), _zt(7, [201], 36, 33, "PlayLand")]})))
    # turn 3: Beta Bear attacks, deals 2, Opp loses 2
    add(_gre(_state(8, {"type": "GameStateType_Diff", "turnInfo": {"turnNumber": 3, "activePlayer": 1},
                        "gameObjects": [_obj(102, 2, 1, 33, attackState="AttackState_Declared")],
                        "annotations": [_new_turn(8),
                                        {"id": 9, "affectorId": 102, "affectedIds": [2],
                                         "type": ["AnnotationType_DamageDealt"], "details": _det(damage=2, type=1)},
                                        {"id": 10, "affectedIds": [2], "type": ["AnnotationType_ModifiedLife"],
                                         "details": _det(life=-2)}]})))
    add(_gre(_state(9, _game_over(1, "ResultReason_Game"))))

    # sideboarding: the client's reply is a pretty-printed multi-line block
    add("[UnityCrossThreadLogger]10/26/2026 5:54:34 PM: ABC to Match: ClientToGremessage")
    add(json.dumps({"requestId": 582, "payload": {"type": "ClientMessageType_SubmitDeckResp", "submitDeckResp": {
        "deck": {"deckCards": DECK_AFTER_SIDEBOARD, "sideboardCards": [4]}}}}, indent=2))

    # game 2: Opp on the play, you keep, Opp concedes
    g2 = {"type": "GameStateType_Full", "gameInfo": {"matchID": "M1", "gameNumber": 2, "stage": "GameStage_Start"},
          "zones": _zones([301]), "gameObjects": [_obj(301, 1, 1, 31)], "players": PLAYERS,
          "turnInfo": {"activePlayer": 2}, "annotations": [_new_turn(1)]}
    add(_gre(_state(10, g2), {"type": "GREMessageType_MulliganReq", "systemSeatIds": [1], "msgId": 11,
                              "mulliganReq": {"mulliganType": "MulliganType_London"}}))
    add(_gre(_state(12, {"type": "GameStateType_Diff", "turnInfo": {"turnNumber": 1, "activePlayer": 2},
                         "zones": _zones([301])})))
    add(_gre(_state(13, {"type": "GameStateType_Diff", "turnInfo": {"turnNumber": 1, "activePlayer": 2},
                         "gameObjects": [_obj(401, 6, 2, 36)],
                         "annotations": [_zt(2, [401], 36, 33, "PlayLand")]})))
    add(_gre(_state(14, _game_over(2, "ResultReason_Concede"))))
    room("MatchGameRoomStateType_MatchCompleted", finalMatchResult={
        "matchId": "M1", "resultList": [
            {"scope": "MatchScope_Game", "result": "ResultType_WinLoss", "winningTeamId": 1, "reason": "ResultReason_Game"},
            {"scope": "MatchScope_Game", "result": "ResultType_WinLoss", "winningTeamId": 1, "reason": "ResultReason_Concede"},
            {"scope": "MatchScope_Match", "result": "ResultType_WinLoss", "winningTeamId": 1, "reason": "ResultReason_Concede"}]})

    with open(path, "w") as f:
        f.write("\n".join(L) + "\n")


def build_all(directory):
    log, db = os.path.join(directory, "Player.log"), os.path.join(directory, "cards.sqlite")
    build_log(log)
    build_card_db(db)
    return log, db
