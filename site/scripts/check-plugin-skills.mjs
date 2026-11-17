#!/usr/bin/env node
/**
 * Fails when the agent plugin's skills describe a CLI or MCP surface that
 * does not exist, or break the skill format.
 *
 * A skill is read by an agent that will type what it says, so a stale verb
 * or flag in one is worse than a stale line on a docs page. Checked:
 *
 *   1. Frontmatter, per the Agent Skills format: `name` and `description`
 *      present and plain YAML strings, `name` lowercase-hyphenated, at most 64 characters and equal
 *      to its directory, `description` at most 1024 characters with no angle
 *      brackets, and no keys outside the format's set.
 *   2. Every `hobby <verb>` inside a code span or fenced block is a verb in
 *      the USAGE table, and every `--flag` after it on that command is one
 *      the verb's parseArgs spec accepts (cli-surface.mjs, the parsing
 *      check-cli-reference.mjs uses). A `--flag` in a code span with no verb
 *      in front of it must be accepted by at least one verb.
 *   3. Every `hobby_*` MCP tool named is one packages/mcp/src/server.ts
 *      registers.
 *   4. No connection string with a real-looking password: the skills tell
 *      agents never to print one, and must not show one either.
 *   5. The plugin manifests parse, and the MCP config starts `hobby mcp`.
 *
 * Exits 0 and prints a one-line summary, or lists every problem and exits 1.
 * Needs no build and no daemon.
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAIN, parseFlags, parseVerbs } from './cli-surface.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..', '..')
const PLUGIN = join(ROOT, 'plugin')
const SKILLS = join(PLUGIN, 'skills')
const MCP_SERVER = join(ROOT, 'packages', 'mcp', 'src', 'server.ts')

const source = await readFile(MAIN, 'utf8')
const verbs = parseVerbs(source)
const flagsByVerb = parseFlags(source, verbs)
const anyFlag = new Set(['help', 'json'])
for (const flags of flagsByVerb.values()) for (const f of flags) anyFlag.add(f)

const tools = new Set()
for (const m of (await readFile(MCP_SERVER, 'utf8')).matchAll(/registerTool\(\s*'(hobby_[a-z_]+)'/g)) tools.add(m[1])

if (verbs.size === 0 || flagsByVerb.size === 0 || tools.size === 0) {
  console.error('could not parse the CLI verbs, flags or MCP tools; the parsers in cli-surface.mjs or this script need updating')
  process.exit(1)
}

const problems = []
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility'])

// Single-line `key: value` pairs between the opening and closing `---`,
// which is all these skills use. A nested or multi-line value is reported
// rather than half-parsed.
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (m === null) return null
  const fields = new Map()
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z][a-z-]*):\s*(.*)$/.exec(line)
    if (kv === null) return { error: `cannot read frontmatter line: ${line}` }
    // The skills CLI and Claude Code parse this as YAML, where an unquoted
    // value containing ": " or " #", or starting with an indicator
    // character, means something else or fails to parse.
    const raw = kv[2]
    if (!/^(['"]).*\1$/.test(raw) && (/: | #/.test(raw) || /^[`'"{[&*!|>%@,?-]/.test(raw))) {
      return { error: `quote the ${kv[1]} value: unquoted it is not the plain YAML string it looks like` }
    }
    fields.set(kv[1], kv[2].replace(/^(['"])(.*)\1$/, '$2'))
  }
  return { fields, body: text.slice(m[0].length) }
}

// Every piece of text an agent would type: fenced block lines and inline
// code spans.
function codeSnippets(body) {
  const snippets = []
  const withoutFences = body.replace(/^```[^\n]*\n([\s\S]*?)^```$/gm, (_all, block) => {
    for (const line of block.split('\n')) snippets.push(line.replace(/#.*$/, ''))
    return ''
  })
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) snippets.push(m[1])
  return snippets
}

let commandCount = 0
function checkSnippet(skill, snippet) {
  let attributed = false
  for (const m of snippet.matchAll(/(?:^|[\s$("'|;&])hobby\s+([a-z][a-z-]*)([^|;&)]*)/g)) {
    attributed = true
    commandCount++
    const verb = m[1]
    if (!verbs.has(verb)) {
      problems.push(`${skill}: \`hobby ${verb}\` is not a verb in the CLI's USAGE table`)
      continue
    }
    const accepted = flagsByVerb.get(verb) ?? new Set()
    for (const f of m[2].matchAll(/--([a-z][a-z-]*)/g)) {
      if (f[1] !== 'help' && !accepted.has(f[1])) {
        problems.push(`${skill}: \`hobby ${verb}\` does not accept --${f[1]}`)
      }
    }
  }
  if (!attributed) {
    for (const f of snippet.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)) {
      if (!anyFlag.has(f[1])) problems.push(`${skill}: --${f[1]} is not a flag any hobby verb accepts`)
    }
  }
}

const dirs = existsSync(SKILLS) ? (await readdir(SKILLS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) : []
if (dirs.length === 0) problems.push(`no skills found under ${SKILLS}`)

for (const dir of dirs.sort()) {
  const file = join(SKILLS, dir, 'SKILL.md')
  if (!existsSync(file)) {
    problems.push(`${dir}: no SKILL.md`)
    continue
  }
  const text = await readFile(file, 'utf8')
  const fm = parseFrontmatter(text)
  if (fm === null) {
    problems.push(`${dir}: SKILL.md does not start with --- frontmatter ---`)
    continue
  }
  if (fm.error !== undefined) {
    problems.push(`${dir}: ${fm.error}`)
    continue
  }
  const name = fm.fields.get('name')
  const description = fm.fields.get('description')
  for (const key of fm.fields.keys()) if (!ALLOWED_KEYS.has(key)) problems.push(`${dir}: unknown frontmatter key ${key}`)
  if (name === undefined || name === '') problems.push(`${dir}: frontmatter has no name`)
  else {
    if (name !== dir) problems.push(`${dir}: name "${name}" does not match its directory`)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push(`${dir}: name must be lowercase words joined by single hyphens, at most 64 characters`)
  }
  if (description === undefined || description.trim() === '') problems.push(`${dir}: frontmatter has no description`)
  else {
    if (description.length > 1024) problems.push(`${dir}: description is ${description.length} characters, over 1024`)
    if (/[<>]/.test(description)) problems.push(`${dir}: description contains an angle bracket`)
  }

  for (const snippet of codeSnippets(fm.body)) checkSnippet(dir, snippet)
  for (const m of fm.body.matchAll(/\bhobby_[a-z_]+\b/g)) {
    if (!tools.has(m[0])) problems.push(`${dir}: ${m[0]} is not an MCP tool registered in packages/mcp/src/server.ts`)
  }
  for (const m of text.matchAll(/postgres(?:ql)?:\/\/[^\s:/@]+:([^\s@]+)@/g)) {
    if (m[1] !== 'password') problems.push(`${dir}: shows a connection string with a password in it`)
  }
  if (/\u2014/.test(text)) problems.push(`${dir}: contains an em-dash`)
}

// ------------------------------------------------------------ manifests

async function readJson(rel) {
  const path = join(ROOT, rel)
  if (!existsSync(path)) {
    problems.push(`${rel} is missing`)
    return null
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    problems.push(`${rel} is not valid JSON: ${err.message}`)
    return null
  }
}

const manifest = await readJson('plugin/.claude-plugin/plugin.json')
if (manifest !== null && manifest.name !== 'hobbyist') problems.push('plugin/.claude-plugin/plugin.json: name should be "hobbyist"')

const marketplace = await readJson('.claude-plugin/marketplace.json')
if (marketplace !== null) {
  const entry = (marketplace.plugins ?? []).find((p) => p.name === 'hobbyist')
  if (entry === undefined) problems.push('.claude-plugin/marketplace.json lists no plugin named hobbyist')
  else if (entry.source !== './plugin') problems.push('.claude-plugin/marketplace.json: the hobbyist plugin source should be "./plugin"')
  if (typeof marketplace.name !== 'string' || typeof marketplace.owner?.name !== 'string') problems.push('.claude-plugin/marketplace.json needs name and owner.name')
}

const mcp = await readJson('plugin/.mcp.json')
if (mcp !== null) {
  const server = mcp.mcpServers?.hobby
  if (server?.command !== 'hobby' || JSON.stringify(server?.args) !== '["mcp"]') {
    problems.push('plugin/.mcp.json: mcpServers.hobby must run `hobby mcp` (command "hobby", args ["mcp"])')
  }
}

// ---------------------------------------------------------------- verdict

if (problems.length === 0) {
  console.log(`plugin skills: ${dirs.length} skills, ${commandCount} hobby commands checked against ${verbs.size} verbs and ${tools.size} MCP tools; manifests valid`)
  process.exit(0)
}
for (const problem of problems) console.error(problem)
process.exit(1)
