// Gera build/icon.png (512x512) e build/icon.ico a partir de um SVG próprio.
// Uso: NODE_PATH=<onde está o playwright> node scripts/make-icon.mjs
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import pngToIco from 'png-to-ico'

const { chromium } = createRequire(import.meta.url)('playwright')

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#0f766e"/>
  <path d="M120 112h272a40 40 0 0 1 40 40v168a40 40 0 0 1-40 40H252l-84 76v-76h-48a40 40 0 0 1-40-40V152a40 40 0 0 1 40-40z" fill="#fff"/>
  <text x="256" y="298" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="190" fill="#0f766e">S</text>
</svg>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
const shot = async (size) => {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<body style="margin:0;background:transparent">${svg(size)}</body>`)
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}
writeFileSync('build/icon.png', await shot(512))
const sizes = [16, 24, 32, 48, 64, 128, 256]
writeFileSync('build/icon.ico', await pngToIco(await Promise.all(sizes.map(shot))))
await browser.close()
