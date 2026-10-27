# swb.lol

A personal playground: a static site on Vercel at <https://swb.lol>. No framework, no build step, just plain
HTML/CSS/JS plus local scripts that generate data.

> **Agents:** read the doc for the project you're touching, run `tests/run.sh` before pushing, and don't push
> unprompted. Never commit private data (see Privacy).

## Projects

| Project | Live at | Docs |
| --- | --- | --- |
| Draft viewer: Magic Arena drafts rebuilt from game logs | `/drafts/<n>` | [docs/draft-viewer.md](docs/draft-viewer.md) |

New project: its own folder of plain files, a doc in `docs/`, specs in `tests/`.

## Layout

```
index.html    landing page          docs/      one doc per project
drafts/       draft viewer pages    tests/     specs for everything
assets/       draft viewer JS/CSS   tools/     draft viewer generator, plus serve.mjs
```

`assets/` and `tools/` are draft-viewer-only for now; namespace them per project when a second one arrives.

## Dev

```sh
tests/run.sh                          # all specs, no network (Node 22.5+; developed on Node 23)
npm run serve                         # preview at http://127.0.0.1:8000 (no caching, so a reload shows edits)
git config core.hooksPath .githooks   # once per clone: failing specs block a push
```

## Deploy

Vercel serves the repo root as a plain static site (no build step) and is meant to deploy on every push to
`main`. `.vercelignore` lists what isn't published to swb.lol (`tools`, `tests`, `docs`, ...); the files are still
visible on GitHub if the repo is public. DNS for `swb.lol` is managed in Vercel.

## Privacy

It's a public site built from some private sources (Arena's logs contain account names). Never commit raw logs
or personal details, and treat anything a page fetches as public.
