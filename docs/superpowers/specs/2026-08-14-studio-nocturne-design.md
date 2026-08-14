# Studio Nocturne: the full UI overhaul

Date: 2026-08-14. Status: direction approved by the owner against the comp
(claude.ai artifact 94f9175a, "LOVE IT" plus one amendment, folded in below).
Supersedes the warm re-voice (merged at 7f7e4a7) as Studio's visual direction;
builds on it rather than reverting it.

## Why

The owner's brief: free OSS tools feel bland, and Studio should make people
feel time was spent making it incredible. The warm re-voice kept the bones and
changed the personality; Nocturne is the real overhaul. The Creative Log
dashboard was the reference for feel (airy, crafted, serif display, pastel
tiles), deliberately not copied: Creative Log is a daylight product, and
Hobbyist's identity is sleep and wake. The night is the product, so the design
owns it.

**North star: "Nocturne", the panel at night, lit like a workshop after
hours.** Deep warm dark, a serif with a voice, state dots that read as lights
left on in a dark room, and one theatrical moment when something wakes.

## Decisions taken (owner-answered, 2026-08-14)

1. **Dark-first, same ambition.** The night-operator stance stays. Light
   becomes a translated second theme (warm paper, jewels kept deep), built
   after dark is right, never inverted.
2. **Brand hue plus jewel accents.** Green stays the brand: the awake dot is
   the logo. A four-hue jewel family (sage, iris, honey, rose) exists for
   decoration only: stat tiles and kind identity. State colors stay strict and
   semantic (awake green, waking honey, danger coral, sleeping and undeployed
   chroma-free).
3. **Bundled fonts.** Fraunces (display, 400/600), IBM Plex Sans (UI,
   400/500/600), JetBrains Mono (data and SQL, 400). All OFL, shipped in-repo
   as latin woff2 subsets (~150KB total), loaded via local @font-face. This
   amends the documented "system faces only" constraint: the real rule was
   always offline (no CDN, no network), and bundled files satisfy it. The
   amendment gets recorded in DESIGN.md and a decision entry; if an ADR is
   preferred, it argues exactly this.

## Token system

Dark (home theme):

| Token | Value | Role |
|---|---|---|
| ground | #131110 | page |
| surface | #1a1715 | cards, rail, panels |
| surface-2 | #211d1a | inputs, rests |
| surface-3 | #2a2521 | innermost step, active rows |
| line / line-strong | #2f2925 / #423a32 | hairlines |
| ink / ink-2 / ink-3 | #f2eee6 / #b9ae9f / #998f80 | text ramp |
| accent (brand/awake) | #4ed492, hover #63e0a2, on-accent #052419 | action + awake |
| waking | #e9b45c | transitions |
| danger | #ee8a7c | failure |
| sage | text #97d8b0, chip #1f2f26 | databases |
| iris | text #b6acf5, chip #262239 | apps |
| honey | text #e3b878, chip #332a1a | workers |
| rose | text #e9a3ab, chip #332224 | disk, misc |

Every ink-on-surface and jewel-text-on-chip pairing must clear WCAG AA at its
used size; the contrast pass is a numbered gate before merge, exactly as the
re-voice did it.

Radii scale up a step: 9px controls, 13px containers, 16px modal. Type:
Fraunces for the page display (32px), big numerals and modal titles; Plex Sans
everywhere else in the UI; JetBrains Mono for connection strings, the SQL
editor, the data grid, timings, the machine strip.

Glow vocabulary (new, disciplined): a luminous halo exists only on state dots
(box-shadow ring + soft outer bloom), the awake card's edge-light, and the
primary button's hover. Glow never carries meaning alone: the word and the
shape still do, per the standing colour-is-never-the-label rule.

## Surfaces and components

- **Card sheen:** every container takes a 2-3% top-edge luminance gradient
  over surface, hairline border, soft depth shadow.
- **Night-map cards:** an awake card carries a green-tinted border, an inset
  top edge-light, and a faint ambient glow. Sleeping cards are standard and
  fully legible: calm, never dimmed, never degraded.
- **Jewel stat tiles (owner amendments, both 2026-08-14):** the tile ground
  is neutral dark slate, the same surface family as the cards, one background
  for all four tiles. The hue speaks only through three channels: a subtle
  border in the tile's own hue, a soft colored glow shadow, and the micro
  label. Numerals are serif in plain ink. No colored chip fills: color reads
  as light, not paint.
- **Machine strip:** a mono instrument line under the topbar on the projects
  page: hostname, uptime, a dot-cluster showing awake count as literal lights,
  RAM and disk figures.
- **Glass:** the modal and the project switcher menu take translucent surface
  with backdrop blur and a 16px radius. Only things above the page get glass.
- **Login:** full-page nocturne: radial green breath behind a 44px glowing
  mark, Fraunces wordmark, one field, one button.
- **Chart:** gradient area fill, glowing endpoint dot, mono axis.
- **Empty states:** the Spot drawings stay, redrawn one size larger, duotone
  (ink stroke + one jewel accent per drawing).
- **Wake choreography (the one authored moment):** waking banner gains a honey
  edge sweep; the dot blooms on wake completion. Everything animated is gated
  under prefers-reduced-motion, including the sweep, the breath, and the card
  rise.

## What survives untouched

- Layout grids, the shared measure, breakpoints, workbench structure.
- Waking banner thresholds (350ms/900ms) and the failed banner keeping its
  clock.
- Modal focus trap, keyboard paths, sr-only state words.
- **The No-Tinted-Pill Rule.** The reference's filled violet nav pill stays
  banned; active rows remain neutral surface-3 fills.
- Sleeping-is-not-a-warning, undeployed's dashed ring and missing wake button.
- The class audit, and the additive-edit discipline on theme.css.

## Explicitly out of scope

- New views or data-model work (D1 owns Studio's all-kinds model).
- Light theme shipping alongside dark in the same commits. Sequencing is
  fixed: dark lands complete first (phases 1-4), light follows as its own
  phase-5 commit series on the same branch, and the branch merges once with
  both themes contrast-gated. The branch never merges dark-only.
- Any network-loaded asset. The box may have no internet; everything ships in
  the repo.

## Phases

1. **Foundation:** fonts into `packages/studio` (files + @font-face in
   theme.css), constraint amendment recorded.
2. **Tokens:** nocturne ramp, jewel family, glow shadows, radii. Contrast
   gate runs here, numerically.
3. **Surfaces:** sheen, night-map cards, machine strip, jewel tiles, glass
   modal/switcher, rail with kind-hued icons.
4. **Moments:** wake choreography, login nocturne, chart.
5. **Light theme:** translated, contrast-gated.
6. **Verify and document:** class audit, tsc, build, full suite, impeccable
   detector, fixture-daemon Playwright round (dark, light, reduced motion),
   DESIGN.md rewritten for Nocturne, decision entry updated.

Verification mirrors the re-voice run: the fixture stub daemon and Playwright
harness in the session scratchpad are the template; artifact checkpoints to
the owner at the end of phase 3 (first real screenshots) and phase 6 (shipped).

## Coordination

Branch `studio-nocturne` from main 7f7e4a7, packages/studio only. The
record-before-code and queues sessions own core/cli/worker; the lane split
from decision `hobbyist.studio-revoice` carries over unchanged. D1 builds on
Nocturne once merged.
