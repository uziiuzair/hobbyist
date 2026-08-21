// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import sitemap from '@astrojs/sitemap'

// The docs tree is nested one level deeper than Starlight's default so that
// every documentation page lives under /docs/. Starlight routes a file at
// src/content/docs/<path> to /<path>, so the directory below is
// src/content/docs/docs/. The extra segment is what leaves / free for the
// landing page, which is a plain Astro page rather than a Starlight route.
export default defineConfig({
  site: 'https://hobbyist.sh',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Hobbyist',
      description:
        'A self-hosted platform that feels like Neon and Supabase, on hardware you own. Everything sleeps, everything wakes on demand.',
      logo: { src: './src/assets/mark.svg', replacesTitle: false },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/uziiuzair/hobbyist' },
      ],
      customCss: ['./src/styles/tokens.css', './src/styles/starlight.css'],
      editLink: {
        baseUrl: 'https://github.com/uziiuzair/hobbyist/edit/main/site/',
      },
      // The landing page is src/pages/index.astro, so Starlight must not also
      // claim /. Its own 404 is kept: a docs site wants the docs chrome around
      // a missing page.
      disable404Route: false,
      pagination: true,
      lastUpdated: false,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What Hobbyist is', slug: 'docs' },
            { label: 'Install', slug: 'docs/install' },
            { label: 'Your first project', slug: 'docs/first-project' },
            { label: 'Alpha status and known gaps', slug: 'docs/status' },
          ],
        },
        {
          label: 'Concepts',
          items: [{ autogenerate: { directory: 'docs/concepts' } }],
        },
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'docs/guides' } }],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'docs/reference' } }],
        },
        {
          label: 'Decisions',
          collapsed: true,
          items: [{ autogenerate: { directory: 'docs/decisions' } }],
        },
        { label: 'Comparison and pricing', link: '/compare/' },
        { label: 'Contributing', slug: 'docs/contributing' },
      ],
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://hobbyist.sh/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
    }),
    sitemap(),
  ],
})
