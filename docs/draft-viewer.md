# Draft viewer

One project in the swb.lol playground (see the [root README](../README.md) for how the site and repo work).
It rebuilds each Magic: The Gathering Arena draft from Arena's local log files and shows it pack by pack, with
the final deck and a turn-by-turn replay of every game. Live at `https://swb.lol/drafts/<n>`.

There is no build step and no runtime dependency. Python (standard library only) turns Arena logs into a JSON
file per draft; one shared, plain-JavaScript viewer renders any of them in the browser.

> **Agents:** read "Publish the latest draft" and "Gotchas" first. Run `tests/run.sh` before pushing. Never
> commit raw Arena logs, and never put player usernames in anything you commit (see the root README's Privacy).

## Publish the latest draft

Do this on the Mac that ran Arena. The logs only exist there.

1. **Finish the draft, submit your deck, and play your matches.** The deck exists in the logs only after you
   submit it, and games only after they are played. Publishing earlier works but the page lacks those parts;
   run it again later to fill them in.
2. **Do it soon.** Arena keeps only the current and previous session logs (`Player.log` and
   `Player-prev.log`). After a second Arena restart the draft is gone from the logs. (The published
   `data.json` is permanent, so this only matters before you publish.)
3. From the repo root:
   ```sh
   python3 tools/draft_replay.py --publish .
   ```
   It reads both logs, takes the **latest** draft, and writes `drafts/<n>/data.json` and
   `drafts/<n>/index.html`. If the logs hold several drafts it lists them on stderr; pick one with
   `--draft-id <id>`. The first run for new cards needs internet (Scryfall image lookups, about 5 seconds);
   later runs use a local cache.
4. **Look at it locally** (the page must be served over http; opening the file directly will not work; `serve.py` sends
   no-cache headers because Safari otherwise keeps showing an old viewer script after you edit it):
   ```sh
   python3 tools/serve.py           # then open http://127.0.0.1:8000/drafts/<n>/
   ```
5. **Publish:**
   ```sh
   git add -A && git commit -m "Add draft <n>" && git push
   ```
   The pre-push hook runs the specs first, then the site deploys (see the root README).

A draft keeps its number if you republish it. A new draft gets the next free number.

## How it works

```
Arena logs ──> tools/draft_replay.py ──> drafts/<n>/data.json ──> assets/viewer.js (in the browser)
 (+ card DB)      tools/games.py            (committed)             renders picks, deck, games
```

| Path | What it is |
| --- | --- |
| `tools/draft_replay.py` | CLI. Parses picks, packs and the submitted deck; looks up card names and image URLs; writes the data file and the page shell. |
| `tools/games.py` | Parses matches and games into per-turn narration. |
| `tools/shell.html` | The tiny HTML page copied to every `drafts/<n>/index.html`. All draft pages are byte-identical. |
| `assets/viewer.js`, `viewer.css` | The viewer, **shared by every draft**. Edit these and every draft changes; no rebuild. |
| `assets/boot.js` | Fetches the draft's `data.json` (next to the page) and starts the viewer. |
| `drafts/<n>/data.json` | One draft's data (schema below). The permanent record. |
| `tools/scryfall_cache.json` | Gitignored cache of card name to image URL. Safe to delete. |
| `tests/test_pipeline.py`, `tests/viewer.test.js`, `tests/fixture.py` | This project's specs and its synthetic Arena log. |

### Other commands

```sh
python3 tools/draft_replay.py                    # plain-text replay of the latest draft
python3 tools/draft_replay.py --json --no-images # the data as JSON on stdout (never written to the repo)
python3 tools/draft_replay.py --rebuild .        # rewrite every page shell from tools/shell.html (no logs needed)
```

You only need `--rebuild` if `tools/shell.html` itself changes. Viewer changes need nothing.

```sh
python3 tools/draft_replay.py --refresh-images .   # re-pick every card's image URL from the names saved in each data.json
```

Use `--refresh-images` after changing the art rules (`OLDEST_FILTERS` / `PINNED_SETS`) or if Scryfall moves an image.
It needs no Arena logs, so it works on drafts whose logs are gone. A card whose lookup fails keeps its current URL.

## The data file (`schema: 1`)

```
schema      1      bump (and teach the viewer) if the shape changes
number      n      the draft's number
draftId, event
picks[]     { pack, pick, picked, cards[ {name, colors, types, cost, rarity, img} ] }   // every pack you saw
deck        { main[], side[] }   each card also has qty        // absent until a deck was submitted
games[]     matches: { match, result: "won"|"lost", games[
              { game, onPlay: "You"|"Opp", mulligans, opening[names],
                sideboard: { in[{n,q}], out[{n,q}] } | null,    // vs the deck used in the previous game
                turns[ { turn, who, events[strings], life? } ], // turn is Arena's count (each player's turn);
                                                                //   life = {You, Opp} at the end of the turn (optional)
                result: { winner, reason }, opponentCards[names] } ] }
images      { cardName: url }    for names used in games
```

Event strings wrap card names as `{{Card Name}}` so the viewer can show a hover image. The opponent is always
the literal string `"Opp"`.

## The viewer

- **Views:** pack picks (card images, your pick ringed), the final deck (columns by mana value, a curve, and a
  copyable Arena-import decklist), and Games (grouped by match; opening hand, sideboarding, turns, result).
- **Header:** "Draft <n>", a friendly event name, the record, and the deck's colors; the draft id is a tooltip.
- **Games view:** routine lines (draws, land drops) are dimmed, life changes, damage and deaths are bold, and each turn
  header shows both life totals. Card names preview on hover, or on tap on touch screens.
- **Controls:** the pick strip and "Show picks" appear only in pick views; "Card images" in pick and deck views.
- **Links:** the URL hash follows navigation: `#pick-<pack>-<pick>`, `#deck`, `#games`, `#game-<match>-<game>`.
  Pasting one into the address bar jumps there.
- **Card art:** each card shows its oldest non-promo printing (promos can predate a card's first real set),
  skipping Alpha and Beta so those cards show Unlimited (`OLDEST_FILTERS` in `tools/draft_replay.py`). Basic lands are pinned to the full-art Unhinged printings; `PINNED_SETS` in `tools/draft_replay.py` is the table
  to edit. Changing a pin makes the next run re-look-up just those cards.
- **Images:** loaded from Scryfall's CDN, never stored here. Cards show their name until the image arrives. The
  next pack's images are preloaded in the background (skipped when the browser asks to save data).
- **Best-of-1:** if every match has one game, tabs are a flat `Game 1, Game 2, ...` list with a game record.

## Gotchas (hard-won; read before touching the parsers)

These are real log behaviors that each caused a bug. The specs cover them; the reasons are here.

- **Where the logs are:** `~/Library/Logs/Wizards Of The Coast/MTGA/Player.log` and `Player-prev.log`. Card
  names come from Arena's own card database at
  `~/Library/Application Support/com.wizards.mtga/Downloads/Raw/Raw_CardDatabase_*.mtga` (SQLite). If a log
  looks sparse, Arena's "Detailed Logs" option may be off (not verified on this machine).
- **Arena logs every `Draft.Notify` twice.** Picks are de-duplicated by (pack, pick).
- **The event name is not on the match room event.** It comes from the `EventEnterPairing` request just before
  the match.
- **`ConnectResp` shares a log line with the game's first state message.** Never skip the whole line after
  reading the deck, or a game loses its opening hand, mulligan count and who was on the play.
- **`ConnectResp` may be logged after the room-open event**, so a match can start without its deck. Set the deck
  when `ConnectResp` arrives, or sideboard diffs silently vanish.
- **The turn-1 marker is emitted before the mulligans.** Capture the opening hand when `turnInfo.turnNumber`
  first reports 1, not at the first marker (that is the pre-mulligan 7). London-mulligan bottoming lands in
  that same message and must not be narrated.
- **Mulligans:** each hand offered is a `MulliganReq`; mulligans = offers - 1.
- **Client replies are pretty-printed, multi-line JSON** (`... to Match: ClientToGremessage` then a `{ ... }`
  block). Sideboarding is the `SubmitDeckResp` block, diffed against the match's current deck.
- **Match numbers are per event**, not per log. Reading both logs otherwise numbers your first match "10".
- **Arena counts each player's turn** (1, 2, 3...). The viewer shows rounds (`ceil(turn / 2)`).
- **Arena's card names drop accents** ("Troll of Khazad-dum"); Scryfall's have them. Unmatched names fall back to
  Scryfall's fuzzy endpoint.
- **A draft page may be opened as `/drafts/1` or `/drafts/1/`**, so `boot.js` builds the data URL from the path
  either way (a relative `data.json` would break without the slash).
- **Page must be standards mode** (`<!doctype html>`) and carry the viewport meta, or phones render it wrong.
- **Dropped on purpose:** "X resolves" lines (the cast line already says it), mulligan-bottoming moves.

## Specs

Run them with `tests/run.sh` (see the root README). `tests/fixture.py` builds a small synthetic Arena log and
card database in a temp folder, shaped like the real thing: a best-of-3 with a mulligan and a sideboard swap, and
the exact line layouts that broke the parser before. The viewer specs run the real `assets/viewer.js` against a
stub DOM, so they test logic, **not how it looks**; check visuals in a browser.

One extra spec checks the author's real Oct 26 draft against hand-verified numbers; it skips itself on any
other machine or once Arena rotates that log out.

Test hooks in the code: `ARENA_CARD_DB` overrides the card database path; `--no-images` skips Scryfall.
When fixing a parser bug, add a case to `tests/fixture.py` that reproduces it first, then fix.

## Privacy specifics

The parser keeps no usernames: opponents are `"Opp"`, you are `"You"`. `data.json` is public (the page fetches
it) and holds card names, results and opponents' revealed cards only. The specs assert the fixture's fake
usernames never appear in any output.

## Known gaps and ideas

- **Only live cube drafts are verified.** Bot drafts (Quick/Premier Draft) probably log picks differently and
  may need parser changes. Best-of-1 is handled in the data model and viewer but has only been tested on
  synthetic data. Send a real log before trusting it.
- **Not narrated:** triggered or activated ability text, counter types, and what sweeping effects did card by card.
- **Opponent hands and draws are unknown** (hidden in the log); only revealed cards appear.
- **Ideas:** a `/drafts` index page; a one-command publish wrapper (ingest, specs, commit, push). The data files
  and `viewer.js` would carry over unchanged if the site moves to a framework such as Astro.
- **Numbering** follows publish order, not play order.
