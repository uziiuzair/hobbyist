## Hardware

- Machine: mac-m5pro
- CPU: Apple M5 Pro, 15 cores
- RAM: 24GB
- Disk: internal NVMe SSD
- Filesystem: apfs
- OS: macOS 26.3.2
- Runtime: node v24.19.0
- Page cache dropped between iterations: no

## Results, milliseconds

| scenario | n | fail | accept_parse p50 | wake_issue p50 | container_up p50 | pg_ready p50 | connect_splice p50 | total p50 | total p95 | total max |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline-alpine-poll25 | 50 | 0 | 0.1 | 120.0 | 13.7 | 35.4 | 0.2 | 170.0 | 186.4 | 211.3 |
| poll100-alpine | 50 | 0 | 0.1 | 116.4 | 13.6 | 114.2 | 0.2 | 243.8 | 261.9 | 302.2 |
| poll1000-alpine | 50 | 0 | 0.1 | 120.9 | 12.9 | 1021.3 | 0.2 | 1155.2 | 1173.3 | 1179.0 |
| debian-poll25 | 50 | 0 | 0.1 | 114.0 | 13.2 | 33.5 | 0.2 | 159.9 | 175.7 | 185.4 |
| kill-alpine-poll25 | 50 | 0 | 0.1 | 105.2 | 12.8 | 88.6 | 0.2 | 207.3 | 232.9 | 241.9 |
| recreate-alpine-poll25 | 50 | 0 | 0.0 | 93.9 | 15.5 | 38.8 | 0.2 | 149.8 | 188.4 | 291.3 |
| coldcache-alpine-poll25 | 50 | 0 | 0.0 | 104.3 | 13.5 | 35.6 | 0.2 | 156.9 | 273.0 | 466.5 |

## Gate

Target 1000ms, hard ceiling 3000ms, measured on total p95.

Gate: worst total p95 across scenarios is 1173.3ms. Over target but under the ceiling. Proceed, publish the real number, revisit the levers in M2.
