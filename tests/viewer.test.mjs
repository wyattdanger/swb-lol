// Specs for the viewer page script (assets/viewer.js, assets/boot.js) and the draft page shell.
// Run with tests/run.sh.
//
// The real page script runs against a tiny stub DOM, fed by the same synthetic draft the other specs use
// (tests/fixture.mjs), so nothing here needs a browser, Arena, or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDraftData, parseDrafts } from '../tools/draft-replay.mjs';
import { buildFixture } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = fs.readFileSync(path.join(ROOT, 'assets', 'viewer.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(ROOT, 'assets', 'boot.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'tools', 'shell.html'), 'utf8');
const imgUrl = name => `https://img.test/${encodeURIComponent(name)}.jpg`;

async function fixtureData() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-spec-'));
  const { log, db } = buildFixture(tmp);
  process.env.ARENA_CARD_DB = db;
  const drafts = await parseDrafts([log]);
  const D = JSON.parse(JSON.stringify(await buildDraftData(drafts.get('D1'), 'D1', { logs: [log], noImages: true })));
  // give every card an image so the image code paths run
  for (const p of D.picks) for (const c of p.cards) c.img = imgUrl(c.name);
  for (const z of ['main', 'side']) for (const c of D.deck[z]) c.img = imgUrl(c.name);
  const names = new Set(JSON.stringify(D.games).match(/\{\{.+?\}\}/g)?.map(s => s.slice(2, -2)));
  for (const m of D.games) for (const g of m.games) {
    g.opening.concat(g.opponentCards).forEach(n => names.add(n));
    for (const x of [...(g.sideboard?.in || []), ...(g.sideboard?.out || [])]) names.add(x.n);
  }
  D.images = Object.fromEntries([...names].map(n => [n, imgUrl(n)]));
  fs.rmSync(tmp, { recursive: true, force: true });
  return D;
}
const DATA = await fixtureData();
const clone = o => JSON.parse(JSON.stringify(o));

// ---- stub DOM + page loader -------------------------------------------------------------------
function load(D, { hash = '', saveData = false, touch = false } = {}) {
  const els = {}, urls = [], listeners = {}, docListeners = {}, preloaded = [], scrolls = [];
  const mk = tag => ({
    tag, style: {}, children: [], _a: {}, dataset: {}, hidden: false, className: '', textContent: '', checked: true,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } },
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    setAttribute(k, v) { this._a[k] = v; }, replaceWith() {},
  });
  const doc = {
    getElementById: id => els[id] ?? (els[id] = mk('#' + id)),
    createElement: t => mk(t), createTextNode: t => ({ tag: '#text', textContent: t }), addEventListener(type, f) { docListeners[type] = f; },
  };
  class FakeImage { set src(v) { preloaded.push(v); if (this.onload) this.onload(); } }
  const loc = { hash, pathname: '/drafts/1/', search: '' };
  const mod = { exports: {} };
  new Function('module', 'document', 'scrollTo', 'location', 'history', 'innerWidth', 'innerHeight', 'window', 'Image',
    'requestIdleCallback', 'navigator', 'matchMedia', VIEWER)(
    mod, doc, (...a) => scrolls.push(a), loc, { replaceState(a, b, u) { urls.push(u); } }, 1200, 800,
    { addEventListener(n, f) { listeners[n] = f; } }, FakeImage, f => f(), { connection: { saveData } },
    q => ({ matches: touch && q.includes('hover: none') }));
  const api = mod.exports.startViewer(D);
  return { els, api, urls, loc, listeners, docListeners, preloaded, scrolls };
}

const text = n => (n.tag === '#text' ? n.textContent : [n.textContent, ...(n.children || []).map(text)].join(''));
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach(c => all(c, pred, out)); return out; };
const imgs = n => all(n, x => x.tag === 'img').length;
const last = v => v.urls[v.urls.length - 1];
const games = v => v.els.grid.children[0];                      // the .games wrapper
const groups = v => games(v).children[0].children;              // match groups (or one flat row)
const turns = v => games(v).children.filter(c => c.className.startsWith('turn'));
const boxes = v => games(v).children.map(c => c.className);
const clickGame = (v, m, g) => groups(v)[m].children[1].children[g].onclick();

// ---- navigation ------------------------------------------------------------------------------
test('top bar lists the packs, then Deck, then Games, and has no sort control', () => {
  const v = load(DATA);
  assert.deepEqual(v.els.packs.children.map(b => b.textContent), ['Pack 1', 'Pack 2', 'Deck', 'Games']);
  assert.ok(!VIEWER.includes('id="sort"'));
});

test('next/prev walk picks, then the deck, then games, and stop at both ends', () => {
  const v = load(DATA);
  assert.equal(v.els.prev.disabled, true);
  for (let i = 0; i < 4; i++) v.api.step(1);
  assert.deepEqual(v.api.st(), { deckView: false, gamesView: false, gameIdx: 0, pack: 2, pick: 2 });
  v.api.step(1); assert.equal(v.api.st().deckView, true);
  v.api.step(1); assert.equal(v.api.st().gamesView, true);
  assert.equal(v.els.next.disabled, true);
  v.api.step(1); assert.equal(v.api.st().gamesView, true);
  v.api.step(-1); assert.equal(v.api.st().deckView, true);
});

test('the URL hash follows navigation', () => {
  const v = load(DATA);
  assert.equal(last(v), '/drafts/1/');
  v.els.packs.children[1].onclick(); assert.equal(last(v), '#pick-2-1');
  v.api.step(1); assert.equal(last(v), '#pick-2-2');
  v.els.packs.children[2].onclick(); assert.equal(last(v), '#deck');
  v.els.packs.children[3].onclick(); assert.equal(last(v), '#game-1-1');
  clickGame(v, 0, 1); assert.equal(last(v), '#game-1-2');
  v.els.packs.children[0].onclick(); assert.equal(last(v), '/drafts/1/', 'pack 1 pick 1 is the plain URL');
});

test('links open the right view, and bad links fall back to the start', () => {
  const start = { deckView: false, gamesView: false, gameIdx: 0, pack: 1, pick: 1 };
  const cases = [
    ['#game-1-2', { gamesView: true, gameIdx: 1 }], ['#games', { gamesView: true, gameIdx: 0 }],
    ['#deck', { deckView: true }], ['#pick-2-2', { pack: 2, pick: 2 }],
    ['#pick-9-9', start], ['#game-9-9', start], ['#bogus', start], ['', start],
  ];
  for (const [hash, want] of cases) assert.deepEqual(load(DATA, { hash }).api.st(), { ...start, ...want, ...(want.gamesView || want.deckView ? { pack: 2 } : {}) }, hash);
});

test('pasting a link into an open tab (hashchange) navigates', () => {
  const v = load(DATA);
  v.loc.hash = '#game-1-2'; v.listeners.hashchange();
  assert.deepEqual([v.api.st().gamesView, v.api.st().gameIdx], [true, 1]);
});

// ---- pick view -------------------------------------------------------------------------------
test('pick view shows one image per card, sorted by color, with exactly one picked marker', () => {
  const v = load(DATA);
  const cards = v.els.grid.children;
  assert.equal(cards.length, 4);
  assert.ok(cards.every(c => imgs(c) === 1));
  assert.deepEqual(cards.map(c => ['Delta Sorcery', 'Gamma Bolt', 'Beta Bear', 'Alpha Land'].find(n => text(c).includes(n))),
    ['Delta Sorcery', 'Gamma Bolt', 'Beta Bear', 'Alpha Land']);
  const picked = cards.filter(c => c.className.includes('picked'));
  assert.equal(picked.length, 1);
  assert.ok(text(picked[0]).includes('Alpha Land') && text(picked[0]).includes('Picked'));
});

test('"Show picks" off hides the marker; "Card images" off falls back to text chips', () => {
  const v = load(DATA);
  v.els.showPicks.checked = false; v.els.showPicks.onchange();
  assert.equal(v.els.grid.children.filter(c => c.className.includes('picked')).length, 0);
  v.els.imgs.checked = false; v.els.imgs.onchange();
  assert.ok(v.els.grid.children.every(c => c.className.startsWith('card')));
});

test('the pick strip holds only pick numbers; Deck and Games live in the top bar alone', () => {
  for (const hash of ['', '#pick-2-2', '#deck', '#games']) {
    const v = load(DATA, { hash });
    assert.ok(v.els.picks.children.every(b => /^\d+$/.test(b.textContent)), hash);
  }
  assert.equal(load(DATA, { hash: '#deck' }).els.picks.children.length, 2);  // pack 2 has two picks
});

test('controls only show where they do something', () => {
  const pick = load(DATA), deck = load(DATA, { hash: '#deck' }), games = load(DATA, { hash: '#games' });
  assert.deepEqual([pick.els.picks.hidden, pick.els.showPicksWrap.hidden, pick.els.imgsWrap.hidden], [false, false, false]);
  assert.deepEqual([deck.els.picks.hidden, deck.els.showPicksWrap.hidden, deck.els.imgsWrap.hidden], [true, true, false]);   // images still switch the deck view
  assert.deepEqual([games.els.picks.hidden, games.els.showPicksWrap.hidden, games.els.imgsWrap.hidden], [true, true, true]);
});

test('the draft id is a tooltip, not part of the visible header', () => {
  const D = clone(DATA); D.draftId = 'dc4589a5-2b62-40b3-afcf-8fb2d0eaa45a';
  const v = load(D);
  assert.ok(!v.els.sub.textContent.includes(D.draftId));
  assert.equal(v.els.sub.title, D.draftId);
});

test('the opponent card list has no blank indent column', () => {
  const v = load(DATA, { hash: '#games' });
  assert.ok(v.els.pool.children.length > 0 && v.els.pool.children.every(li => li.className === 'opp' && li.children.length === 1));
});

// ---- deck view -------------------------------------------------------------------------------
test('deck view groups by mana value, and the sidebar is an Arena-importable decklist', () => {
  const v = load(DATA, { hash: '#deck' });
  assert.equal(v.els.title.textContent, 'Final deck · 5 main, 1 sideboard');
  assert.equal(v.els.sideTitle.textContent, 'Decklist');
  const cols = v.els.grid.children[0].children[1].children;
  assert.deepEqual(cols.map(c => c.children[0].textContent), ['MV 0–1 (1)', 'MV 2 (1)', 'MV 3 (1)', 'Lands (2)']);
  assert.equal(v.els.decktext.textContent,
    'Deck\n1 Gamma Bolt\n1 Beta Bear\n1 Delta Sorcery\n2 Alpha Land\n\nSideboard\n1 Eta Charm');
  assert.equal(v.els.decktext.hidden, false);
});

test('the deck columns merge the sparse top end while the curve keeps every mana value', () => {
  const D = clone(DATA);
  const big = (name, cost) => ({ name, colors: 'B', types: ['Creature'], cost, rarity: 4, qty: 1 });
  D.deck.main.push(big('Five Drop', '{3}{B}{B}'), big('Six Drop', '{4}{B}{B}'), big('Eight Drop', '{6}{B}{B}'));
  const v = load(D, { hash: '#deck' });
  const deck = v.els.grid.children[0];
  assert.deepEqual(deck.children[1].children.map(c => c.children[0].textContent),
    ['MV 0\u20131 (1)', 'MV 2 (1)', 'MV 3 (1)', 'MV 5+ (3)', 'Lands (2)']);                  // 5, 6 and 8 share one column
  assert.deepEqual(deck.children[0].children.map(c => c.children[2].textContent), ['0\u20131', '2', '3', '5', '6', '7+']);  // the curve does not
});

test('the decklist text and Picked-so-far list swap by view', () => {
  const v = load(DATA);
  assert.equal(v.els.decktext.hidden, true);
  assert.equal(v.els.sideTitle.textContent, 'Picked so far');
});

// ---- games view ------------------------------------------------------------------------------
test('games are grouped under their match, with a result on each tab', () => {
  const v = load(DATA, { hash: '#games' });
  assert.equal(v.els.title.textContent, 'Games · 1–0 in matches');
  assert.equal(groups(v).length, 1);
  assert.equal(groups(v)[0].children[0].textContent, 'Match 1 · Won');
  assert.deepEqual(groups(v)[0].children[1].children.map(b => b.textContent), ['Game 1 · W', 'Game 2 · W']);
});

test('turn headers count rounds, so each number appears once per player', () => {
  const v = load(DATA, { hash: '#games' });
  assert.deepEqual(turns(v).map(t => t.children[0].textContent), ['Turn 1 · You', 'Turn 1 · Opp', 'Turn 2 · You']);
  clickGame(v, 0, 1);
  assert.deepEqual(turns(v).map(t => t.children[0].textContent), ['Turn 1 · Opp']);
});

test('each game ends with who won and how', () => {
  const v = load(DATA, { hash: '#games' });
  let end = games(v).children.at(-1);
  assert.equal(end.className, 'gend win');
  assert.equal(end.textContent, 'Game over · You win (played out)');
  clickGame(v, 0, 1);
  assert.equal(games(v).children.at(-1).textContent, 'Game over · You win (Opp conceded)');
});

test('opening hand is a row of card images, labelled with the mulligan', () => {
  const v = load(DATA, { hash: '#games' });
  const open = games(v).children.find(c => c.className === 'open');
  assert.equal(open.children[0].textContent, 'Opening hand · mulligan to 3');
  assert.equal(open.children[1].children.length, 3);
  assert.equal(imgs(open.children[1]), 3);
  clickGame(v, 0, 1);
  assert.equal(games(v).children.find(c => c.className === 'open').children[0].textContent, 'Opening hand');
});

test('the sideboarding box appears only when cards changed, above the opening hand', () => {
  const v = load(DATA, { hash: '#games' });
  assert.ok(!boxes(v).includes('sbbox'));
  clickGame(v, 0, 1);
  const b = boxes(v);
  assert.ok(b.includes('sbbox') && b.indexOf('sbbox') < b.indexOf('open'));
  const sb = text(games(v).children[b.indexOf('sbbox')]);
  assert.ok(sb.includes('Eta Charm') && sb.includes('Delta Sorcery'));
  assert.ok(/In.*Eta Charm/.test(sb) && /Out.*Delta Sorcery/.test(sb));
});

test('the sidebar lists the opponent cards seen in that game', () => {
  const v = load(DATA, { hash: '#games' });
  assert.equal(v.els.sideTitle.textContent, 'Opponent’s cards');
  assert.equal(v.els.pool.children.length, 1);
});

test('best-of-1 drafts get a flat list of games and a game record', () => {
  const D = clone(DATA);
  const [g1, g2] = D.games[0].games;
  D.games = [{ match: 1, result: 'won', games: [g1] }, { match: 2, result: 'won', games: [g2] }];
  const v = load(D, { hash: '#games' });
  assert.equal(v.els.title.textContent, 'Games · 2–0');
  assert.equal(groups(v).length, 1);
  assert.deepEqual(groups(v)[0].children.map(b => b.textContent), ['Game 1 · W', 'Game 2 · W']);
});

test('poison shows beside the life total only for a player who has some', () => {
  const heads = D => turns(load(D, { hash: '#games' })).map(t => t.children[1].textContent);
  assert.deepEqual(heads(DATA), ['You 20 \u00b7 Opp 20', 'You 20 (2 poison) \u00b7 Opp 20', 'You 20 (1 poison) \u00b7 Opp 18']);
  const both = clone(DATA); both.games[0].games[0].turns[2].poison = { You: 3, Opp: 1 };
  assert.equal(heads(both)[2], 'You 20 (3 poison) \u00b7 Opp 18 (1 poison)');
  const none = clone(DATA); none.games[0].games[0].turns.forEach(t => delete t.poison);       // no player has any
  assert.ok(heads(none).every(h => !h.includes('poison')));
  const zero = clone(DATA); zero.games[0].games[0].turns[1].poison = { You: 0 };              // zero is not shown either
  assert.ok(!heads(zero)[1].includes('poison'));
});

test('a draft with no games or deck still renders and hides those tabs', () => {
  const D = clone(DATA); delete D.games; delete D.deck;
  const v = load(D);
  assert.deepEqual(v.els.packs.children.map(b => b.textContent), ['Pack 1', 'Pack 2']);
});

// ---- image preloading ------------------------------------------------------------------------
test('opening a pack preloads the next pack’s images once, in pick order', () => {
  const v = load(DATA);
  assert.deepEqual(v.preloaded, ['Eta Charm', 'Epsilon Land', 'Beta Bear'].map(imgUrl));
  v.els.packs.children[1].onclick();   // pack 2 is last: nothing further to preload
  v.els.packs.children[0].onclick();   // back to pack 1: already queued, not repeated
  assert.equal(v.preloaded.length, 3);
});

test('preloading is skipped on the last pack, outside pick views, and with data saver on', () => {
  assert.equal(load(DATA, { hash: '#deck' }).preloaded.length, 0);
  assert.equal(load(DATA, { hash: '#games' }).preloaded.length, 0);
  assert.equal(load(DATA, { hash: '#pick-2-1' }).preloaded.length, 0);
  assert.equal(load(DATA, { saveData: true }).preloaded.length, 0);
});

// ---- bottom navigation and phone tab labels -------------------------------------------------------
test('Prev and Next are repeated under the cards, enabled and disabled together with the top ones', () => {
  const v = load(DATA);
  assert.deepEqual([v.els.prev2.disabled, v.els.next2.disabled], [v.els.prev.disabled, v.els.next.disabled]);
  assert.deepEqual([v.els.prev2.disabled, v.els.next2.disabled], [true, false]);          // first pick: nothing before it
  v.els.next2.onclick();
  assert.deepEqual([v.els.prev2.disabled, v.els.prev.disabled], [false, false]);
  for (let i = 0; i < 5; i++) v.api.step(1);                                              // pick 2 -> ... -> deck -> games (the last view)
  assert.deepEqual([v.els.next2.disabled, v.els.next.disabled], [true, true]);
});

test('the bottom buttons step and then jump to the top; the top ones just step', () => {
  const v = load(DATA);
  v.els.next2.onclick();
  assert.deepEqual(v.api.st().pick, 2);
  assert.deepEqual(v.scrolls, [[0, 0]]);
  v.els.prev2.onclick();
  assert.deepEqual([v.api.st().pick, v.scrolls.length], [1, 2]);
  v.els.next.onclick();
  assert.deepEqual([v.api.st().pick, v.scrolls.length], [2, 2]);                           // no scroll for the top button
});

test('pack tabs carry a short label for phones and keep the full name for screen readers', () => {
  const v = load(DATA);
  const [p1, p2, deck, games] = v.els.packs.children;
  assert.deepEqual([p1.textContent, p1.dataset.short, p1._a['aria-label']], ['Pack 1', 'P1', 'Pack 1']);
  assert.deepEqual([p2.textContent, p2.dataset.short], ['Pack 2', 'P2']);
  assert.equal(deck.dataset.short, undefined);
  assert.equal(games.dataset.short, undefined);                                           // Deck and Games stay as they are
});

// ---- header, readable turns, touch previews ---------------------------------------------------
test('the header names the draft, shows a friendly event and the record, with the deck colors', () => {
  const D = clone(DATA); D.event = 'CubeDraft_PoweredTraditional_20261020'; D.number = 3;
  const v = load(D);
  assert.equal(v.els.h1.textContent, 'Draft 3');
  assert.equal(v.els.sub.textContent, 'Cube Draft \u00b7 Powered Traditional \u00b7 1\u20130 in matches');
  assert.deepEqual(v.els.sub.children.map(c => c.className), ['pip U', 'pip R', 'pip G']);   // WUBRG order, colors of the deck
  assert.equal(load(DATA).els.h1.textContent, 'Draft Replay');                               // no number in the data
});

test('the header record is games for best-of-1 and absent when there are no games', () => {
  const bo1 = clone(DATA); const [g1, g2] = bo1.games[0].games;
  bo1.games = [{ match: 1, result: 'won', games: [g1] }, { match: 2, result: 'won', games: [g2] }];
  assert.ok(load(bo1).els.sub.textContent.endsWith('\u00b7 2\u20130'));
  const none = clone(DATA); delete none.games;
  assert.equal(load(none).els.sub.textContent, 'Test Draft');
});

test('routine lines are dimmed and the moments that matter are emphasized', () => {
  const v = load(DATA, { hash: '#games' });
  const cls = t => turns(v)[t].children.filter(c => c.className.startsWith('ev')).map(c => c.className);
  assert.deepEqual(cls(0), ['ev routine', 'ev']);          // You play a land / You cast a spell
  assert.deepEqual(cls(1), ['ev routine', 'ev key']);      // Opp plays a land; you get poison counters
  assert.deepEqual(cls(2), ['ev key', 'ev key', 'ev', 'ev key', 'ev']); // damage, life loss, a card's counter, poison removed, the attack
});

test('each turn header shows the life totals at the end of the turn, when the data has them', () => {
  const v = load(DATA, { hash: '#games' });
  assert.deepEqual(turns(v).map(t => t.children[1].textContent), ['You 20 \u00b7 Opp 20', 'You 20 (2 poison) \u00b7 Opp 20', 'You 20 (1 poison) \u00b7 Opp 18']);
  assert.equal(turns(v)[0].children[1].className, 'life');
  const D = clone(DATA); D.games[0].games.forEach(g => g.turns.forEach(t => delete t.life));  // data from before life totals existed
  assert.ok(turns(load(D, { hash: '#games' })).every(t => t.children.every(c => c.className !== 'life')));
});

const crefs = n => all(n, x => x.className === 'cref' && x.onclick);
const tap = (n, x = 40, y = 60) => n.onclick({ stopPropagation() {}, clientX: x, clientY: y });
const twoNames = v => { const seen = new Map(); for (const c of crefs(games(v))) if (!seen.has(c.textContent)) seen.set(c.textContent, c); return [...seen.values()].slice(0, 2); };

test('on touch screens, tapping a card name previews it; tapping again, elsewhere, or scrolling closes it', () => {
  const v = load(DATA, { hash: '#games', touch: true });
  const [a, b] = twoNames(v);
  assert.ok(a && b && a.textContent !== b.textContent);
  tap(a); assert.equal(v.els.pop.hidden, false); assert.equal(v.els.pop.src, DATA.images[a.textContent]);
  tap(a); assert.equal(v.els.pop.hidden, true);                                   // same name again closes it
  tap(a); tap(b); assert.equal(v.els.pop.hidden, false); assert.equal(v.els.pop.src, DATA.images[b.textContent]);  // another name switches
  v.docListeners.click(); assert.equal(v.els.pop.hidden, true);                    // tapping elsewhere closes it
  tap(a); v.listeners.scroll(); assert.equal(v.els.pop.hidden, true);              // scrolling closes it
});

test('with a mouse, hover previews and clicking does nothing extra', () => {
  const v = load(DATA, { hash: '#games' });
  const [a] = twoNames(v);
  tap(a); assert.equal(v.els.pop?.src, undefined);  // the preview element is untouched by a click
  a.onmouseenter({ clientX: 5, clientY: 5 }); assert.equal(v.els.pop.src, DATA.images[a.textContent]);
  a.onmouseleave(); assert.equal(v.els.pop.hidden, true);
});

// ---- shared assets: skeleton, boot script, and the shell ---------------------------------------
test('every element the viewer looks up by id exists in its skeleton (the stub DOM would hide a miss)', () => {
  const skeleton = VIEWER.slice(VIEWER.indexOf('const SKELETON = `'), VIEWER.indexOf('`;', VIEWER.indexOf('const SKELETON = `')));
  const have = new Set([...skeleton.matchAll(/id="(\w+)"/g)].map(m => m[1]));
  const used = new Set([...VIEWER.matchAll(/\$\("(\w+)"\)/g)].map(m => m[1]));
  used.delete('app');
  assert.deepEqual([...used].filter(id => !have.has(id)), []);
});

test('the draft page shell loads the viewer before the boot script, in standards mode', () => {
  assert.ok(SHELL.startsWith('<!doctype html>'));
  assert.ok(SHELL.indexOf('/assets/viewer.js') < SHELL.indexOf('/assets/boot.js'));
  assert.ok(SHELL.includes('name="viewport"') && SHELL.includes('name="robots" content="noindex"'));
  assert.ok(SHELL.includes('id="app"'));
});

function boot({ pathname, fetchImpl }) {
  const mod = { exports: {} }, app = { textContent: '' }, started = [], fetched = [];
  new Function('module', 'document', 'fetch', 'location', 'startViewer', BOOT)(
    mod, { getElementById: () => app }, async u => { fetched.push(u); return fetchImpl(u); }, { pathname }, d => started.push(d));
  return { run: () => mod.exports.boot(), app, started, fetched, exports: mod.exports };
}

test('boot finds the draft data next to the page, with or without a trailing slash', async () => {
  const b = boot({ pathname: '/drafts/1', fetchImpl: async () => ({ ok: true, json: async () => DATA }) });
  assert.equal(b.exports.draftDataUrl('/drafts/1'), '/drafts/1/data.json');
  assert.equal(b.exports.draftDataUrl('/drafts/1/'), '/drafts/1/data.json');
  await b.run();
  assert.deepEqual(b.fetched, ['/drafts/1/data.json']);
  assert.equal(b.started.length, 1);
  assert.equal(b.started[0], DATA);
});

test('boot shows a readable message when the data is missing or the request fails', async () => {
  for (const fetchImpl of [async () => ({ ok: false, status: 404 }), async () => { throw new Error('offline'); }]) {
    const b = boot({ pathname: '/drafts/9/', fetchImpl });
    await b.run();
    assert.match(b.app.textContent, /Could not load this draft/);
    assert.equal(b.started.length, 0);
  }
});
