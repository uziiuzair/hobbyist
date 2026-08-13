# Studio Nocturne Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Nocturne overhaul of Hobbyist Studio: bundled type, nocturne token ramp, jewel tiles, night-map cards, glass modals, wake choreography, and a translated light theme, without touching behavior.

**Architecture:** All work lives in `packages/studio` (plus docs). `theme.css` is edited additively and every commit passes the class audit, a new contrast gate, tsc, and the vite build. Views change markup only where the spec names a component. Verification ends with a Playwright round against the fixture stub daemon.

**Tech Stack:** React 19, Vite 8, plain CSS custom properties, Fraunces / IBM Plex Sans / JetBrains Mono (OFL, bundled woff2), Playwright for screenshots.

**Spec:** `docs/superpowers/specs/2026-08-14-studio-nocturne-design.md`

## Global Constraints

- Branch `studio-nocturne`, worktree `.claude/worktrees/beautify-c3fa44`. Touch only `packages/studio/**` and `docs/**`; other packages belong to other sessions.
- Offline absolute: no CDN, no network-loaded asset, ever. Fonts ship as files in the repo.
- Every ink/surface and jewel-label/surface pairing clears WCAG AA at its used size, enforced by the contrast gate added in Task 2.
- The No-Tinted-Pill Rule: active/selected rows are neutral `--surface-3` fills. Never accent-tinted pills, never edge bars.
- Sleeping and undeployed carry no chroma and are never dimmed. Every state renders a word beside its mark.
- All animation (banner sweep, dot breathing, card rise) is disabled under `prefers-reduced-motion`.
- `theme.css` is edited additively; a dropped class is caught by `npm run audit:classes`, which every commit must pass along with `npm run build` (which runs audit + tsc + vite) from `packages/studio`.
- Voice stays plain: no exclamation, no emoji, sentence case (PRODUCT.md).
- Never advertise what does not exist: the machine strip shows only fields the daemon really serves.

All `npm` commands below run from `packages/studio` unless the path says otherwise.

---

### Task 1: Bundle the three faces

**Files:**
- Create: `packages/studio/src/fonts/` (6 woff2 + 3 LICENSE files + README.md)
- Modify: `packages/studio/src/theme.css` (top: @font-face block + font tokens)
- Modify: `packages/studio/scripts/audit-classes.mjs` — no change; new sibling script in Task 2

**Interfaces:**
- Produces: CSS vars `--font-serif`, `--font-sans` (redefined), `--font-mono` (redefined). Later tasks use `var(--font-serif)` for display and numerals.

- [ ] **Step 1: Copy font files into the repo**

Source files already exist in this session's scratchpad install. From the repo root:

```bash
S=/private/tmp/claude-501/-Users-uzairhayat-ooozzy-hobbyist/c3fa44a8-d632-4a69-85ec-31a8fadda9c3/scratchpad/node_modules/@fontsource
mkdir -p packages/studio/src/fonts
cp $S/fraunces/files/fraunces-latin-400-normal.woff2 packages/studio/src/fonts/
cp $S/fraunces/files/fraunces-latin-600-normal.woff2 packages/studio/src/fonts/
cp $S/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2 packages/studio/src/fonts/
cp $S/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2 packages/studio/src/fonts/
cp $S/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2 packages/studio/src/fonts/
cp $S/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2 packages/studio/src/fonts/
cp $S/fraunces/LICENSE packages/studio/src/fonts/LICENSE-fraunces
cp $S/ibm-plex-sans/LICENSE packages/studio/src/fonts/LICENSE-ibm-plex-sans
cp $S/jetbrains-mono/LICENSE packages/studio/src/fonts/LICENSE-jetbrains-mono
```

(If the scratchpad is gone, `npm i --prefix /tmp/fontfetch @fontsource/fraunces @fontsource/ibm-plex-sans @fontsource/jetbrains-mono` and copy from there; the files are versioned npm artifacts, identical either way.)

- [ ] **Step 2: Write the fonts README**

`packages/studio/src/fonts/README.md`:

```markdown
# Bundled faces

Fraunces (display), IBM Plex Sans (interface), JetBrains Mono (data). Latin
woff2 subsets from the @fontsource packages, licenses alongside (all OFL).

Bundled, not system, because Nocturne's voice needs a display serif, and the
constraint was never "system fonts": it was offline. These files ship in the
repo and load via local @font-face; nothing is fetched at runtime. See
docs/superpowers/specs/2026-08-14-studio-nocturne-design.md.
```

- [ ] **Step 3: Add @font-face and swap the font tokens in theme.css**

At the very top of `theme.css`, before `:root`:

```css
/* Nocturne's faces, bundled in src/fonts and inlined or emitted by vite.
   The offline rule is untouched: no request ever leaves the box. */
@font-face { font-family: 'Fraunces'; font-weight: 400; font-style: normal; font-display: swap; src: url('./fonts/fraunces-latin-400-normal.woff2') format('woff2'); }
@font-face { font-family: 'Fraunces'; font-weight: 600; font-style: normal; font-display: swap; src: url('./fonts/fraunces-latin-600-normal.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 400; font-style: normal; font-display: swap; src: url('./fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 500; font-style: normal; font-display: swap; src: url('./fonts/ibm-plex-sans-latin-500-normal.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 600; font-style: normal; font-display: swap; src: url('./fonts/ibm-plex-sans-latin-600-normal.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 400; font-style: normal; font-display: swap; src: url('./fonts/jetbrains-mono-latin-400-normal.woff2') format('woff2'); }
```

In `:root`, replace the two existing font tokens and add the serif:

```css
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-serif: 'Fraunces', Georgia, 'Times New Roman', serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

System stacks stay as fallbacks so a corrupted font file degrades, never breaks.

- [ ] **Step 4: Verify the build is offline-clean**

```bash
npm run build
grep -RInE "https?://" dist/assets/*.css dist/assets/*.js | grep -vE "w3.org|reactjs.org|react.dev|github.com|developer.mozilla" || echo OFFLINE-CLEAN
ls dist/assets | grep -c woff2
```

Expected: `OFFLINE-CLEAN` (the allowed matches are license/comment URLs inside JS, not fetches) and 6 woff2 assets emitted. If vite inlined small fonts as data URIs instead, the woff2 count may be lower and the CSS contains `data:font` — also acceptable.

- [ ] **Step 5: Commit**

```bash
git add packages/studio/src/fonts packages/studio/src/theme.css
git commit -m "feat(studio): bundle Fraunces, IBM Plex Sans and JetBrains Mono, offline"
```

---

### Task 2: Nocturne dark ramp + contrast gate

**Files:**
- Modify: `packages/studio/src/theme.css` (`:root` dark block)
- Create: `packages/studio/scripts/audit-contrast.mjs`
- Modify: `packages/studio/package.json` (wire gate into `build`)

**Interfaces:**
- Produces: dark tokens per the spec table (ground #131110 … rose #e9a3ab), `--radius-sm: 9px`, `--radius: 13px`, `--radius-lg: 16px`, `--glow-awake`, `--glow-waking`, jewel text tokens `--sage/--iris/--honey-t/--rose`. Every later task consumes these names.

- [ ] **Step 1: Write the contrast gate**

`packages/studio/scripts/audit-contrast.mjs`, full content:

```js
// WCAG contrast gate for the Nocturne ramps. Fails the build when any pair
// documented here drops below its floor. Pairs list every ink and jewel
// label against every surface it is used on. Floors: 4.5 body, 3.0 large.
const DARK = { ground: '131110', surface: '1a1715', s2: '211d1a', s3: '2a2521' }
const LIGHT = { ground: 'faf9f7', surface: 'ffffff', s2: 'f6f4f1', s3: 'edeae4' }

const PAIRS = [
  // [name, fg, surfaces, floor]
  ['dark ink', 'f2eee6', DARK, 4.5],
  ['dark ink-2', 'b9ae9f', DARK, 4.5],
  ['dark ink-3', '998f80', DARK, 4.5],
  ['dark sage label', '97d8b0', DARK, 4.5],
  ['dark iris label', 'b6acf5', DARK, 4.5],
  ['dark honey label', 'e3b878', DARK, 4.5],
  ['dark rose label', 'e9a3ab', DARK, 4.5],
  ['dark waking', 'e9b45c', DARK, 4.5],
  ['dark danger', 'ee8a7c', DARK, 4.5],
  ['dark accent-ink on accent', '052419', { accent: '4ed492' }, 4.5],
  ['light ink', '1c1917', LIGHT, 4.5],
  ['light ink-2', '5f5a52', LIGHT, 4.5],
  ['light ink-3', '6e685e', LIGHT, 4.5],
  // Light jewel labels land in Task 10 and get appended here then.
]

function lum(hex) {
  const c = hex.match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

let failed = false
for (const [name, fg, surfaces, floor] of PAIRS) {
  for (const [sname, hex] of Object.entries(surfaces)) {
    const r = ratio(fg, hex)
    if (r < floor) {
      failed = true
      console.error(`contrast gate: ${name} on ${sname} is ${r.toFixed(2)}, floor ${floor}`)
    }
  }
}
if (failed) process.exit(1)
console.log('contrast gate: every documented pair clears its floor')
```

- [ ] **Step 2: Run it, expect a clean pass**

```bash
node scripts/audit-contrast.mjs
```

Expected: `contrast gate: every documented pair clears its floor`. If any jewel label fails on a surface, lighten that jewel's text hue until it clears, then update the spec value to match; the gate is the authority.

- [ ] **Step 3: Wire it into the build**

In `packages/studio/package.json`, change the build script to:

```json
"build": "node scripts/audit-classes.mjs && node scripts/audit-contrast.mjs && tsc --noEmit -p tsconfig.json && vite build",
```

- [ ] **Step 4: Swap the dark tokens in theme.css**

In `:root` replace the current values:

```css
  --ground: #131110;
  --surface: #1a1715;
  --surface-2: #211d1a;
  --surface-3: #2a2521;
  --line: #2f2925;
  --line-strong: #423a32;

  --ink: #f2eee6;
  --ink-2: #b9ae9f;
  --ink-3: #998f80;

  --accent: #4ed492;
  --accent-hover: #63e0a2;
  --accent-ink: #052419;
  --accent-dim: rgba(78, 212, 146, 0.14);
  --accent-line: rgba(78, 212, 146, 0.34);

  --awake: var(--accent);
  --awake-dim: rgba(78, 212, 146, 0.14);
  --awake-ring: rgba(78, 212, 146, 0.34);
  --waking: #e9b45c;
  --waking-dim: rgba(233, 180, 92, 0.13);

  --danger: #ee8a7c;
  --danger-dim: rgba(238, 138, 124, 0.12);

  --radius: 13px;
  --radius-sm: 9px;
  --radius-lg: 16px;

  /* The jewel family: decorative only (tiles, kind icons). Never state. */
  --sage: #97d8b0;
  --iris: #b6acf5;
  --honey-t: #e3b878;
  --rose: #e9a3ab;

  /* Glow lives on state dots, the awake card edge, and primary hover. */
  --glow-awake: rgba(78, 212, 146, 0.28);
  --glow-waking: rgba(233, 180, 92, 0.3);

  --shadow-card: 0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 1px 3px rgba(0, 0, 0, 0.35);
  --shadow-lift: 0 10px 32px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-pop: 0 24px 70px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.35);
```

Leave the light-theme block alone for now; Task 10 rewrites it. The old
`--radius-*` consumers pick the new scale up automatically.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add packages/studio/src/theme.css packages/studio/scripts/audit-contrast.mjs packages/studio/package.json
git commit -m "feat(studio): nocturne dark ramp, jewel tokens, and a contrast gate in the build"
```

---

### Task 3: Sheen, night-map cards, luminous states

**Files:**
- Modify: `packages/studio/src/theme.css` (`.card`, `.state-*`, `.rail-mark`)
- Modify: `packages/studio/src/views/Projects.tsx` (card gets awake class)
- Modify: `packages/studio/src/views/Project.tsx` (db-row list stays; overview cards handled in Task 4)

**Interfaces:**
- Consumes: Task 2 tokens.
- Produces: `.card.is-awake` (green edge-light card), `.state-awake .dot` glow. `Projects.tsx` adds `is-awake` when `summary.state === 'running'`.

- [ ] **Step 1: Sheen and lift on cards, awake edge-light**

In `theme.css`, amend `.card` and add the awake variant:

```css
.card {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 42%), var(--surface);
}
/* The night map: an awake card is a machine with its light on. The edge
   light and ambient glow are state, not action: they never invite a press,
   and the word next to the dot still does the telling. */
.card.is-awake { border-color: rgba(78, 212, 146, 0.28); box-shadow: inset 0 1px 0 rgba(78, 212, 146, 0.18), 0 0 36px rgba(78, 212, 146, 0.06); }
a.card.is-awake:hover { border-color: var(--accent-line); box-shadow: inset 0 1px 0 rgba(78, 212, 146, 0.2), var(--shadow-lift), 0 0 44px rgba(78, 212, 146, 0.1); }
a.card:hover { transform: translateY(-2px); }
```

(The existing `.card` background declaration is replaced by the gradient one; every other property of `.card` stays.)

- [ ] **Step 2: Luminous dots**

```css
.state-awake .dot { box-shadow: 0 0 0 3px var(--awake-dim), 0 0 12px 2px var(--glow-awake); }
.state-waking .dot { box-shadow: 0 0 0 3px var(--waking-dim), 0 0 12px 2px var(--glow-waking); }
.rail-mark.is-awake i { box-shadow: 0 0 0 3px var(--awake-dim), 0 0 14px 2px var(--glow-awake); }
```

- [ ] **Step 3: Wire `is-awake` onto project cards**

In `Projects.tsx`, the card anchor currently reads:

```tsx
<a className="card" key={row.project.id} href={...}>
```

Change to:

```tsx
<a className={`card${summary.state === 'running' ? ' is-awake' : ''}`} key={row.project.id} href={...}>
```

(`summary` already exists in that map callback.)

- [ ] **Step 4: Build, eyeball via dev server, commit**

```bash
npm run build
git add -A packages/studio
git commit -m "feat(studio): card sheen, night-map awake edge light, luminous state dots"
```

---

### Task 4: Jewel stat tiles on the project overview

**Files:**
- Modify: `packages/studio/src/views/Project.tsx` (the `Stat` component and the stats strip markup)
- Modify: `packages/studio/src/theme.css`

**Interfaces:**
- Consumes: jewel tokens from Task 2.
- Produces: classes `.tiles`, `.tile`, `.tile-sage/.tile-iris/.tile-honey/.tile-rose`, `.tile-label`, `.tile-value`. `Stat` gains a `hue` prop: `'sage' | 'iris' | 'honey' | 'rose'`.

- [ ] **Step 1: Tile CSS**

```css
/* Jewel tiles. One dark slate ground for all four (owner's call): the hue
   speaks only through the border, the glow and the label. Serif numerals in
   plain ink. Decorative only: state never lives here. */
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { border-radius: var(--radius); padding: 15px 17px 13px; border: 1px solid; background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 45%), var(--surface); min-width: 0; }
.tile-label { font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase; font-weight: 600; display: flex; align-items: center; gap: 7px; }
.tile-label i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.tile-value { font-family: var(--font-serif); font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 6px; letter-spacing: -0.01em; }
.tile-value .of { font-family: var(--font-sans); font-size: 13px; color: var(--ink-3); font-weight: 400; letter-spacing: 0; }
.tile-sage { border-color: rgba(151, 216, 176, 0.28); box-shadow: 0 8px 30px rgba(151, 216, 176, 0.1), 0 1px 3px rgba(0, 0, 0, 0.3); }
.tile-sage .tile-label { color: var(--sage); }
.tile-iris { border-color: rgba(182, 172, 245, 0.3); box-shadow: 0 8px 30px rgba(182, 172, 245, 0.11), 0 1px 3px rgba(0, 0, 0, 0.3); }
.tile-iris .tile-label { color: var(--iris); }
.tile-honey { border-color: rgba(227, 184, 120, 0.28); box-shadow: 0 8px 30px rgba(227, 184, 120, 0.1), 0 1px 3px rgba(0, 0, 0, 0.3); }
.tile-honey .tile-label { color: var(--honey-t); }
.tile-rose { border-color: rgba(233, 163, 171, 0.28); box-shadow: 0 8px 30px rgba(233, 163, 171, 0.1), 0 1px 3px rgba(0, 0, 0, 0.3); }
.tile-rose .tile-label { color: var(--rose); }
@media (max-width: 720px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
```

- [ ] **Step 2: Rework the stat strip markup**

In `Project.tsx`, find the stats strip (`.stats` + `Stat` components, near the `<Stat label="Services" ...>` call). Replace the strip with tiles, keeping the same real values and the existing note line below it:

```tsx
<div className="tiles">
  <Tile hue="sage" label="Services" value={String(totals.databases)} />
  <Tile hue="iris" label="Awake" value={String(totals.awake)} of={`of ${totals.databases}`} />
  <Tile hue="honey" label="Data on disk" value={diskValue} of={diskUnit} />
  <Tile hue="rose" label="Disk free" value={freeValue} of={freeUnit} />
</div>
```

with the tile component (same file, replacing or alongside `Stat`):

```tsx
function Tile({ hue, label, value, of }: { hue: 'sage' | 'iris' | 'honey' | 'rose'; label: string; value: string; of?: string }) {
  return (
    <div className={`tile tile-${hue}`}>
      <div className="tile-label"><i aria-hidden="true" />{label}</div>
      <div className="tile-value">{value}{of !== undefined && <> <span className="of">{of}</span></>}</div>
    </div>
  )
}
```

Split the existing `formatBytes(...)` strings into value + unit for the `of` slot (`formatBytes` returns strings like `"132 MB"`; `const [diskValue, diskUnit] = formatBytes(bytes).split(' ')`). Keep the old `.stats` CSS in place (audit only checks that referenced classes exist, and removing rules wholesale is the documented failure mode); remove the `Stat` usages, and delete `Stat` only if nothing else references it (`grep -n "Stat" src/views/Project.tsx`).

- [ ] **Step 3: Build and commit**

```bash
npm run build
git add -A packages/studio
git commit -m "feat(studio): jewel stat tiles, slate ground, hue in border glow and label"
```

---

### Task 5: The machine strip

**Files:**
- Create: `packages/studio/src/components/MachineStrip.tsx`
- Modify: `packages/studio/src/views/Projects.tsx` (render strip above `.page-head`)
- Modify: `packages/studio/src/theme.css`

**Interfaces:**
- Consumes: `rows: RailProject[]`, `freeBytes: number | null` — both already props of `Projects`.
- Produces: `<MachineStrip awake={n} total={n} freeBytes={freeBytes} />`, classes `.machine`, `.machine-host`, `.machine-cluster`.

Only real fields: hostname from `window.location.hostname`, awake/total from the rows, disk free from preflight. No uptime, no RAM: the daemon does not serve them, and the strip never advertises what does not exist.

- [ ] **Step 1: Component**

```tsx
// The instrument line: the machine itself, in one row. Every figure here is
// real at render time; anything the daemon cannot answer is absent, not
// estimated.
export function MachineStrip({ awake, total, freeBytes }: { awake: number; total: number; freeBytes: number | null }) {
  const host = window.location.hostname
  return (
    <div className="machine">
      <span className="machine-host">{host}</span>
      <span className="machine-cluster" aria-hidden="true">
        {Array.from({ length: Math.min(total, 12) }, (_, i) => (
          <i key={i} className={i < awake ? 'on' : ''} />
        ))}
      </span>
      <span>{awake} of {total} awake</span>
      {freeBytes !== null && <span className="machine-right">{formatBytes(freeBytes)} free</span>}
    </div>
  )
}
```

Import `formatBytes` from `../lib/format.js`.

- [ ] **Step 2: CSS**

```css
/* The machine strip: mono, quiet, true. The dot cluster is the box's state
   at a glance: filled-and-lit dots are awake services. */
.machine { display: flex; align-items: center; gap: 16px; padding: 9px 0 14px; font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
.machine-host { color: var(--ink-2); }
.machine-cluster { display: inline-flex; gap: 5px; align-items: center; }
.machine-cluster i { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--ink-3); box-sizing: border-box; }
.machine-cluster i.on { background: var(--awake); border: 0; box-shadow: 0 0 8px 1px var(--glow-awake); }
.machine-right { margin-left: auto; }
```

- [ ] **Step 3: Render it in Projects.tsx**

Inside the `page measure` div, first child before `.page-head`:

```tsx
<MachineStrip awake={totals.awake} total={totals.databases} freeBytes={freeBytes} />
```

- [ ] **Step 4: Build and commit**

```bash
npm run build
git add -A packages/studio
git commit -m "feat(studio): machine strip, the instrument line over the night map"
```

---

### Task 6: Rail in nocturne

**Files:**
- Modify: `packages/studio/src/components/Shell.tsx` (kind icon hue classes)
- Modify: `packages/studio/src/theme.css`

**Interfaces:**
- Consumes: jewel tokens.
- Produces: classes `.ic-sage`, `.ic-iris`, `.ic-honey` on the kind icons.

- [ ] **Step 1: Hue the kind icons**

In `Shell.tsx`: `DatabaseIcon`, `AppIcon`, `WorkerIcon` each take the hue on their `<svg>`: `className="ic-sage"`, `"ic-iris"`, `"ic-honey"` respectively. `GridIcon` stays neutral.

- [ ] **Step 2: CSS**

```css
/* Kind identity in the rail: sage databases, iris apps, honey workers, at
   rest-opacity so the tree stays quiet until you read it. */
.ic-sage { color: var(--sage); }
.ic-iris { color: var(--iris); }
.ic-honey { color: var(--honey-t); }
.rail-link .ic-sage, .rail-link .ic-iris, .rail-link .ic-honey,
.rail-item .ic-sage, .rail-item .ic-iris, .rail-item .ic-honey { opacity: 0.8; }
.rail-link:hover .ic-sage, .rail-link:hover .ic-iris, .rail-link:hover .ic-honey { opacity: 1; }
```

The active row keeps the No-Tinted-Pill treatment already in the file; the `aria-current` rule that colors `svg` green must not override the kind hues — check it and scope it to `.ic-neutral`-free selectors if it does (the existing rule is `.rail-link[aria-current="page"] svg { color: var(--accent); }`; change it to keep kind-hued icons: delete that rule and rely on the fill + weight + ink for the active state).

- [ ] **Step 3: Build, class audit, commit**

```bash
npm run build
git add -A packages/studio
git commit -m "feat(studio): kind-hued rail icons in the nocturne jewels"
```

---

### Task 7: Glass modal and switcher

**Files:**
- Modify: `packages/studio/src/theme.css` (`.modal`, `.switcher-menu`)

**Interfaces:** none new; classes unchanged.

- [ ] **Step 1: Glass**

```css
/* Only things above the page get glass: the modal and the switcher menu. */
.modal {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 40%), color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}
.switcher-menu {
  background: color-mix(in srgb, var(--surface-2) 86%, transparent);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}
```

`.modal` keeps `--radius-lg` (now 16px) from the token swap automatically.

- [ ] **Step 2: Verify fallback**

Firefox without backdrop-filter still renders a solid-enough surface because color-mix keeps 86-88% opacity. Confirm text legibility over the scrim in dev tools by toggling backdrop-filter off.

- [ ] **Step 3: Build and commit**

```bash
npm run build
git add packages/studio/src/theme.css
git commit -m "feat(studio): glass modal and switcher, the only surfaces above the page"
```

---

### Task 8: Wake choreography

**Files:**
- Modify: `packages/studio/src/theme.css` (`.waking-banner` sweep)

**Interfaces:** none new.

- [ ] **Step 1: The sweep**

```css
/* The one authored moment: while something wakes, a honey light sweeps the
   banner's top edge. Gone under reduced motion, and the words and clock
   carry everything without it. */
.waking-banner { position: relative; overflow: hidden; }
.waking-banner::after {
  content: '';
  position: absolute;
  top: 0; left: 0; height: 1px; width: 100%;
  background: linear-gradient(90deg, transparent, rgba(233, 180, 92, 0.7), transparent);
  animation: wake-sweep 2.4s ease-in-out infinite;
}
@keyframes wake-sweep { 0% { transform: translateX(-100%); } 60%, 100% { transform: translateX(100%); } }
.waking-banner-subtle::after, .waking-banner-failed::after { display: none; }
@media (prefers-reduced-motion: reduce) { .waking-banner::after { display: none; } }
```

- [ ] **Step 2: Build and commit**

```bash
npm run build
git add packages/studio/src/theme.css
git commit -m "feat(studio): the wake sweep, one authored moment on the waking banner"
```

---

### Task 9: Login nocturne, serif display, chart light

**Files:**
- Modify: `packages/studio/src/views/Login.tsx`
- Modify: `packages/studio/src/components/ActivityChart.tsx`
- Modify: `packages/studio/src/theme.css`

**Interfaces:**
- Produces: classes `.login-glow`, chart gradient defs id `chart-fill`.

- [ ] **Step 1: Serif display across the app**

```css
.page-title, .m-ptitle, .modal-title, .login-title, .stat-value, .tile-value, .empty h3 { font-family: var(--font-serif); }
.page-title { font-size: 30px; letter-spacing: -0.012em; }
```

(`.m-ptitle` only if that class exists; it does not in the app: drop it. `.stat-value` only if Task 4 kept the strip anywhere; otherwise drop. Run `npm run audit:classes` mentally: it checks component-referenced classes exist in CSS, not the reverse, so extra selectors are safe but sloppy; keep the list to classes that exist.)

- [ ] **Step 2: Login composition**

In `Login.tsx`, wrap the existing brand in a centered column and enlarge the mark (structure per the re-voice stays; sizes change):

```css
.login-wrap { background: radial-gradient(ellipse 640px 420px at 50% 38%, rgba(78, 212, 146, 0.05), transparent), var(--ground); }
.login-brand { flex-direction: column; text-align: center; gap: 14px; }
.login-mark { width: 44px; height: 44px; border-radius: var(--radius); }
.login-mark i { width: 9px; height: 9px; background: var(--awake); box-shadow: 0 0 0 4px var(--awake-dim), 0 0 22px 4px var(--glow-awake); }
.login-title { font-size: 28px; }
```

The mark's dot goes green and glowing here on purpose: the door shows the product alive. (The rail mark still reports the real awake state once inside.)

- [ ] **Step 3: Chart gradient and endpoint**

In `ActivityChart.tsx`, inside the `<svg>`, add defs and use them on the existing connections path; add a circle on the last sample point:

```tsx
<defs>
  <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
    <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
  </linearGradient>
</defs>
```

Fill the area under the connections line with `fill="url(#chart-fill)"` (the component already builds the polyline points; close the area path to the baseline). Last point:

```tsx
<circle cx={lastX} cy={lastY} r="3" fill="var(--accent)" />
<circle cx={lastX} cy={lastY} r="6" fill="var(--accent)" opacity="0.25" />
```

Read the component first; reuse its existing scale helpers for `lastX/lastY` rather than recomputing.

- [ ] **Step 4: Build and commit**

```bash
npm run build
git add -A packages/studio
git commit -m "feat(studio): login nocturne, serif display voice, chart glow"
```

**Checkpoint: publish an artifact with real screenshots (dark) to the owner before continuing.** Reuse the Playwright harness from Task 11 for the shots.

---

### Task 10: Light theme, translated

**Files:**
- Modify: `packages/studio/src/theme.css` (light block)
- Modify: `packages/studio/scripts/audit-contrast.mjs` (append light jewel pairs)

**Interfaces:**
- Produces: light values for every token Task 2 defined.

- [ ] **Step 1: Light block**

Replace the `@media (prefers-color-scheme: light)` token values:

```css
    --ground: #faf9f7;
    --surface: #ffffff;
    --surface-2: #f6f4f1;
    --surface-3: #edeae4;
    --line: #e6e2db;
    --line-strong: #cfc9bf;

    --ink: #1c1917;
    --ink-2: #5f5a52;
    --ink-3: #6e685e;

    --accent: #147a48;
    --accent-hover: #0f643b;
    --accent-ink: #ffffff;
    --accent-dim: rgba(20, 122, 72, 0.12);
    --accent-line: rgba(20, 122, 72, 0.32);
    --awake: var(--accent);
    --awake-dim: rgba(20, 122, 72, 0.16);
    --awake-ring: rgba(20, 122, 72, 0.3);
    --waking: #9a6410;
    --waking-dim: rgba(154, 100, 16, 0.12);
    --danger: #b3392c;
    --danger-dim: rgba(179, 57, 44, 0.08);

    /* Jewels stay deep in the light: ink-dark hues on paper, so the tiles
       keep their character instead of washing out to pastel candy. */
    --sage: #1f6b43;
    --iris: #5a4fb8;
    --honey-t: #8a5f14;
    --rose: #a84a55;
    --glow-awake: rgba(20, 122, 72, 0.16);
    --glow-waking: rgba(154, 100, 16, 0.18);

    --shadow-card: 0 1px 3px rgba(28, 25, 23, 0.06);
    --shadow-lift: 0 10px 32px rgba(28, 25, 23, 0.12), 0 1px 3px rgba(28, 25, 23, 0.07);
    --shadow-pop: 0 24px 70px rgba(28, 25, 23, 0.16), 0 2px 6px rgba(28, 25, 23, 0.08);
```

Tile borders/glows use literal dark-tuned rgba values from Task 4; add light overrides inside the media block:

```css
  .tile-sage { border-color: rgba(31, 107, 67, 0.32); box-shadow: 0 8px 30px rgba(31, 107, 67, 0.1), 0 1px 3px rgba(28, 25, 23, 0.05); }
  .tile-iris { border-color: rgba(90, 79, 184, 0.32); box-shadow: 0 8px 30px rgba(90, 79, 184, 0.1), 0 1px 3px rgba(28, 25, 23, 0.05); }
  .tile-honey { border-color: rgba(138, 95, 20, 0.32); box-shadow: 0 8px 30px rgba(138, 95, 20, 0.1), 0 1px 3px rgba(28, 25, 23, 0.05); }
  .tile-rose { border-color: rgba(168, 74, 85, 0.32); box-shadow: 0 8px 30px rgba(168, 74, 85, 0.1), 0 1px 3px rgba(28, 25, 23, 0.05); }
  .card.is-awake { border-color: rgba(20, 122, 72, 0.3); box-shadow: inset 0 1px 0 rgba(20, 122, 72, 0.12), 0 0 36px rgba(20, 122, 72, 0.05); }
  .machine-cluster i.on { box-shadow: 0 0 8px 1px var(--glow-awake); }
  .login-wrap { background: radial-gradient(ellipse 640px 420px at 50% 38%, rgba(20, 122, 72, 0.05), transparent), var(--ground); }
```

- [ ] **Step 2: Extend the contrast gate**

Append to `PAIRS` in `audit-contrast.mjs`:

```js
  ['light sage label', '1f6b43', LIGHT, 4.5],
  ['light iris label', '5a4fb8', LIGHT, 4.5],
  ['light honey label', '8a5f14', LIGHT, 4.5],
  ['light rose label', 'a84a55', LIGHT, 4.5],
  ['light waking', '9a6410', LIGHT, 4.5],
  ['light danger', 'b3392c', LIGHT, 4.5],
  ['light accent-ink on accent', 'ffffff', { accent: '147a48' }, 4.5],
```

Run `node scripts/audit-contrast.mjs`; adjust any failing hue darker until it clears and record the final value in both files.

- [ ] **Step 3: Build and commit**

```bash
npm run build
git add -A packages/studio
git commit -m "feat(studio): the light theme translated, jewels kept deep, gate extended"
```

---

### Task 11: Verification round

**Files:**
- Use: fixture harness from the re-voice session: `stub-api.mjs`, `inspect.mjs` in `/private/tmp/claude-501/-Users-uzairhayat-ooozzy-hobbyist/c3fa44a8-d632-4a69-85ec-31a8fadda9c3/scratchpad/` (recreate from the descriptions in those files if the scratchpad is gone; they stub `/studio/session`, `/v1/preflight`, `/v1/projects`, `/v1/projects/:name`, `/v1/resources/:id[/*]` with fixtures including an app in `undeployed` and a worker).

- [ ] **Step 1: Full gates**

```bash
npm run build        # class audit + contrast gate + tsc + vite
cd ../.. && npm test # full suite, expect the same pass count as main
```

- [ ] **Step 2: Detector**

```bash
node ~/.claude/plugins/cache/impeccable/impeccable/4.0.4/skills/impeccable/scripts/detect.mjs --json packages/studio/src/theme.css packages/studio/src/components/*.tsx packages/studio/src/views/*.tsx
```

Expected: `[]`.

- [ ] **Step 3: Playwright round**

Start `node stub-api.mjs` (port 7999), `HOBBY_API_PORT=7999 npm run dev`, run `inspect.mjs`: login, projects, overview, tables, sql, schema in dark; login, projects, overview in light; projects under reduced motion. Read every screenshot. Fix everything found in ONE batch, re-shoot once, stop.

- [ ] **Step 4: Publish the shipped artifact to the owner**

Downscale key shots (sips -Z 1100), embed as data URIs, republish the Nocturne artifact with a Shipped section. Wait for the owner's verdict before merge.

---

### Task 12: Document and close

**Files:**
- Modify: `packages/studio/DESIGN.md` (rewrite for Nocturne: overview, colors incl. jewel family and both amendments, type incl. bundled faces, glow vocabulary, radii, glass, machine strip, tiles, choreography, verified section listing exactly what the Playwright round covered)
- Modify: `packages/studio/PRODUCT.md` — no change expected; check the voice section still matches.

- [ ] **Step 1: Rewrite DESIGN.md** — derive from the shipped code, not the comp. Every named rule that survives is restated; the two amended constraints (bundled fonts, jewel family) get their reasoning.

- [ ] **Step 2: Update the continuity decision** `hobbyist.studio-revoice` is superseded by a `hobbyist.studio-nocturne` entry: branch, commit, the amended constraints, the jewel/kind mapping, D1 guidance.

- [ ] **Step 3: Commit**

```bash
git add packages/studio/DESIGN.md docs
git commit -m "docs(studio): DESIGN.md rewritten for Nocturne"
```

Merge follows the finishing-a-development-branch flow: dry-run merge-tree against main, owner runs the merge from the main checkout (worktree guard), suite on the merged result.

---

## Self-review notes

- Spec coverage: fonts (T1), tokens+gate (T2), sheen/night-map/glow (T3), tiles with both amendments (T4), machine strip real-fields-only (T5), rail hues (T6), glass (T7), sweep (T8), login/serif/chart (T9), light theme (T10), verification+checkpoints (T9 checkpoint, T11), docs+decision (T12). Empty-state duotone enlargement from the spec is deliberately deferred: the Spot drawings shipped days ago and resizing them is cosmetic; if wanted it rides Task 9. Recorded here so it is a choice, not a gap.
- The `.m-ptitle`/`.stat-value` caveat in Task 9 Step 1 resolves at execution: only style classes that exist.
- Type consistency: `Tile` props, `MachineStrip` props, and hue class names are each defined once and reused verbatim.
