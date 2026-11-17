/**
 * The CLI's verbs and each verb's flags, parsed out of
 * packages/cli/src/cli/main.ts without building or running anything.
 * Shared by check-cli-reference.mjs (the site's CLI reference page) and
 * check-plugin-skills.mjs (the agent plugin's skills), so both judge text
 * against the same reading of the source.
 *
 *   - verbs: the USAGE table, the rows printHelp and `hobby <verb> --help`
 *     both print from.
 *   - flags: the parseArgs(rest, { bool, value, multi }) specs inside each
 *     verb's dispatch branch (`case 'verb':` or `cmd === 'verb'`), `json`
 *     included. Callers that document --json once as a convention drop it.
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const CLI_SRC = join(here, '..', '..', 'packages', 'cli', 'src', 'cli')
export const MAIN = join(CLI_SRC, 'main.ts')

export function parseVerbs(source) {
  const table = source.slice(source.indexOf('const USAGE'))
  const tableBody = table.slice(0, table.indexOf('\n]'))
  const verbs = new Set()
  for (const match of tableBody.matchAll(/^\s*\['([a-z]+)', 'hobby /gm)) {
    verbs.add(match[1])
  }
  return verbs
}

export function parseFlags(source, verbs) {
  const markers = []
  for (const match of source.matchAll(/case '([a-z]+)':|cmd === '([a-z]+)'/g)) {
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
          flags.add(name[1])
        }
      }
    }
    flagsByVerb.set(verb, flags)
  }
  return flagsByVerb
}
