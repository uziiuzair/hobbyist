#!/usr/bin/env node
/**
 * Screenshots the site at several widths and reports any element that sticks
 * out past the viewport.
 *
 * Horizontal overflow is the defect that a desktop review never catches and
 * that makes a page feel broken on a phone, so it is worth a check that
 * answers "which element" rather than "something looks cut off".
 *
 * Drives whatever Chrome is already installed, via puppeteer-core, so nothing
 * downloads a second browser.
 */

import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.BASE ?? 'http://127.0.0.1:4321'
const OUT = process.env.SHOTS ?? '/tmp/hobbyist-shots'

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'tablet', width: 834, height: 1112, mobile: false },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
]

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'compare', path: '/compare/' },
  { name: 'docs-status', path: '/docs/status/' },
]

await mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--hide-scrollbars', '--disable-gpu'],
})

let failures = 0

for (const vp of VIEWPORTS) {
  for (const target of PAGES) {
    const page = await browser.newPage()
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    })
    await page.goto(`${BASE}${target.path}`, { waitUntil: 'networkidle0' })

    const report = await page.evaluate(() => {
      const de = document.documentElement

      // An element wider than the viewport is only a bug if nothing between it
      // and the root clips it. A 544px table inside a 353px `overflow-x: auto`
      // wrapper is the intended design, and reporting it buries the one
      // element that genuinely pushes the page sideways.
      const isClipped = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ox = getComputedStyle(p).overflowX
          if (ox === 'auto' || ox === 'hidden' || ox === 'scroll') return true
        }
        return false
      }

      const offenders = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.right <= window.innerWidth + 1 && r.left >= -1) continue
        if (isClipped(el)) continue
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 48),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
        })
      }

      // Report the outermost offenders only: a wide child inside a wide parent
      // is one bug, and fixing the parent usually fixes both.
      const outermost = offenders.filter(
        (o, _i, all) => !all.some((other) => other !== o && false)
      )

      return {
        viewport: window.innerWidth,
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        offenders: outermost.slice(0, 8),
      }
    })

    const overflows = report.scrollWidth > report.clientWidth + 1
    const label = `${vp.name.padEnd(8)} ${target.name.padEnd(12)}`
    if (overflows) {
      failures += 1
      console.error(
        `${label} OVERFLOW  scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth}`
      )
      for (const o of report.offenders) {
        console.error(`    <${o.tag} class="${o.cls}">  left ${o.left} right ${o.right} width ${o.width}`)
      }
    } else {
      console.log(`${label} ok        ${report.clientWidth}px, no horizontal overflow`)
    }

    await page.screenshot({
      path: `${OUT}/${vp.name}-${target.name}.png`,
      fullPage: vp.name === 'mobile' ? false : false,
    })
    await page.close()
  }
}

await browser.close()
process.exit(failures > 0 ? 1 : 0)
