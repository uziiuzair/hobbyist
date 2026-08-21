#!/usr/bin/env node
/**
 * Walks the built site and fails on any internal link that does not resolve.
 *
 * Cheap insurance on a documentation set whose pages reference each other
 * heavily and whose status pages exist specifically to point at the file that
 * records a gap. A dead link on a page whose job is honesty is worse than a
 * dead link anywhere else.
 *
 * External links are not fetched: that would make the build depend on other
 * people's uptime, and a CI failure caused by someone else's outage teaches
 * nobody anything.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')

if (!existsSync(DIST)) {
  console.error('dist/ does not exist. Run `npm run build` first.')
  process.exit(1)
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.html')) out.push(full)
  }
  return out
}

/** A link resolves if dist holds the file itself or that path's index.html. */
function resolves(pathname) {
  const clean = decodeURIComponent(pathname.split('#')[0].split('?')[0])
  const target = join(DIST, clean)
  return existsSync(target) || existsSync(join(target, 'index.html'))
}

const files = await walk(DIST)
const failures = []

for (const file of files) {
  const html = await readFile(file, 'utf8')
  const from = file.replace(DIST, '') || '/'
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1]
    if (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('mailto:') ||
      href.startsWith('data:') ||
      href.startsWith('#') ||
      href === '/'
    ) {
      continue
    }
    const pathname = href.startsWith('/')
      ? href
      : `/${resolvePath(dirname(from), href).replace(/^\//, '')}`
    if (!resolves(pathname)) failures.push({ from, href })
  }
}

if (failures.length === 0) {
  console.log(`all internal links resolve across ${files.length} pages`)
  process.exit(0)
}

const seen = new Set()
for (const failure of failures) {
  const key = `${failure.from} -> ${failure.href}`
  if (seen.has(key)) continue
  seen.add(key)
  console.error(`broken: ${failure.from}  ->  ${failure.href}`)
}
console.error(`\n${seen.size} broken internal link(s).`)
process.exit(1)
