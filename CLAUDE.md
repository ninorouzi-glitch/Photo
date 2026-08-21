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

**Stats carries per-channel CDFs** (`cdfR`/`cdfG`/`cdfB`, next to the luma `cdf`) —
falling out of the same measuring pass. They exist for one purpose: estimating how far
a planned channel gain pushes pixels into the rails, which is a per-channel question a
luma distribution cannot answer. **Not** for per-channel histogram matching — pulling
each channel onto its own target would itself be a white balance and would work against
`channelGains`, leaving a doubly corrected, neutralised colour character. The tone curve
is still built from the luma CDF alone. `clippedRatio` rides along: the share of pixels
dropped by the per-channel clipping test. So does `satA` — the mean `L/max`
**weighted by each pixel's saturation**, which is what converts the §8.3 measure
into the §9.5 operator (deviation 3b). The weighting is the point: a smooth sky
sits at `a ≈ 0.97` and contributes almost nothing to the measured saturation, so
it must not decide the mean. Unweighted, three quarters of the error stays.

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
  twenty real sets. The `tint` row is the exception: it is not measured against §13
  but derived from the `warmth` row via the 2/3 damping in `channelGains`, and is
  marked provisional at the site. Re-tune it first.
- `MEASURE_EDGE` (640), `MAX_PIXELS` (50MP), `MAX_IMAGES` (20) in `src/core/types.ts`.
- `MEASURE_AREA` (0.8) / `MEASURE_INSET` (derived, ≈5.3 % per side) in `types.ts` — the
  central share of the frame every global measurement runs on, so lens vignetting does
  not drag brightness down; `aspect` is the one exception and still comes from the
  whole image.
- `MIN_CONTRAST` (4) in `types.ts` — one floor for both the clamped `contrast` value
  and the contrast normalisation of sharpness and noise. Those must be the same number,
  otherwise a flat image is normalised against a contrast it does not have.
- `CLIP_HIGH` (250) / `CLIP_LOW` (5) in `src/core/stats.ts` — per-channel bounds beyond
  which a pixel is not a usable colour sample (warmth, tint, saturation). Not a
  saturation mask: saturated colours stay in as long as no channel is at the rail.
- `SAMPLE_STEPS` ([7, 11, 13, 17]) in `stats.ts` — the palette sample walks the pixels
  with the first of these that does not divide the frame width, so it cannot lock onto
  a single column phase.
- `PREVIEW_EDGE` (540) in `src/pipeline/render.ts`.

## Rules for changes

- **No linear light in `core/`.** There is no sRGB EOTF and no linear working
  space; every measurement runs on gamma-encoded code values. That is a decision,
  not a gap. No half-linearisation at individual sites — either throughout or not
  at all, and throughout breaks every fixture and every threshold.
- **German everywhere user-facing, and in every comment.** New functionality with
  no counterpart in the spec does not get an invented requirement id; it gets an
  explaining comment instead.
- **Determinism is a requirement (F-21), not a convenience.** No `Math.random`, no
  dependence on time or on the order things happen to arrive, anywhere in `core/`.
- **The documented deviations are not repaired in silence.** Touching one means
  saying so and moving the argument with it.
- **150 ms per slider tick in stage 03 is a hard limit**, not a target.
- **Quantify before repairing.** Before a site documented as weak gets "fixed",
  measure how large the error actually is. Twice now an obviously unclean site
  turned out to be balanced — see the interpolated inverse in `lut.ts` — and the
  obvious correction would have made the result worse.

## Known, documented deviations — do not "fix" silently

The points below are where the code departs from the spec or falls short, each
already argued in a comment at the site and in the README. If you change one, move the
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
3. **Saturation measured before the white balance runs** (`core/apply.ts`). A
   colour cast reads as saturation in `(max−min)/max`: §13's image 03 (B × 1.35)
   measures 0.369 and has almost none. The white balance removes the cast — after
   the LUTs the same image sits at 0.174 — but the factor is built from the
   *pre-LUT* stats and then applied to the de-cast image, so it desaturates a
   second time (down to 0.107). Measured on synthetic casts the post-LUT
   saturation drops by up to 58 %, and in the extreme the sign of the task flips
   (r = 0.51 before the LUTs, 1.21 after). On a real set whose images already
   look alike it is ≈1 %.

   The conversion in point 3b does **not** fix this and makes it visible in one
   §13 case, because until now two errors partly cancelled: the factor was too
   weak, and it was aimed at an inflated measurement. That is why A-02 still
   checks saturation against a fraction of the initial spread instead of the
   `(1−s)·before` bound the other criteria carry — it comes out at 0.114 against
   0.112, and the 2 % missing are this and the §9.5 cap on image 04, not the
   metric.

   The fix is known and belongs with another task, not here: saturation cannot be
   reconstructed from marginal distributions, but it can from a joint one.
   `palette()` already builds an 8³ RGB grid and throws it away. Keeping its
   counts/sums lets saturation *and* `satA` be estimated after the white balance
   from 512 bin centres. The planned outlier detection needs the same grid — the
   two should be done together.
3b. **Saturation: §8.3 and §9.5 are different quantities** (`core/apply.ts`), and
   the factor converts one into the other. With `a = L/max` per pixel, `L + (c−L)·f`
   gives exactly `S′/S = f / (a + (1−a)·f)`, so `f = r·a / (1 − r + r·a)` for a
   wanted ratio `r`. `f = r` — what the code did until now — is only right at
   `a = 0`, and left a systematic undercorrection of ≈20 % of the required change
   at strength 1, ≈43 % at 0.7. `Stats.satA` carries the `a`, weighted by each
   pixel's saturation; the residual is now under 1 % (`test/saettigung.test.ts`).
   Two things stay: `a` is a mean over a relation that is nonlinear in `a` (hence
   under 1 % rather than zero), and `MAX_SAT_FACTOR` (2.0) caps `f` from above as
   a **gamut** guard, not as §9.5 — that cap belongs to the clipping guard when it
   arrives.
4. **Tone matching is approximate by construction** (`core/lut.ts`). Two
   architectural reasons, neither of them a bug:
   - the curve is built from the **luma** CDF but applied to **each channel**
     through the same table, so a coloured image never lands exactly on the
     luma target it was fitted to;
   - the **white balance runs before the curve** — the gains shift the
     distribution the curve was fitted against, so the curve sees different
     input than it was built for.

   Consequence: `exposure`, `contrast`, `p01` and `p99` keep a systematic
   residual even at strength 1. On the §13 set, tone-curve-only at strength 1,
   the mean residual is ≈0.8 code values on p01 and ≈2.1 on p99. **That is
   expected. Do not read it as a defect and do not chase it with tighter
   thresholds.**

   The only real fix is luma matching with chroma preserved — which cannot be
   folded into one table per channel, costs the LUT collapse in `buildLuts`,
   and with it the 150 ms slider budget. Not worth it. The two precision errors
   that *were* worth fixing (edge-tapered smoothing window, interpolated
   inverse) are already fixed and guarded by `test/lut.test.ts`; that test
   measures the curve against a fixture with a known ground-truth mapping, and
   it is the place to check whether a change to `toneCurve` helps or hurts.

## Tests

- `test/fixtures/generate.ts` — two separate sets. `testSet()` is the §13 set, built
  from one deterministic base scene with known deviations (±EV, channel scaling, blur,
  crop); it stays at five images and values stay in 20…200 so channel scaling never
  clips into saturation and skews the measurement. `measurementSet()` holds the
  measurement fixtures (clipped red channel, period-4 stripes, vignette) and **must
  never reach target computation**: a clipped band and a vignette are not photographs
  from the same post, and in the set they drag the median and the initial spread far
  enough that A-02's convergence bounds measure something other than convergence.
- `test/acceptance.test.ts` — A-01…A-04 against `testSet()`.
- `test/stats.test.ts` — the measurement fixes, each against its own fixture from
  `measurementSet()`.
- `test/fixtures/write.test.ts` — writes both sets as PNGs to `test/fixtures/out/`
  as a side effect of the test run, so the files can't go stale.
- `e2e/performance.spec.ts` — the §13 budget. Lives in Playwright, not vitest,
  because Chrome throttles timers and `toBlob` in background tabs; it asserts
  `visibilityState === 'visible'` first and measures main-thread blocking via
  `MessageChannel`, not timers.

Determinism is a requirement, not a nicety: grain is seeded per image id
(`seedOf` in `render.ts`), the order suggestion is a nearest-neighbour walk with no
randomness (F-21), and the fixture PRNG is fixed-seed.
