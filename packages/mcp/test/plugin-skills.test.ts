// The agent plugin's skills (plugin/skills/*/SKILL.md) against the real CLI
// and MCP surface. The checking itself is site/scripts/check-plugin-skills.mjs,
// which needs no build; this runs it inside `npm test` so a renamed verb,
// flag or tool fails here as well as in the site job. Lives in the MCP
// package because the plugin's MCP config starts this package's server.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'site', 'scripts', 'check-plugin-skills.mjs')

test('every plugin skill has valid frontmatter and names only real verbs, flags and tools', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /plugin skills: 4 skills/)
})
