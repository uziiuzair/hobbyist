#!/usr/bin/env node
/**
 * Renders docs/decisions/*.md into the Starlight tree.
 *
 * The decision records are the repository's, not the website's. Copying them
 * by hand would mean the published copy drifts from the committed one the
 * first time someone amends an ADR, and the amendments are the interesting
 * part: several of these files exist to record that a previous decision was
 * wrong.
 *
 * So the site generates them at every build, from prebuild, and the generated
 * files are gitignored. There is one source and the copies cannot disagree,
 * which is why CI does not run a drift check: with nothing committed to drift
 * from, the check would compare the output against an empty directory and fail
 * every time. --check is kept for anyone who later prefers committing the
 * output instead.
 *
 *   node scripts/sync-adrs.mjs           write
 *   node scripts/sync-adrs.mjs --check   exit 1 if the committed copy differs
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '..', '..', 'docs', 'decisions')
const OUT = join(here, '..', 'src', 'content', 'docs', 'docs', 'decisions')

const check = process.argv.includes('--check')
let changed = 0

/** Frontmatter strings are quoted, so any quote inside one has to be escaped. */
function yamlString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The title is the file's own first heading, minus any leading ADR number,
 * because the number is already in the filename and repeating it in the
 * sidebar wastes the width the sidebar does not have.
 */
function titleFrom(markdown, fallback) {
  const heading = markdown.match(/^#\s+(.+?)\s*$/m)
  if (!heading) return fallback
  return heading[1].replace(/^ADR\s*\d+[:.]?\s*/i, '').trim() || fallback
}

/**
 * Starlight renders the frontmatter title as the h1, so the source h1 is
 * dropped to avoid two of them. Everything else is passed through untouched:
 * these files are the record and the site is not entitled to edit them.
 */
function stripFirstHeading(markdown) {
  return markdown.replace(/^#\s+.+?\n+/, '')
}

async function writeIfChanged(path, contents) {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : null
  if (existing === contents) return
  changed += 1
  if (check) {
    console.error(`out of date: ${path.replace(`${join(here, '..')}/`, '')}`)
    return
  }
  await writeFile(path, contents)
}

const entries = (await readdir(SOURCE))
  .filter((name) => /^\d{4}-.+\.md$/.test(name))
  .sort()

if (entries.length === 0) {
  console.error(`no decision records found in ${SOURCE}`)
  process.exit(1)
}

if (!check) {
  // Removed first so that deleting an ADR upstream also deletes it here. A
  // stale rendered copy of a withdrawn decision is worse than none.
  await rm(OUT, { recursive: true, force: true })
}
await mkdir(OUT, { recursive: true })

const index = []

for (const name of entries) {
  const slug = name.replace(/\.md$/, '')
  const number = slug.slice(0, 4)
  const raw = await readFile(join(SOURCE, name), 'utf8')
  const title = titleFrom(raw, slug)

  index.push({ number, slug, title })

  const frontmatter = [
    '---',
    `title: ${yamlString(title)}`,
    `description: ${yamlString(`Decision record ${number}. ${title}`)}`,
    'editUrl: false',
    'tableOfContents: false',
    '---',
    '',
    `<p class="state state--running">decision ${number}</p>`,
    '',
    ':::note',
    'This page is generated from ' +
      `[\`docs/decisions/${name}\`](https://github.com/uziiuzair/hobbyist/blob/main/docs/decisions/${name}) ` +
      'in the repository. Edit it there.',
    ':::',
    '',
  ].join('\n')

  await writeIfChanged(join(OUT, `${slug}.md`), frontmatter + stripFirstHeading(raw))
}

const indexPage = [
  '---',
  'title: "Decisions"',
  'description: "Every deliberate choice this project made, including the ones it chose not to build."',
  'editUrl: false',
  '---',
  '',
  'Every deliberate non-build gets a record. On a project whose stated failure',
  'mode is abandonment at 40 percent, the list of things refused is the more',
  'useful half of the history, so it is published rather than kept in a folder.',
  '',
  'Several of these amend an earlier one, and a few say plainly that the earlier',
  'decision was correct and was overruled anyway. Those are left in.',
  '',
  '| | Decision |',
  '|---|---|',
  ...index.map((entry) => `| \`${entry.number}\` | [${entry.title}](/docs/decisions/${entry.slug}/) |`),
  '',
  'Source: [`docs/decisions/`](https://github.com/uziiuzair/hobbyist/tree/main/docs/decisions).',
  '',
].join('\n')

await writeIfChanged(join(OUT, 'index.md'), indexPage)

if (check && changed > 0) {
  console.error(
    `\n${changed} generated decision page(s) differ from docs/decisions/.\n` +
      'Run `npm run sync:adrs` in site/ and commit the result.'
  )
  process.exit(1)
}

console.log(
  check
    ? `decision pages are in sync (${entries.length} records)`
    : `wrote ${entries.length} decision pages plus an index`
)
