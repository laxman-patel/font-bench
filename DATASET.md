# Dataset Builder

The deterministic open-font builder creates the first `dev-open` dataset from a pinned list of Google Fonts families.

## Setup

```bash
bun install
```

## Build

```bash
bun run dataset:all
```

This writes:

- `corpus/open/` — downloaded WOFF2 files and fetched Google Fonts CSS.
- `corpus/manifest.generated.json` — generated font manifest with source URLs and hashes.
- `dataset/dev-open/images/` — anonymous rendered PNG samples.
- `dataset/dev-open/items.json` — model-facing MCQ items without answers.
- `dataset/dev-open/answer_key.json` — local answer key.
- `dataset/dev-open/build_report.md` — validation summary.
- `corpus/private/manifest.generated.local.json` — local manifest for selected proprietary fonts, if present.
- `dataset/private-mixed/` — local mixed dataset from open + proprietary fonts, if present.

Generated assets are ignored by git. Re-run the builder to reproduce them.

## Commands

```bash
bun run dataset:download
bun run dataset:render
bun run dataset:validate
bun run dataset:private
bun run dataset:all
bun run inference:prepare
bun run inference:prepare:private
```

The renderer is TypeScript/Bun. It uses `fontkit` to read glyph outlines directly from the downloaded font files and `sharp` to emit stripped PNGs.

## Private Fonts

Do not put proprietary fonts in the open manifest. Put licensed private fonts under `corpus/private/` for the later `private-mixed` builder path; that folder is gitignored.

Expected location:

```text
corpus/private/proprietary/<Family Name>/<font-file.ttf-or-otf>
```

The private builder scans each family folder, chooses one regular face where possible, and writes `dataset/private-mixed/`. Private font files, private manifests, and private mixed outputs are gitignored.

## Inference Isolation

Never point a model/agent at the repository root or at `dataset/private-mixed/` directly. Prepare a sanitized temporary workspace instead:

```bash
bun run inference:prepare:private
```

The command prints a JSON object with a `workspace` path under `/tmp/font-bench-inference/`. Use that path as the Cursor SDK `local.cwd`.

The sanitized workspace contains only:

- `items.json`
- `images/*.png`
- `README.md`
- `workspace_metadata.json`

It explicitly excludes answer keys, corpus manifests, source fonts, private font files, and repo files. The scorer should keep reading `dataset/private-mixed/answer_key.json` from the controller workspace only.
