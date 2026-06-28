# font-bench — Plan

> **One line:** A benchmark that measures whether vision-language models can identify a typeface from a rendered image — testing fine-grained visual perception, not web search.

---

## 1. Thesis

Most VLM benchmarks reward *semantic* understanding (what the text says, what's in the scene). Almost none reward *sub-semanti//c* visual detail. Telling Helvetica from Arial requires perceiving terminal angles, aperture, the leg of an `R`, the tail of an `a` — exactly the high-frequency detail that vision encoders are trained to throw away.

font-bench isolates that capability. The label is perfect by construction (we render from the font file), samples are infinite and fresh (so nothing is memorizable), and difficulty is a dial (Comic Sans vs Times → Arial vs Helvetica).

## 2. What it measures

1. **Fine-grained visual discrimination** — the core skill; detail far below normal VLM tasks.
2. **Style perception decoupled from content** — the text reads the same in any font; the model must attend to *how* it looks, not *what* it says. (Opposite of OCR, which VLMs are over-trained on.)
3. **Long-tail visual knowledge** — thousands of near-identical classes; does the model have name-indexed typographic knowledge at all?
4. **Inverted invariance/sensitivity** — must be invariant to big nuisances (size, weight, color, antialiasing) while sensitive to tiny diagnostics (double- vs single-story `a`).
5. **Comparative visual reasoning** (MCQ mode) — eliminate lookalikes by verifying distinguishing features.
6. **Calibration** — we can construct *provably* ambiguous items (the rendered glyphs don't differ between candidates). Does the model hedge when the answer is genuinely undeterminable?

Explicitly **not** tested: language, reasoning depth, agency.

## 3. Scope decisions (resolved)

These were debated; here is the settled design:

- **Single leaderboard**, not multiple tracks. Multi-track muddies the bench's identity.
- **Closed-book visual.** The model gets the image + answer choices. No internet, no external font references.
- **Local image tools allowed.** Cropping, zoom, threshold, edge detection, glyph segmentation, measuring x-height — these operate on the *given evidence* (like a loupe). Allowed.
- **No external reference data.** No font downloads, no Google/Adobe Fonts lookup, no rendering candidate fonts locally, no font-ID web services, no reading system font dirs.
  > **The rule:** *transformations of the input image are allowed; adding external typographic reference data is not.*
- **Corpus mixes proprietary + free fonts** so the "download every Google Font and pixel-diff" strategy can't dominate even if egress ever leaked — proprietary fonts aren't publicly downloadable.
- **Enforced by sandboxing, not honor system** (see §8–§9). Model tools run in an offline E2B sandbox; all inference happens controller-side, so the tool environment never touches the network.
- **MVP inference uses Cursor SDK.** The first runnable harness uses `@cursor/sdk` because available inference lives in the Cursor account, not direct provider API keys. These runs are reported as a **Cursor SDK adapter** result, not as a pure provider-native leaderboard entry.
- **Canonical provider adapters come later.** Direct OpenAI / Anthropic / Gemini / local-VLM adapters remain the stricter path for public comparisons when provider API access is available.

## 4. Improvements over the naive design

Things worth adding beyond "render text, ask the model":

1. **Diagnostic-glyph oracle.** Before scoring an item, compare glyph outlines (via `fontTools`) between the target and each distractor. Render text that *contains* the glyphs that actually differ. This lets us:
  - guarantee an item is **determinable** (≥1 visible diagnostic glyph), and
  - deliberately construct **ambiguous** items (no visible diagnostic) for the calibration sub-bench.
2. **Automatic hard-distractor selection.** Pick distractors by font similarity (category/serif-class/weight features + render-and-pixel-distance), not randomly. Gives principled difficulty tiers instead of "obvious vs obvious."
3. **Two independent difficulty axes**, reported as a grid:
  - *pair similarity* (how alike the candidates are)
  - *render nuisance* (size, color, rotation, noise, background)
4. **Anti-contamination by randomized rendering.** Every served image randomizes text content, size, weight, color, background, slight rotation, kerning, antialiasing. Defeats memorization and pixel-hash lookups.
5. **Calibration as a first-class metric**, not just accuracy — possible only because of the ambiguity oracle (#1).
6. **Robustness metric.** Same font, different render params → does the answer stay stable?
7. **Human baseline.** Small designer panel on the public subset (designers play "name that font" for sport; good reference point).
8. **Legal hygiene.** Distribute only rendered rasters, never proprietary font files (see §5).

## 5. Dataset design

### Corpus

- ~40% open fonts (Google Fonts), ~40% proprietary/commercial, ~20% custom/modified (subtle mods, near-clones) — ratios tunable.
- Include explicit **near-neighbor clusters**: Arial / Helvetica / Neue Haas Grotesk / Inter; Garamond variants; geometric sans family; etc.
- Pin font **versions**; record per item.

### Specimen rendering

- Deterministic rasterizer (fixed engine, hinting off, recorded config), seeded RNG.
- Randomize per item: text, point size, weight, fg/bg color, antialiasing, small rotation, optional background noise/texture.
- Default output: small grayscale PNG (~256×96) to keep image tokens low (see §9).
- **Strip all metadata**: no EXIF/PNG text chunks, random IDs (`sample_8f31.png`), no font name in filename/path/alt.

### Item schema

```json
{
  "id": "sample_8f31",
  "image": "sample_8f31.png",
  "track": "mcq",
  "choices": ["Inter", "Helvetica", "Arial", "Neue Haas Grotesk"],
  "answer": "Helvetica",
  "tier": {"pair_similarity": "hard", "render_nuisance": "low"},
  "determinable": true,
  "render": {"font_version": "...", "size": 28, "rotation_deg": 1.5, "seed": 1234}
}
```

Answer key + `render`/`determinable` fields live **outside** the sandbox; the model only ever sees `image` (+ `choices` for MCQ) + output schema.

### Anti-leak / legal

- Public release = **rendered images + hashed answer key** only. No font files in the public repo.
- Proprietary `.ttf/.otf` stay on the controller (your infra), never redistributed and never uploaded to the sandbox — only rendered rasters are.
- Keep a **private held-out set** (rotated periodically) separate from the public set.

## 6. Task format & tracks


| Track             | Prompt                 | Output                               | Use                              |
| ----------------- | ---------------------- | ------------------------------------ | -------------------------------- |
| **MCQ** (default) | image + 4–8 candidates | single letter `A`–`D` (+ confidence) | cheap, primary leaderboard       |
| **Pairwise**      | image + "A or B?"      | `A`/`B`                              | cheapest; near-duplicate battles |
| **Open**          | image only             | font family name (+ confidence)      | hard mode, finalists only        |


- Fixed, short prompt — the image carries the task, no long rubric.
- Optional `confidence` ∈ [0,1] for calibration; abstain allowed on ambiguous items.

## 7. Scoring & metrics

- **Accuracy** overall and per tier (the similarity × nuisance grid).
- **Calibration** — ECE / Brier; correct abstention rate on `determinable=false` items.
- **Robustness** — answer stability across render perturbations of the same font.
- **Cost per correct answer** — accuracy is meaningless without this for a public board.
- **Latency + error rate** — average duration, timeout rate, parse failures, and provider/SDK failures.
- **Confusion matrix** — which fonts get mixed (great for shareable visuals).
- MCQ scored by exact letter (use provider `logprobs` over `A/B/C/D` when available → near-zero output tokens).
- Cursor SDK runs generally won't expose provider-native `logprobs` or exact image-token accounting; record resolved `model`, `requestId`, `durationMs`, final text, parse status, and Cursor usage-dashboard cost where available.

## 8. Harness architecture

Two tracks, one controller. The controller holds credentials and runs the model loop; **inference never happens inside the sandbox.**

```
controller (your machine — credentials, agent loop, calls hosted inference)
  ├── builds item: render + strip metadata + hold answer key
  ├── model adapters
  │     ├── cursor-sdk (MVP: @cursor/sdk, Cursor-hosted inference)
  │     └── provider-native (later: Anthropic / OpenAI / Gemini / local)
  ├── MCQ track:    image → adapter → letter.  No sandbox.
  └── Agentic track: model requests a tool → controller runs it in an
        E2B sandbox (pure tool executor) → returns result to the model
            E2B microVM: ephemeral, no internet
              - image tools only (Python/PIL/OpenCV/ImageMagick)
              - system fonts stripped, no reference fonts
              - fresh sandbox per item = clean snapshot
```

**Run flow (agentic):** select item → render + strip in controller → send image to model → on each tool call, controller executes it in the sandbox and returns output → model emits answer (+ confidence) → controller scores against the key (held outside) → log prompts, responses, tool calls, runtime, tokens, cost.

### Cursor SDK adapter (MVP)

Use the TypeScript SDK as the first inference bridge:

- Package: `@cursor/sdk`; requires Node.js 22.13+.
- Auth: `CURSOR_API_KEY`; SDK usage follows Cursor account/team pricing and appears under the SDK tag in Cursor usage.
- Runtime: start with `local: { cwd }` so files stay on this machine. "Local" means the agent loop and filesystem are local; inference still goes through Cursor-hosted models.
- Model discovery: call `Cursor.models.list()` at startup and cache valid model IDs/parameter shapes instead of hard-coding stale names.
- Invocation: use `Agent.create()` + `agent.send({ text, images: [{ data: base64Png, mimeType: "image/png" }] })`, then `run.wait()`. `Agent.prompt()` is fine for one-shot text, but `agent.send()` is the clearer image path.
- Isolation: run SDK inference from a minimal temporary workspace containing no font corpus, no answer key, and no reference fonts. Use `local.settingSources: []`, no MCP servers, no subagents, and `local.sandboxOptions.enabled: true` for strict local tool limits. For MCQ, prompt for no tool use and parse only the final answer.
- Resource hygiene: use `await using` / explicit disposal, record `agentId`, `run.id`, `requestId`, resolved `model`, `durationMs`, status, and final text.
- Reporting: label these entries as `cursor-sdk:<model-or-variant>` so later provider-native runs are not conflated with Cursor's orchestration layer.

Minimal adapter shape:

```ts
import { Agent, Cursor } from "@cursor/sdk";

const models = await Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY! });

await using agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: {
    cwd: tempInferenceWorkspace,
    settingSources: [],
    sandboxOptions: { enabled: true },
  },
});

const run = await agent.send({
  text: prompt,
  images: [{ data: base64Png, mimeType: "image/png" }],
});
const result = await run.wait();
```

## 9. Sandbox: E2B (offline tool executor)

The crux — *tools offline, inference online* — is satisfied **by construction**: the agent loop and all LLM calls live in the controller, so the sandbox needs **zero internet**. No proxy, no egress allowlist, nothing to lock down.

- **E2B microVM** runs only the model-requested image tools; the controller drives it via the SDK.
- **No network in the sandbox** — inference is controller-side, never inside. Disable sandbox egress entirely.
- **Custom template (Dockerfile):** preinstall Python, PIL/OpenCV, ImageMagick (optionally Tesseract for "which chars are present", not web search); **strip `/usr/share/fonts` + fontconfig caches** so no reference fonts exist to render-and-compare.
- **Ephemeral = clean snapshot:** spawn a fresh sandbox per item/run so one run can't seed the next.
- **Render in the controller**, not the sandbox; the sandbox only ever receives the stripped image + the fixed local toolset.
- **Budgets:** max wall-time, tokens, tool calls, image-transform count — otherwise the bench rewards brute-force persistence.
- **Proprietary fonts never leave your infra:** only rendered rasters enter the sandbox. If even that's a concern, **self-host E2B**.

One-line framing: **closed visual sandbox (offline E2B tool executor), inference run controller-side, local image analysis permitted.**

## 10. Cost controls

- MCQ + small grayscale images + single-letter output (logprobs) = minimal tokens.
- **Adaptive eval:** 50 easy items first; only run harder tiers on models that pass.
- **Pairwise battles** for near-duplicates (cheaper than long candidate lists).
- **Cache every rendered specimen** during dev.
- **Public 200-item set** for everyone; **private 1,000-item set** for serious runs.
- Cursor SDK first while direct provider API keys are unavailable; reserve provider-native VLM runs for later canonical comparisons.
- Cheap/fast model variants first; reserve frontier VLMs for finalists/headline comparisons.
- **Local dry-run mode:** generate items + run harness/scoring/leaderboard with dummy/local predictions; hit paid APIs only once the pipeline is stable.
- **Result reuse:** cache by benchmark version + item/render signature + adapter kind + resolved model + model params + prompt version. Do not cache errors; retry them.

## 11. Repo layout

```
font-bench/
  corpus/            # font files (gitignored; proprietary never published)
  render/            # rasterizer + randomization
  oracle/            # glyph-diff (fontTools): determinable vs ambiguous
  distractors/       # similarity-based candidate selection
  dataset/
    public/          # images + hashed key (publishable)
    private/         # held-out (not published)
  harness/
    controller/      # orchestration, agent loop, scoring, logging
    adapters/        # cursor-sdk MVP + later provider-native adapters
      cursor-sdk/    # TypeScript @cursor/sdk bridge
      providers/     # OpenAI / Anthropic / Gemini / local VLMs
    sandbox/         # E2B template (Dockerfile) + tool-executor client
  metrics/           # accuracy, calibration, robustness, cost
  leaderboard/       # static site + confusion-matrix viz
  PLAN.md
```

## 12. Tech stack

- **Python** core: `fontTools` (glyph oracle), `Pillow`/`OpenCV` (render + tools), `numpy`.
- **TypeScript Cursor SDK adapter:** `@cursor/sdk` for MVP hosted inference through the Cursor account; use only behind the adapter boundary.
- **E2B** sandbox (custom template) for the agentic track's offline tool executor; self-hostable if proprietary-font IP must stay on your infra.
- Static **leaderboard** (any SSG) — lead with the confusion matrix and per-tier grid; they market themselves.

## 13. Milestones

- **M0 — Dry pipeline:** corpus loader, renderer, glyph oracle, item schema, scorer, dummy predictions end-to-end. No paid APIs.
- **M1 — MCQ MVP via Cursor SDK:** 100 items, 4 choices, 256×96, `A/B/C/D` scoring; Cursor SDK adapter using image input, strict prompt, exact-letter parser, result cache, and run metadata logging.
- **M2 — Agentic track:** E2B offline tool executor (custom template, fonts stripped), agent loop in controller, budgets + logging.
- **M3 — Provider-native adapters + difficulty:** OpenAI / Anthropic / Gemini / local adapters, similarity distractors, tier grid, ambiguity oracle + calibration metrics.
- **M4 — Public launch:** public 200 / private 1,000 split, leaderboard site, human baseline, confusion-matrix visuals.

## 14. Open questions / defaults

- **Open-track answer matching** (typo/alias tolerance for free-form font names)? *Default:* canonical alias table + exact match.
- **Confidence required or optional?** *Default:* optional; abstention only scored on ambiguous items.
- **Public-set refresh cadence** to fight contamination? *Default:* rotate a fraction each release; keep private set fully held out.
- **Which inference adapter first?** *Default:* Cursor SDK, because Cursor inference is available now; keep provider-native adapters as the canonical later path.
- **Which agent loop** for the agentic track? *Default:* a minimal controller-side loop with the fixed local toolset, executed in E2B. Cursor SDK can be evaluated as an agentic participant, but should be labeled separately from raw provider models.
- **E2B cloud vs self-hosted?** *Default:* cloud to start (only rendered rasters are uploaded); self-host if licensing/IP requires fonts and images stay on your infra.

