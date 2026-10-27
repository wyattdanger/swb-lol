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
assets/       draft viewer JS/CSS   tools/     draft viewer generator (Python)
```

`assets/` and `tools/` are draft-viewer-only for now; namespace them per project when a second one arrives.

## Dev

```sh
tests/run.sh                          # Python + Node specs, no network (needs Python 3, Node 20+)
python3 -m http.server 8000           # preview at localhost:8000 (pages that fetch data need http)
git config core.hooksPath .githooks   # once per clone: failing specs block a push
```

## Deploy

Vercel, preset "Other", no build command; meant to deploy on every push to `main`. `.vercelignore` lists what
isn't published (`tools`, `tests`, `docs`, ...). `swb.lol` is registered at Dynadot with its name servers pointed
at Vercel, which manages the DNS.

## Privacy

It's a public site built from some private sources (Arena's logs contain account names). Never commit raw logs
or personal details, and treat anything a page fetches as public.
