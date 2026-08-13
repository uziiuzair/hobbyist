---
name: Hobbyist Studio
description: The panel at night, lit like a workshop after hours.
colors:
  ground: "#131110"
  surface: "#1a1715"
  surface-2: "#211d1a"
  surface-3: "#2a2521"
  line: "#2f2925"
  line-strong: "#423a32"
  ink: "#f2eee6"
  ink-2: "#b9ae9f"
  ink-3: "#998f80"
  accent: "#4ed492"
  accent-hover: "#63e0a2"
  accent-ink: "#052419"
  accent-dim: "rgba(78, 212, 146, 0.14)"
  accent-line: "rgba(78, 212, 146, 0.34)"
  awake: "#4ed492"
  awake-dim: "rgba(78, 212, 146, 0.14)"
  awake-ring: "rgba(78, 212, 146, 0.34)"
  waking: "#e9b45c"
  waking-dim: "rgba(233, 180, 92, 0.13)"
  danger: "#ee8a7c"
  danger-dim: "rgba(238, 138, 124, 0.12)"
  sage: "#97d8b0"
  iris: "#b6acf5"
  honey: "#e3b878"
  rose: "#e9a3ab"
  glow-awake: "rgba(78, 212, 146, 0.28)"
  glow-waking: "rgba(233, 180, 92, 0.3)"
typography:
  display:
    fontFamily: "Fraunces, Georgia, Times New Roman, serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.015em"
  title:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "15.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  subtitle:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  body:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body-secondary:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  micro:
    fontFamily: "IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.08em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
rounded:
  sm: "9px"
  md: "13px"
  lg: "16px"
  pill: "50%"
  hairline: "3px"
spacing:
  hair: "2px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  gutter: "24px"
  page-top: "26px"
  page-bottom: "64px"
components:
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  button-hover:
    backgroundColor: "{colors.surface-3}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-danger:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  button-sm:
    padding: "4px 8px"
    typography: "{typography.label}"
  input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "14px 15px"
  card-hover:
    backgroundColor: "{colors.surface-2}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "15px"
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    width: "440px"
  rail-link:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    padding: "7px 8px"
  rail-link-active:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
  state-dot:
    size: "7px"
    rounded: "{rounded.pill}"
  waking-banner:
    backgroundColor: "{colors.waking-dim}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 13px"
---

# Design System: Hobbyist Studio

## Overview

**Creative North Star: "Nocturne", the panel at night, lit like a workshop
after hours (2026-08-14, owner-approved overhaul)**

This is a status panel for hardware in the next room, not a console for a
service you rent. Sleep and wake are the product, so the design owns the
night instead of borrowing daylight SaaS: a deep warm dark, a display serif
with a voice, state dots that read as lights left on in a dark room, and one
theatrical moment when something wakes. A sleeping database is the product
working correctly, so it is the calmest thing on the screen.

Density is high and ornament is earned. Interactive elements answer the
cursor over 120-160ms, a link card rises 2px onto a lift shadow, the waking
banner carries a honey light sweep along its top edge, the login mark
breathes, and every one of those disappears under `prefers-reduced-motion`.
Depth is tonal layering plus a small disciplined glow vocabulary; the modal
and the switcher menu are the only glass. Dark is the design's home because
the operator is usually at a desk at night; light is a complete second theme
(warm paper, jewels kept deep, never an inversion).

The world runs entirely offline: no CDN, no network-loaded asset, ever. The
three faces (Fraunces, IBM Plex Sans, JetBrains Mono, all OFL) are bundled
woff2 files in `src/fonts`, loaded by local `@font-face`. The old "system
fonts only" wording was amended 2026-08-14: the real rule was always
offline, and bundled files satisfy it (see the Nocturne spec).

Product voice, terminology and interaction conventions live in `PRODUCT.md` and
are not restated here; this file is strictly visual.

**Key Characteristics:**
- Warm near-black layered ground (graphite and stone) with hairline rules
- Green is the brand and the awake state; a four-hue jewel family (sage,
  iris, honey, rose) exists for decoration only: tiles and kind identity
- Sleeping carries no chroma at all, and neither does not-deployed
- Fraunces speaks only in the display register: page titles, tile numerals,
  modal and empty-state headings; Plex Sans is the interface, JetBrains Mono
  is the data
- Dense rows, tabular figures anywhere a number can change
- Glow is a vocabulary, not a wash: state dots, the awake card's edge light,
  primary hover, and nothing else
- Active rows are neutral facts, never tinted pills (the No-Tinted-Pill Rule)
- The browser's own surfaces are themed: green caret, hairline scrollbars, accent selection

## Colors

A warm dark ground with one brand voice (green), a decorative jewel family
that never touches state, an amber reserved for transitions and a red
reserved for failure.

### Primary
- **Signal Green** (`--accent` / `--awake`, #4ed492 dark, #147a48 light): the
  brand. It does two jobs and the same hex serves both: action (a filled
  primary button, an active tab's underline, a focus ring, a hovered link)
  and state (the 7px awake dot with its halo and glow, an awake meter fill,
  the awake card's edge light). `--awake` resolves to `var(--accent)` in both
  themes, so there is one green in the file and one green on the screen.

### Jewels (decorative only)
- **Sage** (`--sage`, #97d8b0 dark / #1f6b43 light): databases.
- **Iris** (`--iris`, #b6acf5 / #5a4fb8): apps.
- **Honey** (`--honey-t`, #e3b878 / #8a5f14): workers.
- **Rose** (`--rose`, #e9a3ab / #a84a55): disk and the miscellaneous tile.

The jewels exist in exactly two places: the stat tiles (border, glow and
label, on a shared dark slate ground, per the owner's two amendments) and the
rail's kind icons. They never mark state, never fill a surface, and never
appear on a control.

### Secondary
- **Transition Amber** (`--waking`, honey #e9b45c dark, #8a5a0e light): waking,
  starting, stopping, creating and removing. It never marks a resting state.
  Used as the waking dot, the waking banner's edge and wash, and the elapsed
  clock.

### Tertiary
- **Fault Red** (`--danger`, warm coral #ee8a7c dark, #b3392c light): failure and
  destruction only. Error banners, failed dots, the delete affordance on a
  side-list row, and the danger button's text and hover wash.

### Utility
- **Scrim** (`--scrim`, rgba(0,0,0,0.55) in both themes): the modal backdrop.
  Deliberately not themed: a light-mode modal over a pale scrim floats on
  nothing.
- **Bar radius** (`--radius-bar`, 2px): the meter track and fill only. A 4px
  tall bar cannot take the 5px radius without reading as a lozenge.

### Neutral

The whole neutral ramp is warm: graphite and stone around hue 38, in both
themes. A cool gray anywhere in this file is a regression to the first build.

- **Ground** (#131110 dark, #faf9f7 light): the page behind everything.
- **Surface** (#1a1715 / #ffffff): cards, panels, tables, the rail, modals,
  and the tiles' shared slate.
- **Surface 2** (#211d1a / #f6f4f1): inputs, buttons at rest, table headers,
  row hover, modal footers.
- **Surface 3** (#2a2521 / #edeae4): the innermost step. Connection strings,
  meter tracks, button hover, and the active row's fill.
- **Line** (#2f2925 / #e6e2db) and **Line Strong** (#423a32 / #cfc9bf): every
  border in the system is 1px of one of these. Line Strong is for edges that
  must be found (button outlines, dashed empty states, menus, modals).
- **Ink** (#f2eee6 / #1c1917), **Ink 2** (#b9ae9f / #5f5a52), **Ink 3**
  (#998f80 / #6e685e): primary, secondary and tertiary text. Every pairing
  in both themes is enforced numerically by `scripts/audit-contrast.mjs`,
  which runs inside `npm run build` beside the class audit and fails the
  build below 4.5:1. That gate, not this paragraph, is the authority.

### Named Rules

**The One Brand Rule** (amends the old One Green Rule, 2026-08-14). Green is
the single brand and state voice and still resolves from one token: do not
fork `--awake` away from `--accent`. The jewel family is not an exception but
a separate register: decorative, confined to tiles and kind icons, never on a
control, never marking state. If a jewel hue ever answers the question "can I
press this" or "is this running", it is being misused.

**The Action/State Form Rule.** Action is a large filled surface or an edge:
a primary button, a 2px tab underline, a focus outline, a tinted active row.
State is small and glowing or a bar: a 7px dot with a 3px halo, a 4px meter
fill. A green rectangle you can press and a green dot you cannot are never
confusable because their form differs, not their colour.

**The Sleeping-Is-Not-A-Warning Rule.** Sleeping carries no chroma at all: a
transparent dot with a 1.5px `--ink-3` ring and neutral label text. It is never
amber, never red, never dimmed to look broken. Sleeping is the product working.

**The Colour-Is-Never-The-Label Rule.** Every state renders a word beside its
mark, and the mark's shape (filled, hollow ring, pulsing, solid red) carries
the same distinction the colour does. Nothing in this interface is legible only
to someone who can separate the hues.

**The Ink 3 Floor Rule.** `--ink-3` is the dimmest text in the system and it is
tuned to pass WCAG AA as body text on every surface step in both themes.
Nothing dimmer exists. Do not add a fourth ink step.

**The No-Tinted-Pill Rule.** An active or selected row (rail link, workbench
table, side-list item, pressed segment) is a neutral fact: `--surface-3` fill,
`--ink` text, a touch more weight, and the green confined to the row's icon.
Never the accent-tinted pill, and never an accent edge bar down the row's
leading side: that pairing is the stock AI-dashboard active state, it spends
chroma on something that is neither action nor state, and it is banned
outright (operator's explicit call, 2026-08-13). The pressed segment
substitutes an inset 1px `--line-strong` ring for the weight change, because a
segment that gains weight gains width and the control jitters.

## Typography

**Display Font:** Fraunces (bundled, 400/600), falling back to Georgia.
**Interface Font:** IBM Plex Sans (bundled, 400/500/600), falling back to the
system stack.
**Mono Font:** JetBrains Mono (bundled, 400), falling back to system mono.

All three ship as latin woff2 subsets in `src/fonts` (~128KB, OFL licenses
alongside) and load via local `@font-face`. Nothing is fetched at runtime;
the fallback stacks exist so a corrupted file degrades instead of breaking.
Fraunces is a saturated choice on the open web; it is pinned here by the
owner's explicit approval of the Nocturne comp, and the detector warning
about it is acknowledged, not actionable.

**Character:** a serif that speaks and an interface that works. Fraunces
appears only in the display register: the page title, tile numerals, modal
and empty-state headings, the login wordmark. It never sets body copy, a
control, or a table. Plex Sans carries everything interactive at 10.5-14px;
JetBrains Mono carries everything that is data. The register split is what
keeps a dense instrument panel from reading as a marketing page even with a
display face in the room.

### Hierarchy
- **Display** (Fraunces 600, 30px, -0.012em): the page title, one per view.
  Tile numerals sit at 28px, the login wordmark at 28px.
- **Title** (Fraunces 600, 18px, -0.01em): modal titles and empty-state
  headings.
- **Subtitle** (600, 14.5px, -0.01em): card titles, truncated with an ellipsis.
- **Body** (400, 14px, 1.5): the document default set on `body`.
- **Body secondary** (400, 13.5px): page subtitles, rail links, inputs, field
  text, empty-state copy. Empty-state paragraphs cap at 42ch.
- **Label** (400-500, 12.5-13px): buttons, table cells, state text, breadcrumbs,
  card meta.
- **Micro** (600, 10.5-11px, 0.06-0.08em, sentence case content in uppercase
  presentation): rail group labels, section titles, table headers, meter labels,
  key and foreign-key tags. This is the only uppercase in the system.
- **Mono** (400, 12-13px): connection strings, the SQL editor (13px / 1.6),
  numeric table cells, query timings, snippet names.

### Named Rules

**The Tabular Figures Rule.** Any number that can change in place gets
`font-variant-numeric: tabular-nums`: the waking clock, meter values, result
counts, card meta, rail counts, numeric table cells. A jittering digit reads as
instability in a product whose whole claim is that waiting is fine.

**The One Uppercase Register Rule.** Uppercase exists only at 10.5-11px with
0.06-0.08em tracking, as a structural label above or beside content. Titles,
buttons and body copy are never uppercased.

## Layout

The shell is a two-column grid: a 248px sticky rail (`--rail`) and the main
column. The main column holds a 52px sticky topbar (`--topbar`) with a blurred
88% ground wash, then the page.

**The measure is shared and it is not optional.** `.measure` owns the
max-width (1180px), the auto margins and the 24px horizontal gutter.
`.page` owns only `padding-block: 26px 64px`. The topbar's inner div and every
page root carry `.measure`, which is what puts a breadcrumb exactly above its
page title at every width and keeps the content column centred on a wide
display instead of hugging the rail.

Two grids inside the page:
- **Projects**: `minmax(0, 1fr)` cards beside a 268px capacity panel, the panel
  sticky under the topbar; it collapses to one column at 1040px and moves above
  the cards.
- **Workspace** (`.sql-editor-shell`, used by Tables and Sql): a 216px sticky
  index beside `minmax(0, 1fr)` of work. It is a grid, not a stack, because the
  index has to stay visible while you work. Collapses at 860px. The index is
  height-bounded as a whole (`calc(100vh - var(--topbar) - 48px)`) so two lists
  cannot together exceed the viewport.
- Cards auto-fill at `minmax(280px, 1fr)` with a 12px gap.

Rhythm is dense: 2/6/7/8/9/10/12/14/16px gaps, 24px page gutter, 9-15px
component padding. Rows are 38px minimum in card feet and 9px vertical in
tables.

Breakpoints, in the order they fire: 1040px (capacity panel stacks), 900px (the
rail becomes a horizontal scrolling strip, group labels hide, page padding drops
to 18px/14px), 860px (workspace collapses to one column, indexes unstick),
560px (modals become bottom sheets).

### Named Rules

**The Shared Measure Rule.** Every page root is `<div className="page measure">`
and the topbar's inner wrapper is `.measure`. A view that carries `.page` alone
renders flush against the rail with no gutter. This mistake has already been
made once in every inner view; it is the first thing to check on a new view.

**The min-width: 0 Rule.** Every grid or flex child that can receive
unbounded content declares `min-width: 0`: `.main`, `.measure`, `.card`,
`.card-body`, `.connstring`, `.crumbs`, `.waking-text`, and both workspace
columns via `minmax(0, 1fr)`. Without it one long connection string or one wide
table takes its intrinsic width, widens the document, and pushes the rail off
screen. `.main` also carries `overflow-x: clip` as the backstop. Truncation is
`overflow: hidden` plus `text-overflow: ellipsis` plus `white-space: nowrap` on
the text node itself, never a fixed width.

## Elevation & Depth

This system is **tonally layered, with light where something is alive**.
Depth is four ground steps (`--ground` → `--surface` → `--surface-2` →
`--surface-3`) separated by 1px hairlines, a 2-3% top-edge sheen gradient on
cards and tiles, and a small glow vocabulary that only ever means "running".

### Shadow Vocabulary
- **Card seat** (`--shadow-card`): a hairline top highlight and a soft 1-3px
  drop that seats a card on the ground. Not perceived as lift.
- **Lift** (`--shadow-lift`): genuine rise, used only by a hovered link card
  together with its 2px `translateY`, and by the jewel tiles' colored
  shadows. A hover is a moment, not a layer.
- **Pop** (`--shadow-pop`): only for things that genuinely float above the
  document, which is exactly two: the project switcher menu and the modal.
  Both are the system's only glass: translucent color-mix surface with a
  20-24px backdrop blur, still legible where backdrop-filter is unsupported
  because the mix keeps 86-90% opacity.

Beyond those, "elevation" is expressed as an inset ring: `box-shadow: inset 0 0 0 1px`
marks an editable cell on hover (`--line-strong`) and on focus (`--accent`),
and the pressed segment.

### Named Rules

**The Flat-By-Default Rule.** A new container gets `--surface`, the sheen, a
1px `--line` border and `--radius`. It does not get a lift or pop shadow.
`--shadow-pop` is reserved for elements in a stacking context above the page
(z-index 40+); if it is in the document flow, it is flat.

**The Glow-Means-Running Rule** (amends Halo-Not-Glow, 2026-08-14). Glow is
`--glow-awake` / `--glow-waking` and appears in exactly five places: the
state dots' outer bloom, the rail mark when anything is awake, the machine
strip's lit cluster dots, the awake card's edge light and ambient, and the
chart's endpoint. It marks live state and never decorates: no glowing text,
no glowing buttons at rest, no glowing borders on things that are not
running. The jewel tiles' colored shadows are shadows, not glows: they are
static, they carry no state, and they never pulse.

## Shapes

Three radii carry everything: **13px** (`--radius`) for containers that hold
content (cards, tiles, panels, tables, the SQL editor, empty states, menus),
**9px** (`--radius-sm`) for controls and small chrome (buttons, inputs,
segmented controls, notices, banners, rail links, the connection string, the
brand mark), and **16px** (`--radius-lg`) for the modal alone, one softer
step for the one surface that floats. Below those, 3px appears on the two
smallest marks (editable cell, key tags, the focus ring's own corner) and
50% on dots.

Everything is a rectangle with a 1px border. There are no dividers that are not
borders: separation is `border-bottom: 1px solid var(--line)` on the row, with
`:last-child { border-bottom: 0 }`. Dashed 1px `--line-strong` is reserved for
empty states, and it is the only dashed edge in the system.

Icons are inline SVG at 12-14px with 1.2-1.4 stroke width and `currentColor`,
drawn in the component that uses them. There is no icon font and no icon
package.

### Named Rules

**The Hairline Rule.** Every border in the build is exactly 1px. Emphasis comes
from choosing `--line-strong` over `--line`, never from a thicker rule. The two
exceptions are deliberate marks, not borders: the 1.5px sleeping ring and the
2px active tab underline.

## Components

### Buttons
- **Shape:** softly rounded control (5px), 7px/12px padding, 13px/500, never wraps.
- **Default:** `--surface-2` fill, 1px `--line-strong` border, `--ink` text;
  hover moves the fill to `--surface-3`.
- **Primary:** the only large filled green surface in the product. `--accent`
  fill and border with `--accent-ink` text at 600. Hover moves both fill and
  border to `--accent-hover`. Disabled primary keeps its green and drops to 0.5
  opacity, so a pending action still reads as the action.
- **Danger:** `--danger` text on the default chrome, `--danger-dim` wash on
  hover. It never fills.
- **Ghost:** transparent fill and border, `--ink-2` text, `--surface-2` on hover.
- **Small:** 4px/8px, 12.5px.
- **Focus:** universal `:focus-visible` of a 2px `--focus` outline at 2px offset
  with a 3px corner. No component overrides it.

### Inputs / Fields
- **Style:** `--surface-2` fill, 1px `--line` border, 5px radius, 7px/10px,
  13.5px, full width. Placeholder is `--ink-3`.
- **Focus:** the border shifts to `--accent-line` (a 34% green). Inputs do not
  glow and do not thicken.
- **Field:** a 6px vertical stack of a 12.5px `--ink-2` label above the control.
- **Search:** a relatively positioned wrapper with an absolutely positioned
  `--ink-3` icon at 9px left and 30px of left padding on the input.

### Cards / Containers
- **Corner:** 8px. **Background:** `--surface`. **Border:** 1px `--line`.
  **Shadow:** card seat only. **Padding:** 14px/15px body, 9px/15px foot.
- A card is a column: `.card-body` grows, `.card-foot` is a fixed 38px-minimum
  strip with a top hairline holding state on the left and dim meta pushed right.
- An anchor card inherits colour, drops underline, and on hover moves its border
  to `--accent-line` and its fill to `--surface-2`. That green edge is the
  action half of the green rule.

### Navigation
- **Rail:** 248px sticky full-height `--surface` column with a right hairline,
  10px padding, 2px gaps. The rail is generic over resource kind: groups are
  Project (Overview), Databases, Apps and Workers, each row an icon (database
  cylinder, browser window, bolt), a truncating `.rail-name`, and a dot-only
  state (`.rail-dot`) pushed to the trailing edge with the state word kept for
  screen readers. A kind's group renders only when the project holds one, and
  a kind with no Studio views yet (apps, workers, pre-D1) renders as a
  `.rail-item`, the same anatomy with no hover and no link, because a reader
  must never execute an aspiration. Postgres rows keep their caret and nested
  Tables / SQL / Schema views. Links are 13.5px `--ink-2` with a 14px icon at
  0.75 opacity. Hover lifts to `--ink` on `--surface-2` over 140ms. The active
  link (`[aria-current="page"]`) follows the No-Tinted-Pill Rule:
  `--surface-3`, `--ink` at 600, `--accent` icon. Group labels are micro
  uppercase `--ink-3` and disappear below 900px, where the rail becomes a
  horizontally scrolling strip.
- **Brand mark:** a 20px rounded square holding a 7px dot. The dot is filled
  `--awake` with a halo when anything on the box is awake and flat `--ink-3`
  when everything sleeps. The mark is the product's state in one glyph.
- **Breadcrumbs:** 13px `--ink-3` in the topbar, links in `--ink-2` going
  `--accent` on hover, the current page in `--ink`, separated by an inline
  chevron SVG.
- **Tabs:** 13.5px `--ink-2` with a 2px transparent bottom border pulled onto
  the container's hairline; active takes `--ink`, weight 500 and an `--accent`
  underline. Both `[aria-current="page"]` and `.active` are styled, and both are
  used.
- **Segmented control:** an inline group with one shared 1px border, 7px radius,
  `overflow: hidden`, and internal 1px dividers. Pressed
  (`[aria-pressed="true"]`) takes `--surface-3`, `--ink`, and an inset 1px
  `--line-strong` ring (see the No-Tinted-Pill Rule for why not weight and
  why not green).

### Tables
- Wrapped in a bordered 8px `overflow: auto` container on `--surface`; the SQL
  and Tables views bound it at `62vh`.
- Headers are micro uppercase `--ink-3` on `--surface-2`, sticky at top, with a
  bottom hairline and no wrap. Cells are 9px/12px, top-aligned, hairline
  separated, last row unbordered. Row hover fills `--surface-2`.
- Numeric cells are right-aligned mono with tabular figures. `NULL` renders as
  italic `--ink-3`, never as an empty cell.
- An editable cell shows a text cursor, an inset `--line-strong` ring plus
  `--surface-2` on hover, and an inset `--accent` ring on `:focus-within`. An
  editable cell that looks inert is a feature that does not exist.

### State indicator (signature)
A 7px dot plus a word, always both. Awake is a filled `--awake` dot with a 3px
`--awake-dim` halo. Sleeping is transparent with a 1.5px `--ink-3` ring and no
chroma. Waking, creating, stopping and removing share the amber dot with a 1.1s
opacity pulse (disabled under reduced motion). Failed is a solid `--danger` dot
and is the one state whose label text takes the colour, because failure is the
one condition worth shouting.

**Not deployed** (`state-undeployed`, arriving in core with the
record-before-code work) is the second resting state: the record exists and no
code has ever been uploaded. It renders as an 8px transparent dot with a 1.5px
*dashed* `--ink-3` ring, the outline of a thing not there yet. No chroma, like
sleeping, because a resource waiting for its first deploy is not a problem.
A row in this state gets no wake affordance: there is nothing to start.

Labels are the product's words, not the daemon's: running is "Awake", starting
is "Waking", stopping is "Stopping". A stopping database is labelled for what it
is doing rather than where it is heading; calling it "Sleeping" while showing a
transition animation made the label and the styling tell two different stories.

### Waking banner (signature)
The interaction the whole product rests on. A 5px-radius amber-edged strip on
`--waking-dim` containing a pulsing 8px dot, the **named database** in bold with
a plain statement of what is happening, a secondary detail line, and a mono
tabular clock pushed right that only counts up. `role="status"` with
`aria-live="polite"`.

Three variants, and the differences are the point:
- **Waking** (amber): appears only after a **350ms** threshold, so a wake that
  lands inside the measured ~300ms cold start never flashes a banner on and off.
- **Subtle** (`--line-strong` border, `--surface-2` fill, neutral dot and
  clock): the database is already running and merely slow. It appears at 900ms
  and says something different, because claiming a wake that is not happening
  would be a lie.
- **Failed** (`--danger` border and wash, static dot, red clock): the banner
  **keeps its account** rather than vanishing. How long it tried for is the
  useful part, and dropping it left a bare error with no context.

### Jewel stat tiles (signature)
The overview's figures as lit objects. Every tile shares one dark slate
ground (the card surface plus sheen, owner's amendment: never a colored
fill); the hue speaks through exactly three channels: a subtle border in the
tile's own jewel, a soft colored shadow, and the micro label with its 6px
dot. Numerals are Fraunces 600 at 28px in plain ink, tabular, with the unit
in quiet Plex. Five tiles: sage Services, iris Awake, honey Data on disk,
plain Connections (a tile is allowed to be quiet), rose Disk free. The hue
map is fixed in `TILE_CLASS` (Project.tsx) so the class audit sees whole
literals.

### Machine strip (signature)
A mono instrument line above the projects page: hostname
(`window.location.hostname`), a dot cluster (max 12) with awake services lit
and glowing, "N of M awake", and disk free pushed right. Every figure is
real at render time; uptime and RAM are absent because the daemon does not
serve them, and the strip never advertises what does not exist.

### Capacity panel (signature)
Where a hosted product shows a plan quota, this shows the machine. A narrow
268px `--surface` panel of meter rows: a micro uppercase label, a tabular value
with its denominator in `--ink-3`, and a 4px `--surface-3` track. The fill is
`--ink-3` by default and `--awake` when the row counts something running, which
is the meter-fill half of the state rule. Hairline separated, last row
unbordered, sticky under the topbar until 1040px.

### Modals
Every form in the product lives in one (see `PRODUCT.md` for why). A fixed
scrim at 55% black with a 2px blur centres a 440px `--surface` dialog with a
`--line-strong` border, 12px radius, `--shadow-pop` and a 140ms fade-and-rise
entrance (none under reduced motion). Head is 16px/18px, body 14px/18px, foot is
a right-aligned `--surface-2` strip with a top hairline and bottom-only radius.
Behaviour: focus moves to the first typable control on open and is restored on
close, Tab is trapped inside the dialog, Escape and a scrim mousedown close it,
and body scroll is locked. Under 560px the scrim loses its padding and the
dialog becomes a full-width bottom sheet with only its top corners rounded.

### Empty states and notices
Empty states are a dashed `--line-strong` box, 10px radius, 44px/24px, centred,
with a spot drawing above a 15px `--ink` heading and a 42ch-capped `--ink-2`
paragraph. The spots live in `src/components/Spot.tsx`: 52x44 inline SVG,
1.4 stroke, `currentColor`, dimmed to `--ink-3` by `.empty-art`. One drawing
per situation (crate-and-sprout for no projects, terminal for idle results,
column grid for no schema, row stack for pick-a-table); the drawing carries
the warmth so the copy can stay plain, and no external asset is ever involved.
Notices are a 7px-radius bordered strip at 13px; the danger and waking
variants take their hue's border, dim wash and text together.

## Do's and Don'ts

### Do:
- **Do** open every view with `<div className="page measure">` and run the class
  audit before you finish.
- **Do** add `min-width: 0` (or `minmax(0, 1fr)`) to any grid or flex child that
  can hold a connection string, a table, or a name you do not control.
- **Do** keep green split by form: a filled surface or an edge for things you
  can press, a 7px haloed dot or a meter fill for things that are true.
- **Do** pair every state colour with a word and a distinct dot shape.
- **Do** use `font-variant-numeric: tabular-nums` on any number that updates.
- **Do** put new forms in a `Modal`, which already traps and restores focus.
- **Do** reuse `--surface-2` and `--surface-3` for depth instead of reaching for
  a shadow.
- **Do** gate any new appearing element behind a threshold if it can appear and
  disappear inside a second.
- **Do** draw new icons as inline 12-14px `currentColor` SVG.

### Don't:
- **Don't** give sleeping a colour, a warning icon, or reduced opacity. It is
  not a degraded state.
- **Don't** introduce a second accent hue, and don't redefine `--awake` to
  anything but `var(--accent)`.
- **Don't** put a large filled green surface anywhere except the primary button;
  it is what keeps the small green dots readable.
- **Don't** add text dimmer than `--ink-3`, and don't put `--ink-3` text on
  `--surface-3` in the light theme.
- **Don't** use `--shadow-pop` on anything that sits in the document flow.
- **Don't** use a border thicker than 1px for emphasis; switch to
  `--line-strong` instead.
- **Don't** add `@font-face`, a webfont, a CDN link, an icon font, or an icon
  package. The box may have no internet.
- **Don't** replace an explanation with a bare indeterminate spinner. Name the
  thing, say what is happening, and count up.
- **Don't** let a failed operation's banner vanish; the elapsed time is the
  context.
- **Don't** put a form inline in a page.

## Verified

Nocturne was inspected in a real browser (Playwright against the dev server,
with a fixture daemon API): Login, Projects with the machine strip, a project
overview with jewel tiles and all four kinds in the rail, Tables, SQL and
Schema empty states, the glass modal, and card hover, in dark; Login,
Projects and the overview in light; Projects under `prefers-reduced-motion`.
Contrast is enforced by `scripts/audit-contrast.mjs` inside `npm run build`,
which caught and forced one hue change during the build (light waking,
#9a6410 → #8a5a0e, was 4.16 on surface-3). The build was also verified
offline-clean: no http(s) fetch in the emitted CSS, six woff2 assets emitted
from the repo's own files.

The `undeployed` state and the app and worker rail rows were verified against
fixtures, because the daemon cannot yet produce them through Studio; they
need a second look when record-before-code lands. Still unverified by anyone:
the `failed` state rendering, and a table wide enough or a result set long
enough to test the scroll containers.

## Failure modes this build actually suffered

Read this before editing `src/theme.css`. These are specific and repeatable.

**Replacing the stylesheet wholesale silently drops classes.** A full rewrite of
`theme.css` removed rules that views still referenced, and it broke the waking
banner, the two-column workspace, the active table row and the active tab. Every
one of those was invisible to `tsc --noEmit` and to `node --test`, because a
missing CSS class is not a type error and is not a unit test failure. The views
still rendered; they rendered wrong. **Edit `theme.css` additively.** If you must
restructure it, run the class audit against the result before you look at
anything else.

**The class audit.** It checks every class the components reference against the
selectors defined in `theme.css`, and fails the build if any is missing. It runs
as part of `npm run build`, so a stylesheet edit that drops a class cannot ship
quietly. To run it alone, from `packages/studio`:

```sh
npm run audit:classes
```

The source is `scripts/audit-classes.mjs`. It strips `${...}` interpolations
while keeping the literal strings inside their branches, so
`` `card${active ? ' active' : ''}` `` yields both `card` and `active` rather
than being skipped. That shape matters: the dead active-tab highlight lived
inside exactly it. There are no known false positives. Anything it prints is a
class a view uses and the stylesheet does not define, which means that element
is unstyled in the browser right now.

**The gutter mistake.** Because `.page` carries only `padding-block`, a view
that forgets `.measure` looks nearly right in a narrow window and renders flush
against the rail on a wide one. It has happened once in every inner view.

**The overflow mistake.** A grid child without `min-width: 0` does not clip; it
grows, and the visible symptom is the rail sliding off the left edge, which
looks like a rail bug rather than a table bug.

**The stale-state mistake.** Running a query wakes the database, but the views
hold their own copy of the resource and the shell holds the project list, so
nothing noticed. The interface said "Sleeping" next to a database that was
awake and serving until the page was reloaded. Anything that can change a
resource's state must call back: `useWakeAwareRun` takes an `onWoke` for
exactly this, and the inner views pass a callback that refreshes both their own
resource and the app-level list. A state label that lies is worse than no state
label, because the whole product is the state.
