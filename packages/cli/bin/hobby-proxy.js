#!/usr/bin/env node
// The proxy process the daemon spawns and adopts
// (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md). Plain JS for the
// same reason as hobby.js: tsc never sees this file.

import { proxydMain } from '../dist/src/proxyd/main.js'

proxydMain()
