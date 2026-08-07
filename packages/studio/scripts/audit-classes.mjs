// Every class the views reference must exist in the stylesheet.
//
// This exists because replacing theme.css wholesale silently dropped classes
// the components still used, and nothing caught it: the typechecker has no
// view into CSS, the tests assert on behaviour, and the design detector looks
// for antipatterns rather than absences. The waking banner rendered unstyled
// for three commits, the two column workspace collapsed into a stack, and the
// active row and active tab highlights were both dead. All four were invisible
// until someone looked at the page.
//
// Run: npm run audit:classes -w @hobby.sh/studio

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cssPath = join(root, 'src/theme.css')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const css = readFileSync(cssPath, 'utf8')
const defined = new Set()
for (const match of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(match[1])

// A className can be a plain string, a template literal, or a ternary inside
// one. Take every quoted or backticked run, then strip the interpolations
// rather than the whole attribute, so `card${x ? ' active' : ''}` still yields
// both `card` and `active` instead of being skipped.
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g

const problems = []
for (const file of walk(join(root, 'src'))) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(CLASS_ATTR)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    // Drop ${...} bodies but keep any literal class text inside their branches.
    const literalOnly = raw.replace(/\$\{[^}]*\}/g, (expr) =>
      [...expr.matchAll(/['"`]([^'"`]*)['"`]/g)].map((m) => m[1]).join(' '),
    )
    for (const token of literalOnly.split(/\s+/)) {
      if (token.length === 0) continue
      if (!defined.has(token)) {
        const line = source.slice(0, match.index).split('\n').length
        problems.push(`${file.replace(root + '/', '')}:${line}  .${token}`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} class(es) used but not defined in src/theme.css:\n`)
  for (const problem of [...new Set(problems)].sort()) console.error(`  ${problem}`)
  process.exit(1)
}

console.log('class audit: every referenced class is defined')
