---
name: quiet-console
description: Locked visual contract for the apitest-web frontend (Quiet Console). Use when adding or changing any UI in apitest-web — new pages, tables, forms, status displays, dark mode, or responsive work — and when reviewing whether a change respects the design system. Covers tokens, semantic status colors, typography, the single-scroll shell, motion budget, and the antd boundary.
---

# Quiet Console

The approved visual direction for `apitest-web`. It was chosen after
rejecting a neon/glow direction that caused eye fatigue. Do not reintroduce
that direction.

**Single source of truth:** `apitest-web/src/design-system.css`
**Shared primitives:** `apitest-web/src/ui.tsx`
**Theme + antd bridge:** `apitest-web/src/theme.ts`
**Living reference:** `apitest-web/src/theme-preview.tsx` → `/theme-preview.html`

## The five rules

1. **Neutral surfaces, one restrained accent.** Backgrounds and text are
   greys. `--accent` appears only on interactive elements: primary buttons,
   focus rings, the active nav indicator, selected-row edge. Never as
   decoration, never as a fill behind large areas.

2. **Semantic colors are reserved words.** `--pass` `--fail` `--skip`
   `--busy` mean通过/失败/跳过/执行中 and nothing else. They are the only
   colors that carry meaning, which is what lets a user scan a list without
   reading labels. Never reuse them decoratively, never let a theme
   override their intent. Failure is always red — not a theme's secondary hue.

3. **Character comes from type.** Inter for UI, JetBrains Mono for every
   piece of machine data: URLs, HTTP verbs, status codes, durations, JSON,
   variable keys. All numerals use `tabular-nums` so columns align. This is
   where the developer-tool feel comes from — not from glow.

4. **Motion marks state changes only.** Transitions are `--t` (120ms) on
   hover/selection. Exactly one ambient animation is permitted in the whole
   app: the breathing dot on an in-flight request. No scanlines, no drifting
   grids, no pulsing glows. `prefers-reduced-motion` is honored globally.

5. **The shell owns the viewport; only `.content` scrolls.** `.console` is
   `100dvh` with `overflow: hidden`. The sidebar and topbar never scroll.
   This is a deliberate product decision — do not make the nav scrollable.

## Banned

Gradients on surfaces · `box-shadow` used as glow · `backdrop-filter`
scanline or grid overlays · a second accent hue · ambient/looping animation
· semantic colors used for decoration · `Math.floor` on rates and latencies
(keep one decimal) · webfonts loaded from a CDN (use `@fontsource/*`)

## Layout invariants

Verify these after any layout change; each one has regressed before.

- **No horizontal page scroll at any width.** `documentElement.scrollWidth`
  must equal `clientWidth` from 320px up. Flex/grid children default to
  `min-width: auto` and will push the shell wider than the viewport — every
  shell-level container is explicitly `min-width: 0`.
- **No dead space on wide screens.** The shell is full-bleed; the reading
  measure is capped via `.content > * { max-width: var(--measure) }`, not by
  constraining `.content` itself. Capping the container letterboxes the page
  and leaves a visible gap beside the topbar rule.
- **Column headers align to their content.** A right-aligned numeric column
  needs a right-aligned `th` (`.col-num` handles both).
- **HTTP verbs are right-aligned** in a fixed 52px box so `GET` and `DELETE`
  share one edge and the names that follow start on one line.
- **Run-history bars are uniform height.** `skip` reads as absence via a
  hollow fill, not a shorter bar — varying heights make rows look like they
  sag.
- **Breakpoints:** 940px (sidebar becomes a wrapping top bar), 700px
  (wordmark and env chip drop), 560px (readouts go 2-up, assertions stack),
  420px (secondary topbar buttons drop).

## Color and mode

**The palette lives in `theme.ts`, not in CSS.** `PALETTE` is the source of
truth; `applyMode()` writes it onto `<html>` as custom properties and
`antdTheme()` feeds the same values to antd. The `[data-theme]` blocks in
`design-system.css` are only the pre-hydration fallback. Change a color in
both places or they drift.

Never read colors back out of the DOM with `getComputedStyle` to build the
antd theme. An earlier version did, and because the read happened during
render — before the new attribute was committed — antd trailed the shell by
one toggle in every mode switch.

`useMode()` must be called in exactly one component (`Root`). Two callers
means two independent states, and the shell will disagree with antd's
portals.

Switching `algorithm` is mandatory: antd v5 derives container surfaces from
it, so handing dark colors to `defaultAlgorithm` still yields white Drawers
and Selects.

### Contrast floor

Verified against `--surface` (and `--raised` for table headers):

| Text | Light | Dark |
| --- | --- | --- |
| Body (`--ink`) | 17.1:1 | 13.2:1 |
| Secondary (`--ink-3`): paths, headers, labels | 4.68–4.84:1 | 4.9–5.3:1 |
| Status colors | ≥ 4.5:1 | ≥ 4.5:1 |
| Primary button label | 6.6:1 | 7.0:1 |

`--ink-3` in light mode is `#72726b` specifically to clear AA — request
paths and column headers are read constantly. Do not lighten it back toward
`#8b8b84` (3.4:1). Keep at least a 2.5:1 separation between `--ink` and
`--ink-3` so the hierarchy still reads.

## The antd boundary

Behaviour stays with antd; appearance is ours.

- **Keep antd:** `Modal`, `Drawer`, `Form`, `Select`, `message` — these carry
  focus traps, validation, and portal logic worth not rewriting.
- **Hand-write:** shell, nav, tables, buttons, inputs, status, method tags,
  run strips, waterfall, empty states, readouts.
- antd is themed through `antdTheme(mode)` in `theme.ts`, which reads the CSS
  variables at runtime. Add a token there rather than hardcoding a hex.
- Do not import antd `Table`, `Card`, `Statistic`, or `Tag`. They are the
  reason the earlier build looked like a generic admin panel.

## Copy

Active voice, sentence case, no filler. Name things by what the user
controls. An action keeps one name through the whole flow — a button that
says 运行 produces a row that says 执行中. Errors state what happened and
what to do; empty states invite the next action rather than reporting
emptiness.

## Verifying a change

```bash
cd apitest-web && pnpm check && pnpm build
```

Then open `/theme-preview.html`, toggle both modes, and check the widths in
the invariants list above. The reference page imports the real primitives,
so anything that looks wrong there is wrong in the app.
