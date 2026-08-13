// Compile-time shape assertions for the resource model. No behavior lives in
// types.ts (see its own file comment), so these tests exist to pin down
// object literals that must (or must not) typecheck, not to exercise logic.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppConfig } from '../src/index.js'

test('an app config can carry no image, which is what an undeployed record is', () => {
  // Not a runtime assertion so much as a compile-time one: this object
  // literal failing to typecheck is the failure this test exists to catch.
  const config: AppConfig = {
    image: null,
    containerName: 'hobby-blog-site',
    hostPort: 15500,
    containerPort: 8080,
    hostname: 'blog-site.hobby.local',
    source: null,
    env: {},
    databaseResourceId: null,
  }
  assert.equal(config.image, null)
})
