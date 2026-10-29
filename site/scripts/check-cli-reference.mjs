#!/usr/bin/env node
/**
 * Fails when the CLI reference page and the binary's own help disagree.
 *
 * The reference is written by hand, because generating it would mean
 * refactoring the CLI to expose its help table and that is not a change a
 * documentation site is entitled to ask for. What is checked instead is the
 * one thing that actually goes stale: the set of verbs. A page that documents
 * a command that no longer exists is worse than no page, because a reader
 * will type it.
 *
 * Ground truth is the USAGE table in packages/cli/src/cli/main.ts (the rows
 * printHelp and `hobby <verb> --help` both print from), parsed out of the
 * source rather than by running the binary, so this needs no build and no
 * Docker.
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MAIN = join(here, '..', '..', 'packages', 'cli', 'src', 'cli', 'main.ts')
const PAGE = join(here, '..', 'src', 'content', 'docs', 'docs', 'reference', 'cli.md')

// Subcommands are documented under their parent's heading, so the check is on
// the top-level verb only. `hobby queue peek` living under a `### hobby queue
// peek` heading is fine; what matters is that `queue` itself is covered.
const source = await readFile(MAIN, 'utf8')
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

const page = await readFile(PAGE, 'utf8')
const documented = new Set()
for (const match of page.matchAll(/^###\s+`hobby ([a-z]+)/gm)) {
  documented.add(match[1])
}

const missing = [...verbs].filter((verb) => !documented.has(verb)).sort()
const invented = [...documented].filter((verb) => !verbs.has(verb)).sort()

if (missing.length === 0 && invented.length === 0) {
  console.log(`cli reference covers all ${verbs.size} verbs`)
  process.exit(0)
}

if (missing.length > 0) {
  console.error(`documented nowhere in the CLI reference: ${missing.join(', ')}`)
}
if (invented.length > 0) {
  console.error(`documented but absent from printHelp: ${invented.join(', ')}`)
}
console.error(
  '\nEither the binary grew a verb and site/src/content/docs/docs/reference/cli.md did not,\n' +
    'or the page describes something that no longer exists. Fix whichever is wrong.'
)
process.exit(1)
