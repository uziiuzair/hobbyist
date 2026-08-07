// Naming rules and the two ways a name gets split apart: the routing key a
// client sends in the Postgres startup packet (project.database), and the
// target a human types at the CLI (project/resource).

import { HobbyError } from './errors.js'

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}$/
const RESERVED_NAMES = ['postgres', 'template0', 'template1', 'hobby']

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new HobbyError(
      'invalid_name',
      `invalid name: ${name}`,
      'names must match ^[a-z][a-z0-9-]{1,62}$, that is: start with a lowercase letter, ' +
        'then 1 to 62 more lowercase letters, digits or hyphens (2 to 63 characters total)'
    )
  }
  if (RESERVED_NAMES.includes(name)) {
    throw new HobbyError(
      'invalid_name',
      `reserved name: ${name}`,
      `the names ${RESERVED_NAMES.join(', ')} are reserved and cannot be used`
    )
  }
}

export function parseRoutingKey(database: string): { project: string; database: string | null } {
  const dotIndex = database.indexOf('.')
  if (dotIndex === -1) {
    return { project: database, database: null }
  }
  return {
    project: database.slice(0, dotIndex),
    database: database.slice(dotIndex + 1),
  }
}

export function parseTarget(target: string): { project: string; resource: string | null } {
  const slashIndex = target.indexOf('/')
  if (slashIndex === -1) {
    return { project: target, resource: null }
  }
  return {
    project: target.slice(0, slashIndex),
    resource: target.slice(slashIndex + 1),
  }
}
