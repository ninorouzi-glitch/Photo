# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Was das ist

**Lichttisch** — a client-side tool that measures the images of one Instagram post
against each other and brings them onto a common denominator. Vanilla TypeScript +
Vite, no framework, no dependencies beyond the toolchain. Nothing leaves the machine.

The project is built against a German PRD that is not in the repo. Code comments,
UI copy, test names and commit-level reasoning reference it by section (`§8`, `§9.2`)
and requirement id (`F-01`, `A-03`, `P5`). Preserve those references when editing —
they are the only trace of the spec left in the tree. **Everything user-facing and
every comment is in German**; match that.

## Commands

```bash
npm run dev                       # Vite on :5173
npm run build                     # tsc (typecheck, noEmit) then vite build
npm test                          # vitest run — the measurement core against §13 fixtures
npm run test:watch
npm run test:e2e                  # Playwright; spawns its own vite on :5174 (strictPort)

npx vitest run test/copy.test.ts                     # single file
npx vitest run -t 'A-01'                             # single test / describe by name
npx playwright test e2e/edge.spec.ts --headed
```

`tsc` runs with `strict`, `noUnusedLocals`, `noUnusedParameters`,
`erasableSyntaxOnly`, and `allowImportingTsExtensions` — **intra-project imports
must carry the `.ts` extension** (`'../core/types.ts'`).

## Architecture

The one line that matters: **`src/core/` versus everything else.**

`src/core/` is pure functions over `Frame` (`{ data, width, height }`) — structurally
an `ImageData` but a plain object, so measurement and correction run in Node with no
canvas and can be checked against synthetic images with an exactly known deviation.
Nothing in `core/` may touch the DOM, `ImageData`, or `ImageBitmap`. That constraint
is what makes `test/acceptance.test.ts` possible; breaking it silently guts the test
suite's value.

Data flow:

```
File → analyze.worker → decode.ts (createImageBitmap ×2: full + 640px)
                          ↓
                        core/stats.ts → Stats  ─┐
                                                ├→ store.derive() → target + deviations
                        core/target.ts ─────────┘        (median over the set, or an anchor image)
                          ↓
UI stage 03/04 → render.ts → crop.ts → apply.ts/lut.ts → pixels
                          ↓
                        exporter.ts → 1080px JPEG q92
```

**Store** (`src/state/store.ts`) — one object, `subscribe`/`set`. `target` and
`deviations` are *derived* on every mutation, never hand-maintained. That is why
stage 03 changes show up in stage 04 with no "Apply" step. `setItems` replaces the
list wholesale: stage 01 owns selection order, because the worker returns results in
completion order, not selection order (F-01).

**Worker** (`src/pipeline/`) — decode + measure off the main thread; the bitmap is
transferred, not copied. `decode.ts` also emits the 640px preview blob, deliberately:
pointing an `<img>` at the original file decodes a 24MP JPEG on the main thread and
froze the renderer in testing. Measurement was never the bottleneck; the preview was.

**Order of operations in `apply.ts` is normative (§9.2)**: white balance and tone
curve are baked into three LUTs, *then* saturation, grain, sharpen. Reordering
changes the output. `Recipe.neutral` short-circuits every pixel op at strength 0 —
required for A-03 (bit-identical to the cropped original); an identity LUT plus
rounding does not satisfy it.

**Pixel precision is load-bearing** (`test/quality.test.ts` guards it):
`Luts` are `Float32Array`, not `Uint8ClampedArray` — the whole LUT + saturation
chain runs in float and rounds exactly once, on write into the frame. A 4×4 Bayer
dither of ±0.5 LSB is added before that single rounding, because the tone curve
compresses 256 input levels into fewer output levels and the seams show as banding
in smooth gradients. The dither is spatial and fixed, so F-21 determinism holds.

**Previews render in device pixels.** `previewScale()` (capped at 2) multiplies the
canvas backing store; CSS still sizes the element. Stage 03 runs two passes — a
1× pass while the slider or crop drag is moving, then a sharp pass 140ms after it
settles — because a device-resolution redraw cannot meet the 150ms budget per tick.
`renderTo(..., { reuseGeometry: true })` caches the cropped+scaled bitmap next to
the destination canvas (keyed on image/ratio/crop/size), so slider ticks only rerun
the LUT pass. Export deliberately does *not* reuse geometry — each canvas is used once.

**UI** (`src/ui/`) — four stages, each exporting `render(root, ctx)`, wired by
`src/main.ts` via a shared `Ctx` (`store`, `go`, `rerender`, `live`). `dom.ts` has a
tiny `el()` helper standing in for a framework. Stages 02–04 are locked until
`MIN_IMAGES` (2) images exist. Stage 03's strength slider redraws only the preview
canvases, not the stage — a full rebuild loses slider focus and blows the 150ms budget.

## Aspect ratio

`Settings.ratio` is `'4:5' | '1:1' | '1.91:1' | 'custom'`; when it is `'custom'`
the numbers live in `Settings.customRatio: { w, h }`. **Never write
`RATIOS[settings.ratio]`** — `RATIOS` only holds the three presets and `'custom'`
has no fixed value. Everything that needs a number calls `aspectOf(settings)`
(`src/core/crop.ts`), which also clamps to `MIN_ASPECT`…`MAX_ASPECT` (1:4 … 4:1)
and falls back to 1 for NaN/0/negative — an empty number input arrives as `NaN`.
`exportSize` and `previewSize` take an aspect *number*, not a `Ratio` key.

The ratio is per set, never per image: a carousel that changes width mid-post
defeats the whole premise. `IG_MIN_ASPECT`/`IG_MAX_ASPECT` drive an advisory note
only — a ratio outside Instagram's band is cropped as asked, with a warning.

## Tuning points

- `THRESHOLDS` in `src/core/deviation.ts` — the whole warn/crit matrix, deliberately
  in one place. Derived from synthetic fixtures; meant to be re-tuned after the first
  twenty real sets.
- `MEASURE_EDGE` (640), `MAX_PIXELS` (50MP), `MAX_IMAGES` (20) in `src/core/types.ts`.
- `PREVIEW_EDGE` (540) in `src/pipeline/render.ts`.

## Known, documented deviations — do not "fix" silently

Three points where the code departs from the spec or falls short, each already
argued in a comment at the site and in the README. If you change one, move the
argument with it.

1. **Exposure metric** (`core/deviation.ts`): `max(4, …)` instead of the spec's
   additive `+4` offset, which shrinks every real deviation and breaks A-01.
2. **Export fallback** (`pipeline/exporter.ts`): individual downloads instead of a
   ZIP where the File System Access API is missing. Three tiers: directory picker →
   downloads → F-23 manual save.
2b. **Output resolution** (`pipeline/render.ts`): F-22 fixes 1080px width; the
   default is now `output: 'original'`, which exports the crop at its native pixel
   size (a 1:1 blit, no resampling at all). `'1080'` remains as a user choice. Do not
   re-hardcode 1080 — `exportSize(ratio, output, source)` takes the source bitmap.
3. **Saturation** (`core/apply.ts`): measured as `(max−min)/max` (§8.3) but applied
   as `L + (c−L)·f` (§9.5). Not the same measure, so convergence is approximate;
   A-02 therefore only checks direction for saturation.

## Tests

- `test/fixtures/generate.ts` — the §13 test set, built from one deterministic base
  scene with known deviations (±EV, channel scaling, blur, crop). Values stay in
  20…200 so channel scaling never clips into saturation and skews the measurement.
- `test/acceptance.test.ts` — A-01…A-04 against those fixtures.
- `test/fixtures/write.test.ts` — writes the fixtures as PNGs to `test/fixtures/out/`
  as a side effect of the test run, so the files can't go stale.
- `e2e/performance.spec.ts` — the §13 budget. Lives in Playwright, not vitest,
  because Chrome throttles timers and `toBlob` in background tabs; it asserts
  `visibilityState === 'visible'` first and measures main-thread blocking via
  `MessageChannel`, not timers.

Determinism is a requirement, not a nicety: grain is seeded per image id
(`seedOf` in `render.ts`), the order suggestion is a nearest-neighbour walk with no
randomness (F-21), and the fixture PRNG is fixed-seed.
