// Draft viewer, shared by every draft page. boot.js fetches a draft's data.json and calls startViewer(D).
// Editing this file (or viewer.css) changes every draft at once; no rebuild is needed.
const SKELETON = `<div class="wrap">
  <div><h1>Draft Replay</h1><div class="sub" id="sub"></div></div>
  <div class="bar">
    <div class="seg" id="packs" role="group" aria-label="Pack"></div>
    <label class="chk"><input type="checkbox" id="showPicks" checked> Show picks</label>
    <label class="chk" id="imgsWrap" hidden><input type="checkbox" id="imgs" checked> Card images</label>
  </div>
  <div class="picks" id="picks" role="group" aria-label="Pick"></div>
  <div class="main">
    <section><div class="head"><h2 id="title"></h2><div class="nav"><button id="prev">&larr; Prev</button><button id="next">Next &rarr;</button></div></div>
      <div class="grid" id="grid"></div><p class="hint">Arrow keys step through picks.</p></section>
    <aside><div class="sidehead"><h3 id="sideTitle">Picked so far</h3><button id="copy" hidden>Copy</button></div><ol id="pool"></ol><pre id="decktext" hidden></pre></aside>
  </div>
<p class="foot">Unofficial fan project. Card images via <a href="https://scryfall.com" style="color:inherit">Scryfall</a>; Magic: The Gathering is &copy; Wizards of the Coast.</p>
</div>

<img id="pop" class="pop" alt="" hidden>`;

function startViewer(D) {
  document.getElementById("app").innerHTML = SKELETON;
  document.title = `Draft ${D.number ? D.number + " \u00b7 " : ""}${D.event || "Replay"}`;
  const $ = id => document.getElementById(id);
  const byKey = new Map(D.picks.map(p => [p.pack + "-" + p.pick, p]));
  const packs = [...new Set(D.picks.map(p => p.pack))];
  let pack = 1, pick = 1, sort = "color", deckView = false, gamesView = false, gameIdx = 0;
  const lastPack = packs[packs.length - 1];
  const mv = c => { let n = 0; for (const m of (c.cost.match(/\{(\w)\}/g) || [])) { const v = m[1]; n += /\d/.test(v) ? +v : v === "X" ? 0 : 1; } return n; };
  const colorKey = c => c.colors.length > 1 ? "M" : (c.colors || (c.types.includes("Land") ? "L" : "C"));
  const ORDER = "WUBRGMCL";
  const cls = c => colorKey(c) === "L" ? "C" : colorKey(c);
  const el = (tag, klass, text) => { const e = document.createElement(tag); if (klass) e.className = klass; if (text != null) e.textContent = text; return e; };
  function sorted(cards) {
    const a = cards.map((c, i) => ({ c, i }));
    if (sort === "color") a.sort((x, y) => ORDER.indexOf(colorKey(x.c)) - ORDER.indexOf(colorKey(y.c)) || mv(x.c) - mv(y.c) || x.i - y.i);
    else if (sort === "cost") a.sort((x, y) => mv(x.c) - mv(y.c) || x.i - y.i);
    return a.map(x => x.c);
  }
  function cardEl(c, extra) {
    const d = el("div", "card " + cls(c) + (extra || ""));
    const n = el("div", "n", (c.qty > 1 ? c.qty + "\u00d7 " : "") + c.name);
    const t = el("div", "t"); t.append(el("span", null, c.types.join(" ")), el("span", null, c.cost));
    d.append(n, t); return d;
  }
  const hasImg = D.picks.some(p => p.cards.some(c => c.img));
  const imgOn = () => hasImg && $("imgs").checked;
  function imgEl(c, fallback) {
    // The name shows in a placeholder frame immediately; the image fades in over it once loaded.
    const ph = el("div", "ph"); ph.append(el("span", "phn", c.name));
    const i = el("img", "cimg"); i.alt = c.name; i.title = c.name; i.loading = "lazy";
    i.onload = () => { i.classList.add("ld"); ph.classList.add("ld"); }; i.onerror = () => ph.replaceWith(fallback());
    i.src = c.img; ph.append(i); return ph;
  }
  function imgCell(c, picked) {
    const d = el("div", "ci" + (picked ? " picked" : ""));
    d.append(c.img ? imgEl(c, () => cardEl(c)) : cardEl(c));
    if (picked) d.append(el("span", "tag", "Picked"));
    return d;
  }
  function stackCard(c) {
    const d = el("div", "sc"); d.append(c.img ? imgEl(c, () => deckChip(c)) : deckChip(c));
    if (c.qty > 1) d.append(el("span", "qty", "\u00d7" + c.qty));
    return d;
  }
  const GROUPS = ["Creatures", "Planeswalkers", "Instants", "Sorceries", "Artifacts & enchantments", "Lands"];
  const groupOf = c => c.types.includes("Land") ? "Lands" : c.types.includes("Creature") ? "Creatures" : c.types.includes("Planeswalker") ? "Planeswalkers"
    : c.types.includes("Instant") ? "Instants" : c.types.includes("Sorcery") ? "Sorceries" : "Artifacts & enchantments";
  const total = list => list.reduce((n, c) => n + c.qty, 0);
  const COLS = [["0\u20131", 1], ["2", 2], ["3", 3], ["4", 4], ["5", 5], ["6", 6], ["7+", 99]];
  function deckChip(c) {
    const d = el("div", "chip " + cls(c));
    d.append(el("span", "cn", c.name));
    if (c.qty > 1) d.append(el("span", "cc", "\u00d7" + c.qty));
    return d;
  }
  function deckText() {
    const line = c => `${c.qty} ${c.name}`;
    const nonland = D.deck.main.filter(c => !c.types.includes("Land")).sort((x, y) => mv(x) - mv(y) || x.name.localeCompare(y.name));
    const lands = D.deck.main.filter(c => c.types.includes("Land")).sort((x, y) => x.name.localeCompare(y.name));
    return ["Deck", ...nonland.map(line), ...lands.map(line), "", "Sideboard", ...D.deck.side.map(line)].join("\n");
  }
  const allGames = (D.games || []).flatMap(m => m.games.map(g => ({ m, g })));
  const bo1 = (D.games || []).every(m => m.games.length <= 1);
  const gameLabel = x => bo1 ? `Game ${x.m.match}` : `Match ${x.m.match} \u00b7 G${x.g.game}`;
  const won = x => x.g.result && x.g.result.winner === "You";
  function showPop(n, e) { const p = $("pop"); p.src = D.images[n]; p.hidden = false; movePop(e); }
  function movePop(e) { const p = $("pop"); p.style.left = Math.max(8, Math.min(e.clientX + 16, innerWidth - 256)) + "px"; p.style.top = Math.max(8, Math.min(e.clientY - 120, innerHeight - 350)) + "px"; }
  function hidePop() { $("pop").hidden = true; }
  function cref(n) { const s = el("span", "cref", n);
    if (D.images && D.images[n]) { s.onmouseenter = e => showPop(n, e); s.onmousemove = movePop; s.onmouseleave = hidePop; } return s; }
  function evEl(text) { const d = el("div", "ev"); text.split(/\{\{(.+?)\}\}/).forEach((part, i) => d.append(i % 2 ? cref(part) : document.createTextNode(part))); return d; }
  // Shareable links: #deck, #games, #game-<match>-<game>, #pick-<pack>-<pick> (pack 1 pick 1 is the plain URL)
  function currentHash() {
    if (gamesView) { const x = allGames[gameIdx]; return `#game-${x.m.match}-${x.g.game}`; }
    return deckView ? "#deck" : pack === 1 && pick === 1 ? "" : `#pick-${pack}-${pick}`;
  }
  function applyHash() {
    const h = location.hash; let m;
    deckView = gamesView = false;
    if (h === "#deck" && D.deck) { deckView = true; pack = lastPack; }
    else if (h === "#games" && allGames.length) { gamesView = true; gameIdx = 0; pack = lastPack; }
    else if ((m = h.match(/^#game-(\d+)-(\d+)$/)) && allGames.length) {
      const i = allGames.findIndex(x => x.m.match === +m[1] && x.g.game === +m[2]);
      if (i >= 0) { gamesView = true; gameIdx = i; pack = lastPack; } }
    else if ((m = h.match(/^#pick-(\d+)-(\d+)$/)) && byKey.has(m[1] + "-" + m[2])) { pack = +m[1]; pick = +m[2]; }
  }
  function renderGames() {
    const cur = allGames[gameIdx], g = cur.g;
    const wins = allGames.filter(won).length, losses = allGames.length - wins;
    const mw = D.games.filter(m => m.result === "won").length;
    $("title").textContent = bo1 ? `Games \u00b7 ${wins}\u2013${losses}` : `Games \u00b7 ${mw}\u2013${D.games.length - mw} in matches`;
    const wrap = el("div", "games"), tabs = el("div", "matchgroups");
    const tab = (x, i, label) => { const b = el("button", null, `${label} \u00b7 ${won(x) ? "W" : "L"}`);
      b.setAttribute("aria-pressed", i === gameIdx); b.onclick = () => { gameIdx = i; render(); }; return b; };
    if (bo1) { const row = el("div", "gametabs"); allGames.forEach((x, i) => row.append(tab(x, i, gameLabel(x)))); tabs.append(row); }
    else D.games.forEach(m => { const grp = el("div", "mgroup"), row = el("div", "gametabs");
      grp.append(el("div", "mlabel", `Match ${m.match} \u00b7 ${m.result === "won" ? "Won" : "Lost"}`));
      allGames.forEach((x, i) => { if (x.m === m) row.append(tab(x, i, `Game ${x.g.game}`)); });
      grp.append(row); tabs.append(grp); });
    const how = !g.result ? "unfinished" : g.result.reason === "Concede" ? `${g.result.winner === "You" ? "Opp" : "You"} conceded` : "played out";
    const meta = el("div", "gmeta", `On the play: ${g.onPlay || "?"} \u00b7 ${g.result ? (g.result.winner === "You" ? "You won" : "Opp won") : "No result"} (${how})`);
    wrap.append(tabs, meta);
    if (g.sideboard) { const sb = el("div", "sbbox"); sb.append(el("span", "ol", "Sideboarding"));
      for (const [label, list, k] of [["In", g.sideboard.in, "in"], ["Out", g.sideboard.out, "out"]]) { if (!list.length) continue;
        const row = el("div", "sbrow " + k); row.append(el("span", "sbl", (k === "in" ? "+ " : "\u2212 ") + label));
        list.forEach(x => { row.append(cref(x.n)); if (x.q > 1) row.append(el("span", "sbq", "\u00d7" + x.q)); }); sb.append(row); }
      wrap.append(sb); }
    if (g.opening.length) { const o = el("div", "open"), row = el("div", "openrow"); o.append(el("span", "ol", g.mulligans ? `Opening hand \u00b7 mulligan to ${g.opening.length}` : "Opening hand"), row);
      g.opening.forEach(n => { const img = D.images && D.images[n];
        if (!img) { row.append(cref(n)); return; }
        const c = imgEl({ name: n, img }, () => cref(n));
        c.onmouseenter = e => showPop(n, e); c.onmousemove = movePop; c.onmouseleave = hidePop; row.append(c); });
      wrap.append(o); }
    for (const t of g.turns) { const s = el("section", "turn " + (t.who === "You" ? "you" : "opp"));
      s.append(el("h3", "th", `Turn ${Math.ceil(t.turn / 2)} \u00b7 ${t.who}`)); // Arena counts each player's turn; show rounds
      if (t.events.length) t.events.forEach(e => s.append(evEl(e))); else s.append(el("div", "ev quiet", "No actions"));
      wrap.append(s); }
    const end = el("div", "gend " + (won(cur) ? "win" : "loss"),
      g.result ? `Game over \u00b7 ${g.result.winner === "You" ? "You win" : "Opp wins"} (${how})` : "Game over \u00b7 no result recorded");
    wrap.append(end);
    $("grid").replaceChildren(wrap);
    $("grid").classList.add("deckmode");
    $("pool").replaceChildren(...g.opponentCards.map(n => { const li = el("li"); li.append(el("span", null, ""), cref(n)); return li; }));
  }
  function renderDeck() {
    $("title").textContent = `Final deck \u00b7 ${total(D.deck.main)} main, ${total(D.deck.side)} sideboard`;
    const byColor = (x, y) => ORDER.indexOf(colorKey(x)) - ORDER.indexOf(colorKey(y)) || x.name.localeCompare(y.name);
    const spells = D.deck.main.filter(c => !c.types.includes("Land")), lands = D.deck.main.filter(c => c.types.includes("Land"));
    const cols = COLS.map(([label, max], i) => {
      const prev = i ? COLS[i - 1][1] : -1;
      return { label, cards: spells.filter(c => mv(c) > prev && mv(c) <= max).sort(byColor) };
    }).filter(c => c.cards.length);
    const peak = Math.max(...cols.map(c => total(c.cards)));
    const curve = el("div", "curve");
    for (const c of cols) { const n = total(c.cards), col = el("div", "cv");
      const bar = el("div", "bar"); bar.style.height = Math.round(n / peak * 56) + "px";
      col.append(el("span", "num", String(n)), bar, el("span", "lbl", c.label)); curve.append(col); }
    const row = el("div", "dcols"), on = imgOn();
    const addCol = (label, cards, n) => { const col = el("div", "dcol" + (on ? " stack" : "")); col.append(el("h3", "grp", `${label} (${n})`));
      cards.forEach(c => col.append(on ? stackCard(c) : deckChip(c))); row.append(col); };
    for (const c of cols) addCol(c.label === "7+" ? "7+" : "MV " + c.label, c.cards, total(c.cards));
    addCol("Lands", lands.sort(byColor), total(lands));
    const side = el("div", "dcol side"); side.append(el("h3", "grp", `Sideboard (${total(D.deck.side)})`));
    const sg = el("div", "sidegrid" + (on ? " sideimgs" : "")); D.deck.side.slice().sort((x, y) => mv(x) - mv(y) || byColor(x, y)).forEach(c => sg.append(on ? stackCard(c) : deckChip(c))); side.append(sg);
    const wrap = el("div", "deck"); wrap.append(curve, row, side);
    $("grid").replaceChildren(wrap);
    $("grid").classList.add("deckmode");
  }
  // Warm the browser cache with the next pack's card images once a pack is open: pick order, a few at a time, when idle.
  const preloaded = new Set();
  function preloadPack(n) {
    if (typeof Image === "undefined" || (typeof navigator !== "undefined" && navigator.connection && navigator.connection.saveData)) return;
    const urls = [];
    for (const p of D.picks) if (p.pack === n) for (const c of p.cards) if (c.img && !preloaded.has(c.img)) { preloaded.add(c.img); urls.push(c.img); }
    let i = 0;
    const next = () => { if (i >= urls.length) return; const im = new Image(); im.onload = im.onerror = next; im.src = urls[i++]; };
    const start = () => { for (let k = 0; k < 3; k++) next(); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(start); else setTimeout(start, 300);
  }
  function render() {
    const show = $("showPicks").checked;
    $("grid").classList.remove("deckmode"); $("grid").classList.remove("imgs"); $("imgsWrap").hidden = !hasImg;
    if (gamesView) renderGames();
    else if (deckView) renderDeck();
    else {
      const p = byKey.get(pack + "-" + pick);
      $("title").textContent = `Pack ${pack}, pick ${pick} \u00b7 ${p.cards.length} card${p.cards.length > 1 ? "s" : ""}`;
      if (imgOn()) { $("grid").classList.add("imgs"); $("grid").replaceChildren(...sorted(p.cards).map(c => imgCell(c, show && c.name === p.picked))); }
      else $("grid").replaceChildren(...sorted(p.cards).map(c => cardEl(c, (c.name === p.picked ? " picked" : "") + (show ? " show" : ""))));
    }
    $("sideTitle").textContent = gamesView ? "Opponent\u2019s cards" : deckView ? "Decklist" : "Picked so far";
    $("pool").hidden = deckView; $("decktext").hidden = !deckView; $("copy").hidden = !deckView;
    if (deckView) $("decktext").textContent = deckText();
    if (!deckView && !gamesView && imgOn() && pack < lastPack) preloadPack(pack + 1);
    const pool = deckView || gamesView ? [] : D.picks.filter(q => q.pack < pack || (q.pack === pack && q.pick < pick) || (show && q.pack === pack && q.pick === pick));
    if (!gamesView) $("pool").replaceChildren(...pool.map(q => { const li = el("li");
      li.append(el("span", null, `${q.pack}.${q.pick}`), el("span", null, q.picked)); return li; }));
    for (const b of $("packs").children) b.setAttribute("aria-pressed", b.dataset.p === "deck" ? deckView : b.dataset.p === "games" ? gamesView : !deckView && !gamesView && +b.dataset.p === pack);
    try { history.replaceState(null, "", currentHash() || location.pathname + location.search); } catch (e) {}
    const n = D.picks.filter(q => q.pack === pack).length;
    const btns = Array.from({ length: n }, (_, i) => { const b = el("button", null, String(i + 1));
      b.setAttribute("aria-label", `Pick ${i + 1}`); b.setAttribute("aria-pressed", !deckView && !gamesView && i + 1 === pick);
      b.onclick = () => { deckView = gamesView = false; pick = i + 1; render(); }; return b; });
    $("picks").replaceChildren(...btns);
    const idx = gamesView ? D.picks.length + 1 : deckView ? D.picks.length : D.picks.indexOf(byKey.get(pack + "-" + pick));
    const lastIdx = D.picks.length - 1 + (D.deck ? 1 : 0) + (allGames.length ? 1 : 0);
    $("prev").disabled = idx === 0; $("next").disabled = idx === lastIdx;
  }
  function step(d) {
    const idx = gamesView ? D.picks.length + 1 : deckView ? D.picks.length : D.picks.indexOf(byKey.get(pack + "-" + pick));
    const i = idx + d;
    if (i === D.picks.length && D.deck) { deckView = true; gamesView = false; pack = lastPack; render(); return; }
    if (i === D.picks.length + 1 && allGames.length) { gamesView = true; deckView = false; pack = lastPack; render(); return; }
    const q = D.picks[i]; if (q) { deckView = gamesView = false; pack = q.pack; pick = q.pick; render(); }
  }
  $("sub").textContent = `${D.event || "Draft"} \u00b7 ${D.picks.length} picks \u00b7 ${D.draftId}`;
  const packBtns = packs.map(n => { const b = el("button", null, "Pack " + n); b.dataset.p = n;
    b.onclick = () => { deckView = gamesView = false; pack = n; pick = 1; render(); }; return b; });
  if (D.deck) { const b = el("button", null, "Deck"); b.dataset.p = "deck";
    b.onclick = () => { deckView = true; gamesView = false; pack = lastPack; render(); }; packBtns.push(b); }
  if (allGames.length) { const b = el("button", null, "Games"); b.dataset.p = "games";
    b.onclick = () => { gamesView = true; deckView = false; pack = lastPack; render(); }; packBtns.push(b); }
  $("packs").replaceChildren(...packBtns);
  applyHash();
  if (typeof window !== "undefined") window.addEventListener("hashchange", () => { applyHash(); render(); });
  $("copy").onclick = async () => { const b = $("copy");
    try { await navigator.clipboard.writeText($("decktext").textContent); b.textContent = "Copied"; }
    catch (e) { const r = document.createRange(); r.selectNodeContents($("decktext")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = "Selected"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500); };
  $("showPicks").onchange = render; $("imgs").onchange = render; $("prev").onclick = () => step(-1); $("next").onclick = () => step(1);
  document.addEventListener("keydown", e => { if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1); });
  render();
  return { step, st: () => ({ deckView, gamesView, gameIdx, pack, pick }) };  // st() is read by the specs
}

if (typeof module !== "undefined") module.exports = { startViewer };  // lets the specs load this file
