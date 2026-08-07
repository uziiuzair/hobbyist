// Studio is a static bundle the daemon serves; see docs/studio/CLAUDE.md.
// No CDN, no external fonts, no analytics: everything referenced here is
// resolved from node_modules and inlined at build time, so the built
// output works with no internet access.

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Matches HobbyConfig's default apiPort (packages/core/src/config.ts), the
// daemon's loopback control API. Kept as a literal instead of importing
// @hobby.sh/core here so this dev-only proxy target stays independent of
// the daemon's actual runtime config; override with HOBBY_API_PORT if the
// daemon is running on a non-default port locally.
const DEFAULT_API_PORT = 7432
const apiOrigin = `http://127.0.0.1:${process.env['HOBBY_API_PORT'] ?? DEFAULT_API_PORT}`

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      // In dev, forward API and auth calls straight to the daemon's
      // loopback listener so `npm run dev` does not need Caddy in front of
      // it. Production Studio is served by the daemon itself.
      '/v1': apiOrigin,
      '/studio/login': apiOrigin,
      '/studio/logout': apiOrigin,
      '/studio/session': apiOrigin,
    },
  },
})
