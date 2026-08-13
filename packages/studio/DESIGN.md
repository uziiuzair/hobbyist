---
name: Hobbyist Studio
description: A status panel for a machine you own, not a console for a service you rent.
colors:
  ground: "#100f0d"
  surface: "#171512"
  surface-2: "#1e1b17"
  surface-3: "#26221c"
  line: "#2b2721"
  line-strong: "#3c362d"
  ink: "#ede9e3"
  ink-2: "#b3aa9e"
  ink-3: "#948b7e"
  accent: "#45cd81"
  accent-hover: "#58d992"
  accent-ink: "#06231a"
  accent-dim: "rgba(69, 205, 129, 0.13)"
  accent-line: "rgba(69, 205, 129, 0.36)"
  awake: "#45cd81"
  awake-dim: "rgba(69, 205, 129, 0.18)"
  awake-ring: "rgba(69, 205, 129, 0.36)"
  waking: "#e6ae52"
  waking-dim: "rgba(230, 174, 82, 0.14)"
  danger: "#ec8577"
  danger-dim: "rgba(236, 133, 119, 0.12)"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.015em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "15.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  subtitle:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body-secondary:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.08em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
rounded:
  sm: "7px"
  md: "10px"
  lg: "12px"
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

**Creative North Star: "The Panel on the Machine You Own", warm re-voice
(2026-08-13)**

This is a status panel for hardware in the next room, not a console for a
service you rent. Every hosted dashboard treats a stopped database as a
degraded condition and dresses it in a warning; here a sleeping database is
the product working correctly, so it is the calmest thing on the screen. The
surface is warm near-black layered ground (graphite and stone, hue around 38
rather than the first build's cool blue-gray), hairline rules, system faces
and dense rows, with one green that appears rarely enough to mean something.

Density is high and ornament is absent, but the surface is no longer inert:
interactive elements answer the cursor. Hover states transition over
120-160ms, a link card rises 1px onto a lift shadow, and the modal enters in
140ms. Beyond that the motion inventory is unchanged (a status pulse, a
spinner), and everything is gated or slowed under `prefers-reduced-motion`,
including the card rise. Depth comes from tonal layering (four ground steps
plus a hairline) rather than from shadow; three shadows exist and one of them
is a 1px card seat. Dark is the design's home because the operator is usually
at a desk at night with this parked beside an editor, but light is a complete
second theme (warm paper, not an inversion) with the same structure and the
same one-chroma rule, because the machine is theirs and their OS may say
light.

The world runs entirely offline: no `@font-face`, no CDN, no external anything.
System UI and system mono are the type, and that constraint is permanent.

Product voice, terminology and interaction conventions live in `PRODUCT.md` and
are not restated here; this file is strictly visual.

**Key Characteristics:**
- Warm near-black layered ground with hairline rules, no fills that read as panels-on-panels
- One green, split between action and state by form rather than by hue
- Sleeping carries no chroma at all, and neither does not-deployed
- Dense rows, tabular figures anywhere a number can change
- System faces only, dark-first with a full light theme (warm paper, not inverted)
- Flat by default; hover is the one earned rise, and all three shadows are structural
- Active rows are neutral facts, never tinted pills (the No-Tinted-Pill Rule)
- The browser's own surfaces are themed: green caret, hairline scrollbars, accent selection

## Colors

A near-monochrome ground with exactly one chromatic voice, plus an amber
reserved for transitions and a red reserved for failure.

### Primary
- **Signal Green** (`--accent` / `--awake`, #45cd81 dark, #147a48 light): the
  only saturated colour in normal operation. It does two jobs and the same hex
  serves both: action (a filled primary button, an active tab's underline, a
  focus ring, a hovered link, an active rail item's tint and edge) and state
  (a 7px awake dot with a halo, an awake meter fill). `--awake` resolves to
  `var(--accent)` in both themes, so there is one green in the file and one
  green on the screen.

### Secondary
- **Transition Amber** (`--waking`, honey #e6ae52 dark, #9a6410 light): waking,
  starting, stopping, creating and removing. It never marks a resting state.
  Used as the waking dot, the waking banner's edge and wash, and the elapsed
  clock.

### Tertiary
- **Fault Red** (`--danger`, warm coral #ec8577 dark, #b3392c light): failure and
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

- **Ground** (#100f0d dark, #faf9f7 light): the page behind everything.
- **Surface** (#171512 / #ffffff): cards, panels, tables, the rail, modals.
- **Surface 2** (#1e1b17 / #f6f4f1): inputs, buttons at rest, table headers,
  row hover, modal footers.
- **Surface 3** (#26221c / #edeae4): the innermost step. Connection strings,
  meter tracks, button hover, and the active row's fill.
- **Line** (#2b2721 / #e6e2db) and **Line Strong** (#3c362d / #cfc9bf): every
  border in the system is 1px of one of these. Line Strong is for edges that
  must be found (button outlines, dashed empty states, menus, modals).
- **Ink** (#ede9e3 / #1c1917), **Ink 2** (#b3aa9e / #5f5a52), **Ink 3**
  (#948b7e / #6e685e): primary, secondary and tertiary text. All three clear
  4.5:1 against every surface step in both themes, including Ink 3 on
  Surface 3 (4.71 dark, 4.60 light), which the first ramp failed in light.

### Named Rules

**The One Green Rule.** There is one chromatic hue in normal operation and it
resolves from a single token. Do not introduce a second accent, and do not fork
`--awake` away from `--accent`; if action and state need to be told apart, that
is form's job, not hue's.

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

**Display / Body Font:** system UI stack (`-apple-system`, `BlinkMacSystemFont`,
`Segoe UI`, `Roboto`, Helvetica, Arial, sans-serif)
**Mono Font:** system mono stack (`ui-monospace`, `SFMono-Regular`, `SF Mono`,
Menlo, Consolas, `Liberation Mono`, monospace)

**Character:** the operating system's own voice. There is no display face and
there will never be one, because the product must render on a box with no
internet. Hierarchy is built from size, weight and letter-spacing inside a
narrow range (10.5px to 21px), which is what makes the surface read as an
instrument panel rather than a marketing page.

### Hierarchy
- **Display** (600, 21px, -0.015em): the page title, one per view.
- **Title** (600, 15.5px, -0.01em): modal titles. Empty-state headings sit at
  15px, login brand at 15px.
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

This system is **tonally layered, not lifted**. Depth is four ground steps
(`--ground` → `--surface` → `--surface-2` → `--surface-3`) separated by 1px
hairlines. Cards, panels and tables sit flat on the page and are legible as
containers because of their border, not their shadow.

Only two shadow tokens exist, and both are structural rather than decorative.

### Shadow Vocabulary
- **Card seat** (`--shadow-card`): a hairline top highlight and a soft 1-3px
  drop that seats a card on the ground. Not perceived as lift.
- **Lift** (`--shadow-lift`): one step of genuine rise, used only by a hovered
  link card together with its 1px `translateY`. It is deliberately smaller
  than pop: a hover is a moment, not a layer.
- **Pop** (`--shadow-pop`): only for things that genuinely float above the
  document, which is exactly two: the project switcher menu and the modal.

Beyond those, "elevation" is expressed as an inset ring: `box-shadow: inset 0 0 0 1px`
marks an editable cell on hover (`--line-strong`) and on focus (`--accent`),
and `inset 0 -2px 0 var(--accent)` marks a pressed segment.

### Named Rules

**The Flat-By-Default Rule.** A new container gets `--surface`, a 1px `--line`
border and `--radius`. It does not get a shadow. `--shadow-pop` is reserved for
elements in a stacking context above the page (z-index 40+); if it is in the
document flow, it is flat.

**The Halo-Not-Glow Rule.** The only "glow" in the system is a 3px flat ring of
a 13-20% alpha colour around a 7-8px dot. It marks live state. It is never
applied to text, buttons, cards or borders.

## Shapes

Three radii carry everything: **10px** (`--radius`) for containers that hold
content (cards, panels, tables, the SQL editor, empty states, menus), **7px**
(`--radius-sm`) for controls and small chrome (buttons, inputs, segmented
controls, notices, banners, rail links, the connection string, the 20px brand
mark), and **12px** (`--radius-lg`) for the modal alone, one softer step for
the one surface that floats. Below those, 3px appears on the two smallest
marks (editable cell, key tags, the focus ring's own corner) and 50% on dots.

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

The warm re-voice was inspected in a real browser (Playwright against the dev
server, with a fixture daemon API): Login, Projects, a project overview with
all four kinds in the rail, Tables, SQL and Schema empty states, the new
project modal, and card hover, in dark; Login, Projects and the project
overview in light; Projects under `prefers-reduced-motion`. Every ink step was
contrast-checked numerically against every surface step in both themes. The
`undeployed` state and the app and worker rail rows were verified against
fixtures, because the daemon cannot yet produce them through Studio; they need
a second look when record-before-code lands.

Still unverified by anyone: how the interface behaves with a database in the
`failed` state, and with a table wide enough or a result set long enough to
test the scroll containers.

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
