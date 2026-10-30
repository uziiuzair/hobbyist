#!/usr/bin/env node
/**
 * Fails when the CLI reference page and the binary's own source disagree.
 *
 * The reference is written by hand, because generating it would mean
 * refactoring the CLI to expose its help table and that is not a change a
 * documentation site is entitled to ask for. What is checked instead is the
 * set of things that actually go stale:
 *
 *   1. Verbs. A page that documents a command that no longer exists is worse
 *      than no page, because a reader will type it.
 *   2. Flags, per verb. The `--pin` on `hobby new` and the `--database` on
 *      `hobby deploy` both shipped without the page noticing (issue #144).
 *   3. Exit codes. Scripts branch on them, so every code the binary can
 *      return has to be in the table.
 *
 * Ground truth is parsed out of the source rather than by running the
 * binary, so this needs no build and no Docker:
 *
 *   - verbs: the USAGE table in packages/cli/src/cli/main.ts, the rows
 *     printHelp and `hobby <verb> --help` both print from.
 *   - flags: the parseArgs(rest, { bool, value, multi }) spec each verb's
 *     dispatch branch in the same file passes. `json` is excluded, since the
 *     page documents it once as a convention rather than per verb, and
 *     `--help` / `-h` are handled before parseArgs and documented the same
 *     way.
 *   - exit codes: the `export const EXIT_* = n` constants in
 *     packages/cli/src/cli/exit.ts.
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLI_SRC = join(here, '..', '..', 'packages', 'cli', 'src', 'cli')
const MAIN = join(CLI_SRC, 'main.ts')
const EXIT = join(CLI_SRC, 'exit.ts')
const PAGE = join(here, '..', 'src', 'content', 'docs', 'docs', 'reference', 'cli.md')

const source = await readFile(MAIN, 'utf8')
const page = await readFile(PAGE, 'utf8')
const problems = []

// ---------------------------------------------------------------- verbs

// Subcommands are documented under their parent's heading, so the check is on
// the top-level verb only. `hobby queue peek` living under a `### hobby queue
// peek` heading is fine; what matters is that `queue` itself is covered.
const table = source.slice(source.indexOf('const USAGE'))
const tableBody = table.slice(0, table.indexOf('\n]'))

const verbs = new Set()
for (const match of tableBody.matchAll(/^\s*\['([a-z]+)', 'hobby /gm)) {
  verbs.add(match[1])
}

if (verbs.size === 0) {
  console.error(`could not parse any verbs out of the USAGE table in ${MAIN}`)
  console.error("the parser in this script assumes rows of the form:  ['verb', 'hobby verb ...', '...'],")
  process.exit(1)
}

// Every `### \`hobby <verb> ...\`` heading, with the text under it up to the
// next heading of any level, grouped by verb. A verb with several headings
// (`snapshot`, `queue`) gets them concatenated.
const sections = new Map()
const headingRe = /^###\s+`hobby ([a-z]+)[^\n]*\n([\s\S]*?)(?=^##|(?![\s\S]))/gm
for (const match of page.matchAll(headingRe)) {
  const verb = match[1]
  sections.set(verb, (sections.get(verb) ?? '') + match[0])
}

const missing = [...verbs].filter((verb) => !sections.has(verb)).sort()
const invented = [...sections.keys()].filter((verb) => !verbs.has(verb)).sort()
if (missing.length > 0) {
  problems.push(`documented nowhere in the CLI reference: ${missing.join(', ')}`)
}
if (invented.length > 0) {
  problems.push(`documented but absent from printHelp: ${invented.join(', ')}`)
}

// ---------------------------------------------------------------- flags

// Each verb's dispatch branch is either `case 'verb': {` or `if (cmd ===
// 'verb') {`; the parseArgs spec(s) inside it name every flag that verb
// accepts. The source is split at those markers and each slice is read up to
// the next marker.
const markerRe = /case '([a-z]+)':|cmd === '([a-z]+)'/g
const markers = []
for (const match of source.matchAll(markerRe)) {
  markers.push({ verb: match[1] ?? match[2], at: match.index })
}

const flagsByVerb = new Map()
for (let i = 0; i < markers.length; i++) {
  const { verb, at } = markers[i]
  if (!verbs.has(verb)) continue
  const end = i + 1 < markers.length ? markers[i + 1].at : source.length
  const slice = source.slice(at, end)
  const flags = flagsByVerb.get(verb) ?? new Set()
  for (const spec of slice.matchAll(/parseArgs\([^,]+,\s*\{([\s\S]*?)\}\)/g)) {
    for (const list of spec[1].matchAll(/(?:bool|value|multi):\s*\[([^\]]*)\]/g)) {
      for (const name of list[1].matchAll(/'([a-z-]+)'/g)) {
        if (name[1] !== 'json') flags.add(name[1])
      }
    }
  }
  flagsByVerb.set(verb, flags)
}

if (flagsByVerb.size === 0) {
  console.error(`could not find any parseArgs specs in ${MAIN}`)
  console.error("the parser in this script assumes:  parseArgs(rest, { bool: ['x'], value: ['y'], multi: ['z'] })")
  process.exit(1)
}

let flagCount = 0
for (const [verb, flags] of flagsByVerb) {
  const text = sections.get(verb)
  if (text === undefined) continue // already reported above
  for (const flag of [...flags].sort()) {
    flagCount++
    if (!text.includes(`--${flag}`)) {
      problems.push(`hobby ${verb} accepts --${flag} and the page's \`hobby ${verb}\` sections never mention it`)
    }
  }
}

// ------------------------------------------------------------ exit codes

const exitSource = await readFile(EXIT, 'utf8')
const exitCodes = new Set()
for (const match of exitSource.matchAll(/^export const EXIT_[A-Z_]+ = (\d+)$/gm)) {
  exitCodes.add(match[1])
}
if (exitCodes.size === 0) {
  console.error(`could not parse any exit codes out of ${EXIT}`)
  process.exit(1)
}

const exitHeading = page.indexOf('## Exit codes')
if (exitHeading === -1) {
  problems.push('the page has no `## Exit codes` section')
} else {
  const rest = page.slice(exitHeading + '## Exit codes'.length)
  const nextHeading = rest.search(/^##\s/m)
  const exitSection = nextHeading === -1 ? rest : rest.slice(0, nextHeading)
  for (const code of [...exitCodes].sort()) {
    if (!new RegExp(`^\\|\\s*\`${code}\`\\s*\\|`, 'm').test(exitSection)) {
      problems.push(`exit code ${code} is defined in exit.ts and missing from the Exit codes table`)
    }
  }
}

// ---------------------------------------------------------------- verdict

if (problems.length === 0) {
  console.log(`cli reference covers all ${verbs.size} verbs, ${flagCount} flags and ${exitCodes.size} exit codes`)
  process.exit(0)
}

for (const problem of problems) console.error(problem)
console.error(
  '\nEither the binary changed and site/src/content/docs/docs/reference/cli.md did not,\n' +
    'or the page describes something that no longer exists. Fix whichever is wrong.'
)
process.exit(1)
