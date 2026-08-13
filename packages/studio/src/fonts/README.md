# Bundled faces

Fraunces (display), IBM Plex Sans (interface), JetBrains Mono (data). Latin
woff2 subsets from the @fontsource packages, licenses alongside (all OFL).

Bundled, not system, because Nocturne's voice needs a display serif, and the
constraint was never "system fonts": it was offline. These files ship in the
repo and load via local @font-face; nothing is fetched at runtime. See
docs/superpowers/specs/2026-08-14-studio-nocturne-design.md.
