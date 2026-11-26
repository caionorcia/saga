// Gera o ícone do SagaZap a partir de SVGs próprios (nada de logo de terceiros):
//   build/icon.svg        fonte (desenho completo, para 48 px ou mais)
//   build/icon-small.svg  variante para 16–32 px (bolha maior, raio mais grosso, sem brilho)
//   build/icon.png        1024x1024 (Linux/electron-builder)   build/icon-512.png  512x512
//   build/icon.ico        16, 24, 32, 48, 64, 128, 256 (cada tamanho pequeno com a variante própria)
//   src/renderer/public/favicon.svg   ícone da janela/aba e marca do cabeçalho
//   src/main/trayIcon.ts  ícone da bandeja (16 e 32 px, em base64: sem arquivo de recurso para empacotar)
// Uso: NODE_PATH=<onde está o playwright> node scripts/make-icon.mjs
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import pngToIco from 'png-to-ico'

const { chromium } = createRequire(import.meta.url)('playwright')

// Mentoria + assistente do WhatsApp + rapidez: azulejo verde-azulado (as cores do app), bolha de conversa
// retangular e um raio vazado. Não é o logo do WhatsApp (não há círculo verde nem telefone).
const TILE_TOP = '#14a89a'
const TILE_BOTTOM = '#064e48'

/** raio (Feather "zap", 24x24) posicionado em `scale` a partir de (tx, ty) */
const bolt = (tx, ty, scale, fill, stroke = 1.1) =>
  `<path transform="translate(${tx} ${ty}) scale(${scale})" d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="${fill}" stroke="${fill}" stroke-width="${stroke}" stroke-linejoin="round"/>`

/** desenho completo (viewBox 512) */
export const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${TILE_TOP}"/>
      <stop offset="1" stop-color="${TILE_BOTTOM}"/>
    </linearGradient>
    <linearGradient id="cut" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f9488"/>
      <stop offset="1" stop-color="#075a53"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.25" cy="0.12" r="0.9">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#022c28" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#tile)"/>
  <rect width="512" height="512" rx="116" fill="url(#shine)"/>
  <g filter="url(#shadow)">
    <path d="M168 100h176a76 76 0 0 1 76 76v108a76 76 0 0 1-76 76H232l-92 68 18-70a76 76 0 0 1-66-74V176a76 76 0 0 1 76-76z" fill="#ffffff"/>
  </g>
  ${bolt(136, 104, 10.2, 'url(#cut)')}
</svg>
`

/** variante para 16–32 px: menos detalhe, formas maiores e mais grossas (viewBox 512) */
export const smallSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#11998c"/>
      <stop offset="1" stop-color="#064e48"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="104" fill="url(#tile)"/>
  <path d="M136 64h240a80 80 0 0 1 80 80v152a80 80 0 0 1-80 80H236l-132 84 26-86a80 80 0 0 1-74-78V144a80 80 0 0 1 80-80z" fill="#ffffff"/>
  ${bolt(112, 74, 12, '#075e57', 2.4)}
</svg>
`

const SMALL_MAX = 32

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
const shot = async (size) => {
  const svg = (size <= SMALL_MAX ? smallSvg : fullSvg).replace('<svg ', `<svg width="${size}" height="${size}" `)
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

writeFileSync('build/icon.svg', fullSvg)
writeFileSync('build/icon-small.svg', smallSvg)
writeFileSync('build/icon.png', await shot(1024))
writeFileSync('build/icon-512.png', await shot(512))
const sizes = [16, 24, 32, 48, 64, 128, 256]
// uma captura de cada vez (a página é uma só)
const icoPngs = []
for (const size of sizes) icoPngs.push(await shot(size))
writeFileSync('build/icon.ico', await pngToIco(icoPngs))
writeFileSync('src/renderer/public/favicon.svg', smallSvg)
const tray16 = (await shot(16)).toString('base64')
const tray32 = (await shot(32)).toString('base64')
writeFileSync(
  'src/main/trayIcon.ts',
  `// Gerado por scripts/make-icon.mjs (não editar à mão): ícone do SagaZap para a bandeja, 16 px e 32 px (telas 200%).
export const TRAY_ICON_1X = 'data:image/png;base64,${tray16}'
export const TRAY_ICON_2X = 'data:image/png;base64,${tray32}'
`
)
await browser.close()
