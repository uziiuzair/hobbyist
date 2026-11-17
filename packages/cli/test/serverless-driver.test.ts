// The serverless driver endpoints live in @hobby.sh/proxy, which does not
// depend on @hobby.sh/pg, so the name the activity guard ignores is spelled
// in both packages. The daemon depends on both; this is where they are held
// to each other (issue #155).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOBBY_APPLICATION_NAME } from '@hobby.sh/pg'
import { RESERVED_APPLICATION_NAME, SERVERLESS_APPLICATION_NAME } from '@hobby.sh/proxy'

test("the serverless endpoints reserve the same application_name the activity guard ignores", () => {
  assert.equal(RESERVED_APPLICATION_NAME, HOBBY_APPLICATION_NAME)
  assert.notEqual(SERVERLESS_APPLICATION_NAME, HOBBY_APPLICATION_NAME)
})
