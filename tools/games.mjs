// Reconstruct game-by-game narration for a draft event from Arena's Player.log.
//
// Reads the GreToClientEvent game-state messages and matchGameRoomStateChangedEvent room events. Output is a
// list of matches; each has games; each game has turns of plain-text events. Card names are wrapped as
// {{Card Name}} so the viewer can attach hover images. The opponent is always just "Opp" (usernames are not kept).
import { findCardDb, lines, openCardDb } from "./arena.mjs";

const HIDDEN_ZONES = new Set(["Limbo", "Pending", "Revealed", "Command", "Sideboard"]);
// counter_type of a poison counter: in the real log it is the type on player seat 1 when an infect creature hit it.
const POISON_COUNTER = 3;

/**
 * grpId -> English name (or null), reading the card database lazily and remembering answers.
 * The database must stay open for the whole parse (and be closed explicitly): a handle nothing refers to is
 * garbage-collected, which finalizes its prepared statements out from under us.
 */
export function makeNamer() {
  const db = openCardDb(findCardDb());
  const stmt = db.prepare(
    "SELECT l.Loc FROM Cards c JOIN Localizations_enUS l ON l.LocId = c.TitleId WHERE c.GrpId = ?",
  );
  const cache = new Map();
  return {
    name: grp => {
      if (!cache.has(grp)) cache.set(grp, stmt.get(grp)?.Loc ?? null);
      return cache.get(grp);
    },
    close: () => db.close(),
  };
}

/** The first value of an annotation detail ("category", "zone_src", "life"...), or null. */
function det(a, key) {
  for (const d of a.details ?? []) {
    if (d.key === key) {
      const vals = d.valueString?.length ? d.valueString : d.valueInt32?.length ? d.valueInt32 : [];
      return vals.length ? vals[0] : null;
    }
  }
  return null;
}

const verb = (p, word) => (p === "You" ? word : word + "s");

const newGame = num => ({
  num, obj: new Map(), zones: new Map(), life: new Map(), poison: new Map(), turns: [], opening: null, onPlay: null, result: null,
  oppCards: new Set(), sideboard: null, // sideboard: { in, out } vs the deck used in the previous game
  mullReqs: 0, started: false,          // mulligan hands offered; true once real turn-1 play begins
});

/** Multiset difference: how many more of each id are in `a` than in `b`. */
function countDiff(a, b) {
  const have = new Map();
  for (const x of b) have.set(x, (have.get(x) ?? 0) + 1);
  const out = new Map();
  const count = new Map();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  for (const [x, n] of count) {
    const diff = n - (have.get(x) ?? 0);
    if (diff > 0) out.set(x, diff);
  }
  return out;
}

export async function parseGames(paths, event) {
  const namer = makeNamer();
  try {
    return await parseWith(paths, event, namer.name);
  } finally {
    namer.close();
  }
}

async function parseWith(paths, event, name) {
  const matches = [];
  let cur = null, pending = null, lastDeck = null, blk = null;

  const finish = m => ({
    match: m.n,
    result: m.result,
    games: m.games.filter(g => g.turns.length || g.result).map(g => ({
      game: g.num, onPlay: g.onPlay, opening: g.opening ?? [], turns: g.turns, result: g.result,
      opponentCards: [...g.oppCards], mulligans: Math.max(g.mullReqs - 1, 0), sideboard: g.sideboard,
    })),
  });

  for (const path of paths) {
    for await (const line of lines(path)) {
      if (blk !== null) { // a pretty-printed client->GRE message: collect until the closing brace
        blk.push(line);
        if (line.trimEnd() === "}") {
          try {
            const payload = JSON.parse(blk.join("\n")).payload ?? {};
            if ((payload.type ?? "").endsWith("SubmitDeckResp") && cur && cur.deck?.length) {
              const next = payload.submitDeckResp.deck.deckCards;
              const fmt = diff => [...diff].map(([g, q]) => ({ n: name(g) || "a card", q }))
                .sort((x, y) => (x.n < y.n ? -1 : x.n > y.n ? 1 : 0));
              const ins = countDiff(next, cur.deck), outs = countDiff(cur.deck, next);
              cur.pendingSb = ins.size || outs.size ? { in: fmt(ins), out: fmt(outs) } : null;
              cur.deck = next;
            }
          } catch { /* not a deck reply */ }
          blk = null;
        }
        continue;
      }
      if (line.includes("to Match: ClientToGremessage")) { blk = []; continue; }
      if (line.includes("==> EventEnterPairing")) { // the room event itself has no event name; the pairing request does
        try { pending = JSON.parse(JSON.parse(line.slice(line.indexOf("{"))).request).EventName ?? null; } catch { /* ignore */ }
        continue;
      }
      if (!line.startsWith('{ "transactionId"')) continue;

      if (line.includes('"matchGameRoomStateChangedEvent"')) {
        let ri;
        try { ri = JSON.parse(line).matchGameRoomStateChangedEvent.gameRoomInfo; } catch { continue; }
        const cfg = ri.gameRoomConfig, st = ri.stateType;
        if (st.endsWith("Playing") && (cur === null || cur.id !== cfg.matchId)) {
          cur = { id: cfg.matchId, event: pending, games: [], result: null, me: null, n: matches.length + 1,
            game: null, deck: lastDeck, pendingSb: null };
          matches.push(cur);
        } else if (st.endsWith("MatchCompleted") && cur) {
          for (const r of ri.finalMatchResult?.resultList ?? []) {
            if (r.scope === "MatchScope_Match" && cur.me) cur.result = r.winningTeamId === cur.me ? "won" : "lost";
          }
          cur = null;
        }
        continue;
      }

      if (line.includes('"connectResp"') && line.includes('"greToClientEvent"')) { // deck registered for the match
        try {
          for (const m of JSON.parse(line).greToClientEvent.greToClientMessages) {
            if (m.type.endsWith("ConnectResp")) {
              lastDeck = m.connectResp.deckMessage.deckCards;
              if (cur && !cur.games.length) cur.deck = lastDeck; // logged after the room opened: this match's deck
            }
          }
        } catch { /* ignore */ }
        // no `continue`: the same line also carries the game's first state messages
      }
      if (cur === null || !line.includes('"greToClientEvent"')) continue;
      let msgs;
      try { msgs = JSON.parse(line).greToClientEvent.greToClientMessages; } catch { continue; }
      for (const m of msgs) {
        if (cur.me === null && m.systemSeatIds?.length) cur.me = m.systemSeatIds[0];
        if (m.type.endsWith("MulliganReq") && cur.game !== null) cur.game.mullReqs += 1;
        if (m.gameStateMessage && cur.me) state(cur, m.gameStateMessage, name);
      }
    }
  }

  const out = matches.filter(m => m.event === event).map(finish).filter(x => x.games.length);
  out.forEach((x, i) => { x.match = i + 1; }); // number within this event, not across every match in the logs
  return out;
}

function state(cur, g, name) {
  const me = cur.me, opp = 3 - me;
  const who = seat => (seat === me ? "You" : "Opp");
  const gi = g.gameInfo;
  if (gi) {
    if (cur.game === null || gi.gameNumber !== cur.game.num) {
      cur.game = newGame(gi.gameNumber);
      cur.game.sideboard = cur.pendingSb;
      cur.pendingSb = null;
      cur.games.push(cur.game);
    }
    if (gi.stage === "GameStage_GameOver" && cur.game.result === null) {
      const rs = (gi.results ?? []).filter(r => r.scope === "MatchScope_Game");
      if (rs.length) {
        const last = rs.at(-1);
        cur.game.result = { winner: who(last.winningTeamId), reason: last.reason.replace("ResultReason_", "") };
      }
    }
  }
  const G = cur.game;
  if (G === null) return;

  for (const z of g.zones ?? []) {
    if (!G.zones.has(z.zoneId)) G.zones.set(z.zoneId, {});
    const Z = G.zones.get(z.zoneId);
    Z.type = z.type.replace("ZoneType_", "");
    Z.owner = z.ownerSeatId ?? null;
    if (z.objectInstanceIds !== undefined) Z.ids = z.objectInstanceIds;
  }

  const attackers = new Map(), blockers = [];
  for (const go of g.gameObjects ?? []) {
    const iid = go.instanceId;
    const prev = G.obj.get(iid) ?? {};
    const rec = {
      grp: go.grpId || prev.grp, owner: go.ownerSeatId ?? prev.owner, ctrl: go.controllerSeatId ?? prev.ctrl,
      type: (go.type ?? "").replace("GameObjectType_", ""), atk: go.attackState, blk: go.blockState,
    };
    if (rec.atk === "AttackState_Declared" && prev.atk !== "AttackState_Declared") {
      if (!attackers.has(rec.ctrl)) attackers.set(rec.ctrl, []);
      attackers.get(rec.ctrl).push(iid);
    }
    if (rec.blk === "BlockState_Declared" && prev.blk !== "BlockState_Declared") {
      blockers.push([iid, go.blockInfo?.attackerIds ?? []]);
    }
    G.obj.set(iid, rec);
    if (rec.type === "Card" && rec.owner === opp && rec.grp) {
      const n = name(rec.grp);
      if (n) G.oppCards.add(n);
    }
  }
  for (const p of g.players ?? []) {
    if (p.lifeTotal !== undefined && !G.life.has(p.systemSeatNumber)) G.life.set(p.systemSeatNumber, p.lifeTotal);
  }

  const card = iid => {
    const rec = G.obj.get(iid);
    if (!rec || !rec.grp) return "a card";
    const n = name(rec.grp) || "a card";
    return rec.type === "Token" || n === "a card" ? n : "{{" + n + "}}";
  };

  // Arena emits a turn-1 marker before the mulligans; real play starts once turnInfo reports turn 1.
  let justStarted = false;
  if (!G.started && (g.turnInfo?.turnNumber || 0) >= 1) {
    G.started = justStarted = true;
    const hands = [...G.zones.values()].filter(z => z.type === "Hand" && z.owner === me);
    G.opening = hands.flatMap(z => (z.ids ?? [])
      .filter(i => G.obj.has(i) && G.obj.get(i).grp && name(G.obj.get(i).grp))
      .map(i => name(G.obj.get(i).grp)));
  }

  const emit = text => {
    const t = G.turns.at(-1);
    if (G.started && t && (!t.events.length || t.events.at(-1) !== text)) t.events.push(text);
  };

  const anns = g.annotations ?? [];
  for (const a of anns) { // id changes first, so later transfers resolve to the new instance
    if (a.type.includes("AnnotationType_ObjectIdChanged")) {
      const o = det(a, "orig_id"), n = det(a, "new_id");
      if (G.obj.has(o) && n !== null && !G.obj.has(n)) G.obj.set(n, { ...G.obj.get(o) });
    }
  }

  for (const a of anns) {
    const T = new Set(a.type.map(t => t.replace("AnnotationType_", "")));
    const ids = a.affectedIds ?? [];
    if (T.has("NewTurnStarted")) {
      const ti = g.turnInfo ?? {};
      if (!G.turns.length) G.onPlay = who(ti.activePlayer);
      G.turns.push({ turn: ti.turnNumber ?? G.turns.length + 1, who: who(ti.activePlayer), events: [] });
    } else if (T.has("ZoneTransfer")) {
      const cat = det(a, "category");
      const src = G.zones.get(det(a, "zone_src"))?.type;
      const dst = G.zones.get(det(a, "zone_dest"))?.type;
      for (const i of ids) {
        const rec = G.obj.get(i) ?? {};
        if (rec.type === "Ability" || HIDDEN_ZONES.has(dst) || src === dst) continue;
        if (justStarted && src === "Hand" && dst === "Library") continue; // London-mulligan bottoming lands in the message that starts play
        const c = card(i), owner = who(rec.owner), ctrl = who(rec.ctrl);
        if (cat === "PlayLand") emit(`${ctrl} ${verb(ctrl, "play")} ${c}`);
        else if (cat === "CastSpell") emit(`${ctrl} ${verb(ctrl, "cast")} ${c}`);
        else if (cat === "Resolve") continue; // "X resolves" is noise: the cast line already says it happened
        else if (cat === "Draw") emit(owner === "You" ? `You draw ${c}` : "Opp draws a card");
        else if (cat === "Discard") emit(`${owner} ${verb(owner, "discard")} ${c}`);
        else if (cat === "Countered") emit(`${c} is countered`);
        else if (cat === "Sacrifice") emit(`${ctrl} ${verb(ctrl, "sacrifice")} ${c}`);
        else if (cat === "Destroy") emit(`${c} is destroyed`);
        else if (cat && cat.startsWith("SBA_")) emit(`${c} dies`);
        else if (dst === "Exile") emit(`${c} is exiled`);
        else if (dst === "Battlefield") emit(src === "Graveyard" ? `${c} returns to the battlefield` : `${c} enters the battlefield`);
        else if (dst === "Hand") emit(src === "Library" ? `${owner} ${verb(owner, "put")} ${c} into hand` : `${c} returns to hand`);
        else if (dst === "Graveyard") emit(src === "Library" ? `${owner} ${verb(owner, "mill")} ${c}` : `${c} goes to the graveyard`);
        else if (dst === "Library") emit(`${c} goes to the library`);
      }
    } else if (T.has("ModifiedLife")) {
      const seat = ids[0], delta = det(a, "life");
      const before = G.life.get(seat);
      if (before !== undefined && delta) {
        const after = before + delta, p = who(seat);
        emit(`${p} ${verb(p, delta > 0 ? "gain" : "lose")} ${Math.abs(delta)} life (${before} → ${after})`);
        G.life.set(seat, after);
      }
    } else if (T.has("DamageDealt")) {
      const dmg = det(a, "damage");
      if (dmg && ids.length) {
        const tgt = G.obj.has(ids[0]) ? card(ids[0]) : who(ids[0]);
        emit(`${card(a.affectorId)} deals ${dmg} damage to ${tgt}`);
      }
    } else if (T.has("TokenCreated") && ids.length) {
      const p = who(G.obj.get(ids[0])?.owner);
      emit(`${p} ${verb(p, "create")} ${card(ids[0])}`);
    } else if ((T.has("CounterAdded") || T.has("CounterRemoved")) && ids.length) {
      const n = det(a, "transaction_amount") || 1, added = T.has("CounterAdded"), target = ids[0], s = n !== 1 ? "s" : "";
      if (!G.obj.has(target) && (target === me || target === opp)) { // the target is a player's seat, not a permanent
        const p = who(target);
        if (det(a, "counter_type") === POISON_COUNTER) {
          G.poison.set(target, Math.max(0, (G.poison.get(target) ?? 0) + (added ? n : -n)));
          emit(`${p} ${verb(p, added ? "get" : "lose")} ${n} poison counter${s}`);
        } else {
          emit(`${p} ${verb(p, added ? "get" : "lose")} ${n} counter${s}`);
        }
      } else if (added) {
        emit(`${card(target)} gets ${n} counter${s}`);
      }
    }
  }

  for (const [ctrl, ids] of attackers) {
    const p = who(ctrl);
    emit(`${p} ${verb(p, "attack")} with ${ids.map(card).join(", ")}`);
  }
  for (const [blocker, atk] of blockers) emit(`${card(blocker)} blocks ${atk.map(card).join(", ")}`);
  const t = G.turns.at(-1);
  if (G.started && t && G.life.has(me) && G.life.has(opp)) { // end-of-turn life totals, shown in the turn headers
    t.life = { You: G.life.get(me), Opp: G.life.get(opp) };
    const poison = {}; // only players who have some, so most turns carry no poison key at all
    if ((G.poison.get(me) ?? 0) > 0) poison.You = G.poison.get(me);
    if ((G.poison.get(opp) ?? 0) > 0) poison.Opp = G.poison.get(opp);
    if (Object.keys(poison).length) t.poison = poison; else delete t.poison;
  }
}
