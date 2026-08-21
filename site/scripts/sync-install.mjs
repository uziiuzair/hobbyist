#!/usr/bin/env node
/**
 * Copies the repository's bootstrap.sh to public/install, so the site itself
 * serves the installer.
 *
 * The install URL is https://hobby.sh/install, served by the worker in
 * worker/. This publishes the same bytes at https://hobbyist.sh/install as a
 * mirror, because a single point of failure on the one thing a reader is asked
 * to pipe into their shell is a bad shape. Two hosts, one file.
 *
 * Generated rather than committed, and gitignored, so that there is exactly
 * one bootstrap.sh in version control and no chance of the copies disagreeing.
 * The build depends on this running, so it is wired into prebuild.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '..', '..', 'bootstrap.sh')
const OUT_DIR = join(here, '..', 'public')

const script = await readFile(SOURCE, 'utf8')

if (!script.startsWith('#!/usr/bin/env bash')) {
  console.error(`${SOURCE} does not start with a bash shebang. Refusing to publish it.`)
  process.exit(1)
}

await mkdir(OUT_DIR, { recursive: true })
// Both names, because /install is what the one-liner uses and /install.sh is
// what someone guesses when they want to look at it in a browser first.
await writeFile(join(OUT_DIR, 'install'), script)
await writeFile(join(OUT_DIR, 'install.sh'), script)

console.log(`published bootstrap.sh to public/install and public/install.sh (${script.length} bytes)`)
