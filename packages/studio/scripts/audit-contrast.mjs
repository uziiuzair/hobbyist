// WCAG contrast gate for the Nocturne ramps. Fails the build when any pair
// documented here drops below its floor. Pairs list every ink and jewel
// label against every surface it is used on. Floors: 4.5 body, 3.0 large.
const DARK = { ground: '131110', surface: '1a1715', s2: '211d1a', s3: '2a2521' }
const LIGHT = { ground: 'faf9f7', surface: 'ffffff', s2: 'f6f4f1', s3: 'edeae4' }

const PAIRS = [
  // [name, fg, surfaces, floor]
  ['dark ink', 'f2eee6', DARK, 4.5],
  ['dark ink-2', 'b9ae9f', DARK, 4.5],
  ['dark ink-3', '998f80', DARK, 4.5],
  ['dark sage label', '97d8b0', DARK, 4.5],
  ['dark iris label', 'b6acf5', DARK, 4.5],
  ['dark honey label', 'e3b878', DARK, 4.5],
  ['dark rose label', 'e9a3ab', DARK, 4.5],
  ['dark waking', 'e9b45c', DARK, 4.5],
  ['dark danger', 'ee8a7c', DARK, 4.5],
  ['dark accent-ink on accent', '052419', { accent: '4ed492' }, 4.5],
  ['light ink', '1c1917', LIGHT, 4.5],
  ['light ink-2', '5f5a52', LIGHT, 4.5],
  ['light ink-3', '6e685e', LIGHT, 4.5],
]

function lum(hex) {
  const c = hex.match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

let failed = false
for (const [name, fg, surfaces, floor] of PAIRS) {
  for (const [sname, hex] of Object.entries(surfaces)) {
    const r = ratio(fg, hex)
    if (r < floor) {
      failed = true
      console.error(`contrast gate: ${name} on ${sname} is ${r.toFixed(2)}, floor ${floor}`)
    }
  }
}
if (failed) process.exit(1)
console.log('contrast gate: every documented pair clears its floor')
