#!/usr/bin/env node
// The `hobby` binary itself. Deliberately not compiled TypeScript: this is
// the one file in the package tsc never sees (it is outside src/test, which
// is what tsconfig.json includes), a thin, plain-JS shim that loads the
// compiled command surface and calls the one function in this package
// allowed to exit the process.

import { main } from '../dist/src/cli/main.js'

main(process.argv.slice(2))
