// Builds a tiny synthetic Arena Player.log and card database for the specs.
//
// The log mimics the real line shapes (verified against a real draft) with made-up cards, so the specs need
// no Arena install, no network, and no personal data. It holds:
//
//   draft D1 (event "TestDraft"): pack 1 with 3 picks, pack 2 with 2 picks, a submitted deck, one best-of-3 match
//     game 1: you on the play, mulligan to 3, a land, a spell, Opp's turn (you get 2 poison counters), an attack
//             (a counter on a card, and one poison counter removed), you win
//     game 2: Opp on the play, you sideboard (Delta Sorcery out, Eta Charm in), Opp concedes
//   draft D2 (event "TestDraft2"): 1 pick, no deck, no matches
//
// The ConnectResp line in game 1 comes after the match-room "Playing" event and also carries the game's first
// state message. That is the shape a past bug mishandled (the parser skipped the whole line and lost the
// opening hand).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "../tools/arena.mjs";

export const ME_NAME = "TestMeName", OPP_NAME = "TestOppName"; // must never appear in any output

export const CARDS = { // grpId: [name, colors, types, cost]
  1: ["Alpha Land", "", "5", ""],
  2: ["Beta Bear", "5", "2", "o1oG"],
  3: ["Gamma Bolt", "4", "4", "oR"],
  4: ["Delta Sorcery", "2", "10", "o2oU"],
  5: ["Eta Charm", "3", "4", "oB"],
  6: ["Epsilon Land", "", "5", ""],
};

export const D1 = "D1", D2 = "D2";
export const EVENT = "TestDraft", EVENT2 = "TestDraft2";
const DECK = [1, 1, 2, 3, 4]; // as registered at match start
const DECK_AFTER_SIDEBOARD = [1, 1, 2, 3, 5];

export function buildCardDb(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE Cards (GrpId INT, TitleId INT, Colors TEXT, Types TEXT, OldSchoolManaText TEXT, Rarity INT)");
  db.exec("CREATE TABLE Localizations_enUS (LocId INT, Loc TEXT)");
  const card = db.prepare("INSERT INTO Cards VALUES (?,?,?,?,?,4)");
  const loc = db.prepare("INSERT INTO Localizations_enUS VALUES (?,?)");
  for (const [grp, [name, colors, types, cost]] of Object.entries(CARDS)) {
    card.run(Number(grp), 1000 + Number(grp), colors, types, cost);
    loc.run(1000 + Number(grp), name);
  }
  db.close();
}

/** Arena's JSON lines start with '{ ' (brace, space) before the first key. */
const jsonLine = obj => "{ " + JSON.stringify(obj).slice(1);
const gre = (...msgs) => jsonLine({ transactionId: "t", requestId: 1, timestamp: "1", greToClientEvent: { greToClientMessages: msgs } });
const state = (num, gs, seat = 1) => ({ type: "GREMessageType_GameStateMessage", systemSeatIds: [seat], msgId: num, gameStateId: num, gameStateMessage: gs });
const det = kv => Object.entries(kv).map(([key, v]) => typeof v === "string"
  ? { key, type: "KeyValuePairValueType_string", valueString: [v] }
  : { key, type: "KeyValuePairValueType_int32", valueInt32: [v] });
const zt = (id, ids, src, dst, category) => ({ id, affectedIds: ids, type: ["AnnotationType_ZoneTransfer"], details: det({ zone_src: src, zone_dest: dst, category }) });
const newTurn = id => ({ id, affectedIds: [], type: ["AnnotationType_NewTurnStarted"], details: [] });
const obj = (instanceId, grpId, owner, zoneId, extra = {}) => ({
  instanceId, grpId, type: "GameObjectType_Card", ownerSeatId: owner, controllerSeatId: owner, zoneId, visibility: "Visibility_Public", ...extra,
});
const zones = (handMe, { libMe = [], battlefield = [], stack = [], handOpp = [] } = {}) => [
  { zoneId: 31, type: "ZoneType_Hand", ownerSeatId: 1, objectInstanceIds: handMe },
  { zoneId: 32, type: "ZoneType_Library", ownerSeatId: 1, objectInstanceIds: libMe },
  { zoneId: 33, type: "ZoneType_Battlefield", objectInstanceIds: battlefield },
  { zoneId: 34, type: "ZoneType_Graveyard", ownerSeatId: 1, objectInstanceIds: [] },
  { zoneId: 35, type: "ZoneType_Stack", objectInstanceIds: stack },
  { zoneId: 36, type: "ZoneType_Hand", ownerSeatId: 2, objectInstanceIds: handOpp },
];
const PLAYERS = [{ systemSeatNumber: 1, lifeTotal: 20 }, { systemSeatNumber: 2, lifeTotal: 20 }];
const gameOver = (num, reason) => ({
  type: "GameStateType_Diff",
  gameInfo: { matchID: "M1", gameNumber: num, stage: "GameStage_GameOver",
    results: [{ scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason }] },
});

export function buildLog(path) {
  const L = [];
  const add = line => L.push(line);
  const notify = (draft, pack, pick, cards) => add("[UnityCrossThreadLogger]Draft.Notify " +
    JSON.stringify({ draftId: draft, SelfPick: pick, SelfPack: pack, PackCards: cards.join(",") }));
  const pick = (draft, pack, pk, grp) => add("[UnityCrossThreadLogger]==> EventPlayerDraftMakePick " +
    JSON.stringify({ id: "x", request: JSON.stringify({ DraftId: draft, GrpIds: [grp], Pack: pack, Pick: pk }) }));

  // --- draft D1: packs of picks (Arena logs each Draft.Notify twice) ---
  [[[1, 2, 3, 4], 1], [[2, 3, 4], 2], [[3, 4], 3]].forEach(([cards, chosen], i) => { notify(D1, 1, i + 1, cards); notify(D1, 1, i + 1, cards); pick(D1, 1, i + 1, chosen); });
  [[[5, 6, 2], 5], [[6, 2], 6]].forEach(([cards, chosen], i) => { notify(D1, 2, i + 1, cards); notify(D1, 2, i + 1, cards); pick(D1, 2, i + 1, chosen); });
  add("[UnityCrossThreadLogger]==> DraftCompleteDraft " + JSON.stringify({ id: "y", request: JSON.stringify({ EventName: EVENT, IsBotDraft: false }) }));
  const deck = {
    MainDeck: [{ cardId: 1, quantity: 2 }, { cardId: 2, quantity: 1 }, { cardId: 3, quantity: 1 }, { cardId: 4, quantity: 1 }],
    Sideboard: [{ cardId: 5, quantity: 1 }],
  };
  add("[UnityCrossThreadLogger]==> EventSetDeckV3 " + JSON.stringify({ id: "z", request: JSON.stringify({ EventName: EVENT, Summary: { DeckId: "d" }, Deck: deck }) }));

  // --- draft D2: one pick, no deck ---
  notify(D2, 1, 1, [1, 2]);
  pick(D2, 1, 1, 2);
  add("[UnityCrossThreadLogger]==> DraftCompleteDraft " + JSON.stringify({ id: "y2", request: JSON.stringify({ EventName: EVENT2, IsBotDraft: false }) }));

  // --- match M1 (best of 3) for D1's event ---
  add("[UnityCrossThreadLogger]==> EventEnterPairing " + JSON.stringify({ id: "p", request: JSON.stringify({ EventName: EVENT, EventCode: null }) }));
  const room = (stateType, extra = {}) => add(jsonLine({
    transactionId: "t", requestId: 2, timestamp: "1",
    matchGameRoomStateChangedEvent: { gameRoomInfo: {
      gameRoomConfig: { reservedPlayers: [
        { userId: "u1", playerName: ME_NAME, systemSeatId: 1 },
        { userId: "u2", playerName: OPP_NAME, systemSeatId: 2 }], matchId: "M1" },
      stateType, ...extra } },
  }));
  room("MatchGameRoomStateType_Playing");

  // game 1: ConnectResp + the first state + a mulligan prompt, all on ONE line (the past regression)
  const first = {
    type: "GameStateType_Full", gameInfo: { matchID: "M1", gameNumber: 1, stage: "GameStage_Start" },
    zones: zones([101, 102, 103, 104]),
    gameObjects: [obj(101, 1, 1, 31), obj(102, 2, 1, 31), obj(103, 3, 1, 31), obj(104, 4, 1, 31)],
    players: PLAYERS, turnInfo: { activePlayer: 1 }, annotations: [newTurn(1)],
  };
  add(gre({ type: "GREMessageType_ConnectResp", systemSeatIds: [1], msgId: 1, connectResp: { deckMessage: { deckCards: DECK, sideboardCards: [5] } } },
    state(2, first),
    { type: "GREMessageType_MulliganReq", systemSeatIds: [1], msgId: 3, mulliganReq: { mulliganType: "MulliganType_London" } }));
  add(gre({ type: "GREMessageType_MulliganReq", systemSeatIds: [1], msgId: 4, mulliganReq: { mulliganType: "MulliganType_London", mulliganCount: 1 } }));
  // play starts: turn 1 info appears in the same message that bottoms card 104 (must not be narrated)
  add(gre(state(5, { type: "GameStateType_Diff", turnInfo: { turnNumber: 1, activePlayer: 1 },
    zones: zones([101, 102, 103], { libMe: [104] }), annotations: [zt(2, [104], 31, 32, "Put")] })));
  // turn 1: land, spell, spell resolves (no narration for "resolves")
  add(gre(state(6, { type: "GameStateType_Diff", turnInfo: { turnNumber: 1, activePlayer: 1 },
    zones: zones([103], { battlefield: [101, 102] }),
    annotations: [zt(3, [101], 31, 33, "PlayLand"), zt(4, [102], 31, 35, "CastSpell"), zt(5, [102], 35, 33, "Resolve")] })));
  // turn 2: Opp plays a land
  add(gre(state(7, { type: "GameStateType_Diff", turnInfo: { turnNumber: 2, activePlayer: 2 },
    gameObjects: [obj(201, 6, 2, 36)], annotations: [newTurn(6), zt(7, [201], 36, 33, "PlayLand"),
      { id: 11, affectorId: 201, affectedIds: [1], type: ["AnnotationType_CounterAdded"], details: det({ counter_type: 3, transaction_amount: 2 }) }] })));
  // turn 3: Beta Bear attacks, deals 2, Opp loses 2
  add(gre(state(8, { type: "GameStateType_Diff", turnInfo: { turnNumber: 3, activePlayer: 1 },
    gameObjects: [obj(102, 2, 1, 33, { attackState: "AttackState_Declared" })],
    annotations: [newTurn(8),
      { id: 9, affectorId: 102, affectedIds: [2], type: ["AnnotationType_DamageDealt"], details: det({ damage: 2, type: 1 }) },
      { id: 10, affectedIds: [2], type: ["AnnotationType_ModifiedLife"], details: det({ life: -2 }) },
      { id: 12, affectorId: 102, affectedIds: [102], type: ["AnnotationType_CounterAdded"], details: det({ counter_type: 1, transaction_amount: 1 }) },
      { id: 13, affectorId: 102, affectedIds: [1], type: ["AnnotationType_CounterRemoved"], details: det({ counter_type: 3, transaction_amount: 1 }) }] })));
  add(gre(state(9, gameOver(1, "ResultReason_Game"))));

  // sideboarding: the client's reply is a pretty-printed multi-line block
  add("[UnityCrossThreadLogger]10/26/2026 5:54:34 PM: ABC to Match: ClientToGremessage");
  add(JSON.stringify({ requestId: 582, payload: { type: "ClientMessageType_SubmitDeckResp",
    submitDeckResp: { deck: { deckCards: DECK_AFTER_SIDEBOARD, sideboardCards: [4] } } } }, null, 2));

  // game 2: Opp on the play, you keep, Opp concedes
  const g2 = {
    type: "GameStateType_Full", gameInfo: { matchID: "M1", gameNumber: 2, stage: "GameStage_Start" },
    zones: zones([301]), gameObjects: [obj(301, 1, 1, 31)], players: PLAYERS, turnInfo: { activePlayer: 2 }, annotations: [newTurn(1)],
  };
  add(gre(state(10, g2), { type: "GREMessageType_MulliganReq", systemSeatIds: [1], msgId: 11, mulliganReq: { mulliganType: "MulliganType_London" } }));
  add(gre(state(12, { type: "GameStateType_Diff", turnInfo: { turnNumber: 1, activePlayer: 2 }, zones: zones([301]) })));
  add(gre(state(13, { type: "GameStateType_Diff", turnInfo: { turnNumber: 1, activePlayer: 2 },
    gameObjects: [obj(401, 6, 2, 36)], annotations: [zt(2, [401], 36, 33, "PlayLand")] })));
  add(gre(state(14, gameOver(2, "ResultReason_Concede"))));
  room("MatchGameRoomStateType_MatchCompleted", { finalMatchResult: { matchId: "M1", resultList: [
    { scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" },
    { scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Concede" },
    { scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Concede" }] } });

  writeFileSync(path, L.join("\n") + "\n");
}

/** Build both files in `directory`; returns their paths. */
export function buildFixture(directory) {
  const log = join(directory, "Player.log"), db = join(directory, "cards.sqlite");
  buildLog(log);
  buildCardDb(db);
  return { log, db };
}
