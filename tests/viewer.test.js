// Specs for the viewer page script (tools/viewer.template.html).
// Run with: node --test tests/*.test.js   (or tests/run.sh for everything)
//
// The real page script runs against a tiny stub DOM, fed by the same synthetic draft the Python
// specs use (tests/fixture.py), so nothing here needs a browser, Arena, or the network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VIEWER = fs.readFileSync(path.join(ROOT, 'assets', 'viewer.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(ROOT, 'assets', 'boot.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'tools', 'shell.html'), 'utf8');
const imgUrl = name => `https://img.test/${encodeURIComponent(name)}.jpg`;

function fixtureData() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-spec-'));
  const build = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, "tests"); import fixture; fixture.build_all(sys.argv[1])', tmp], { cwd: ROOT });
  assert.equal(build.status, 0, String(build.stderr));
  const env = { ...process.env, ARENA_CARD_DB: path.join(tmp, 'cards.sqlite') };
  const run = spawnSync('python3', ['tools/draft_replay.py', '--json', '--no-images', '--draft-id', 'D1', path.join(tmp, 'Player.log')], { cwd: ROOT, env });
  assert.equal(run.status, 0, String(run.stderr));
  const D = JSON.parse(String(run.stdout));
  // give every card an image so the image code paths run
  for (const p of D.picks) for (const c of p.cards) c.img = imgUrl(c.name);
  for (const z of ['main', 'side']) for (const c of D.deck[z]) c.img = imgUrl(c.name);
  const names = new Set(JSON.stringify(D.games).match(/\{\{.+?\}\}/g)?.map(s => s.slice(2, -2)));
  for (const m of D.games) for (const g of m.games) {
    g.opening.concat(g.opponentCards).forEach(n => names.add(n));
    for (const x of [...(g.sideboard?.in || []), ...(g.sideboard?.out || [])]) names.add(x.n);
  }
  D.images = Object.fromEntries([...names].map(n => [n, imgUrl(n)]));
  return D;
}
const DATA = fixtureData();
const clone = o => JSON.parse(JSON.stringify(o));

// ---- stub DOM + page loader -------------------------------------------------------------------
function load(D, { hash = '', saveData = false } = {}) {
  const els = {}, urls = [], listeners = {}, preloaded = [];
  const mk = tag => ({
    tag, style: {}, children: [], _a: {}, dataset: {}, hidden: false, className: '', textContent: '', checked: true,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } },
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    setAttribute(k, v) { this._a[k] = v; }, replaceWith() {},
  });
  const doc = {
    getElementById: id => els[id] ?? (els[id] = mk('#' + id)),
    createElement: t => mk(t), createTextNode: t => ({ tag: '#text', textContent: t }), addEventListener() {},
  };
  class FakeImage { set src(v) { preloaded.push(v); if (this.onload) this.onload(); } }
  const loc = { hash, pathname: '/drafts/1/', search: '' };
  const mod = { exports: {} };
  new Function('module', 'document', 'scrollTo', 'location', 'history', 'innerWidth', 'innerHeight', 'window', 'Image',
    'requestIdleCallback', 'navigator', VIEWER)(
    mod, doc, () => {}, loc, { replaceState(a, b, u) { urls.push(u); } }, 1200, 800,
    { addEventListener(n, f) { listeners[n] = f; } }, FakeImage, f => f(), { connection: { saveData } });
  const api = mod.exports.startViewer(D);
  return { els, api, urls, loc, listeners, preloaded };
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
