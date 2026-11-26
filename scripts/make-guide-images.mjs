// Tira as imagens do guia (docs/img) das telas do próprio app, usando a pré-visualização com dados de demonstração.
// Uso: npm run preview:ui (em outro terminal) e NODE_PATH=<onde está o playwright> node scripts/make-guide-images.mjs
// (CHROME_PATH=<chrome> para usar um navegador já instalado em vez do baixado pelo playwright)
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const BASE = 'http://127.0.0.1:5199/'
const OUT = 'docs/img'

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2, locale: 'pt-BR' })
const page = await ctx.newPage()
const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts })

// assistente
await page.goto(`${BASE}?setup=1`)
await page.getByRole('button', { name: 'Entendi, vamos começar' }).waitFor()
await shot('01-boas-vindas')
await page.getByRole('button', { name: 'Entendi, vamos começar' }).click()
await page.getByPlaceholder('gsk_…').fill('gsk_exemplo_chave_demo_123456')
await page.getByRole('button', { name: 'Testar' }).click()
await page.getByText('Chave funcionando ✓').waitFor()
await shot('02-chave-groq')
await page.getByRole('button', { name: 'Continuar' }).click()
await page.getByRole('button', { name: 'Pular' }).click()
await page.getByRole('heading', { name: 'Vincule o seu WhatsApp' }).waitFor()
await page.waitForTimeout(300)
await shot('03-qr-code')
await page.evaluate(() => window.__sagaFake.setState({ conn: 'open', qr: null }))
await page.getByRole('heading', { name: 'Importando as conversas' }).waitFor()
await shot('04-importando')

// tela principal
await page.goto(BASE)
await page.locator('.contact-main').first().click()
await page.getByRole('button', { name: /Salvar/ }).first().waitFor()
await page.waitForTimeout(500)
await shot('05-tela-principal')

// vincular de novo: QR Code na tela principal
await page.goto(`${BASE}?qr=1`)
await page.getByRole('button', { name: 'Gerar novo QR Code' }).waitFor()
await page.waitForTimeout(300)
await shot('estado-vincular-de-novo')

// respondido no grupo do mentorado (v0.2.3)
await page.goto(BASE)
await page.locator('.contact-name', { hasText: /^Beatriz Alves$/ }).click()
await page.getByRole('region', { name: 'Para responder' }).waitFor()
await page.waitForTimeout(500)
await shot('respondido-no-grupo')

// tema escuro (v0.2.3)
await page.goto(`${BASE}?theme=dark`)
await page.locator('.contact-main').first().click()
await page.getByRole('button', { name: /Salvar/ }).first().waitFor()
await page.waitForTimeout(500)
await shot('tema-escuro')

// configurações › atualizações (v0.2.3)
await page.goto(BASE)
await page.getByRole('button', { name: 'Configurações' }).click()
await page.getByRole('button', { name: 'Verificar agora' }).click()
await page.getByText(/você já está na versão mais nova/).waitFor()
await page.getByRole('region', { name: 'Atualizações' }).screenshot({ path: `${OUT}/config-atualizacoes.png` })

// base de conhecimento, "Baseado em" e Foco (v0.3.0; base de demonstração)
await page.goto(BASE)
await page.getByRole('button', { name: 'Configurações' }).click()
const kb = page.getByRole('region', { name: 'Base de conhecimento' })
await kb.getByText('Método Exemplo (demonstração)').waitFor()
await kb.evaluate((el) => el.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(300)
await shot('base-de-conhecimento')
await page.goto(BASE)
await page.locator('.contact-name', { hasText: /^Mentoria Turma 3/ }).click()
await page.locator('.kb-chip').first().waitFor()
await page.waitForTimeout(500)
await page.locator('.suggestions').screenshot({ path: `${OUT}/baseado-em.png` })
await page.evaluate(() => localStorage.setItem('saga.focus', '1'))
await page.goto(BASE)
await page.locator('.contact-main').first().waitFor()
await page.waitForTimeout(300)
await page.locator('nav.contacts').screenshot({ path: `${OUT}/foco.png` })
await page.evaluate(() => localStorage.removeItem('saga.focus'))

// busca geral com "Resumir com IA" e a mensagem destacada; cópia de segurança (v0.3.1)
await page.goto(BASE)
await page.getByLabel('Procurar em todas as conversas e transcrições').fill('quem falou sobre preço?')
await page.keyboard.press('Enter')
await page.getByRole('button', { name: 'Resumir com IA' }).click()
await page.getByText('Resumo da IA').waitFor()
await page.locator('.gs-hit', { hasText: 'travei na parte' }).click()
await page.locator('.bubble-highlight').waitFor()
await page.waitForTimeout(700)
await shot('busca')
await page.goto(BASE)
await page.getByRole('button', { name: 'Configurações' }).click()
const backup = page.getByRole('region', { name: 'Cópia de segurança' })
await backup.locator('.backup-last').waitFor()
await backup.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
// o grupo é mais alto que a janela: aumenta só para esta imagem
await page.setViewportSize({ width: 1366, height: 1500 })
await backup.evaluate((el) => el.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(300)
await backup.screenshot({ path: `${OUT}/copia-de-seguranca.png` })
await page.setViewportSize({ width: 1366, height: 768 })

// horário de envio (v0.4.1)
await page.goto(BASE)
await page.getByRole('button', { name: 'Configurações' }).click()
const hours = page.locator('#send-hours')
await hours.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await hours.screenshot({ path: `${OUT}/config-horario-envio.png` })
// envio direto e IAs gratuitas de reserva (cartões das Configurações, v0.8.2)
const direct = page.getByRole('region', { name: 'Envio direto' })
await direct.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await direct.screenshot({ path: `${OUT}/config-envio-direto.png` })
const free = page.getByRole('region', { name: 'IAs gratuitas de reserva (opcional)' })
await free.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await free.screenshot({ path: `${OUT}/config-ias-reserva.png` })
await page.goto(`${BASE}?hours=outside`)
await page.locator('.contact-main').first().click()
await page.getByRole('button', { name: 'Enviar', exact: true }).first().click()
await page.getByRole('checkbox', { name: /Forçar envio/ }).check()
await page.getByRole('button', { name: 'Enviar mesmo assim' }).waitFor()
await page.waitForTimeout(300)
await page.locator('.send-dialog').screenshot({ path: `${OUT}/enviar-fora-do-horario.png` })

// faixa de estado
const states = {
  'estado-conectado': {},
  'estado-pausado': { paused: true },
  'estado-reconectando': { conn: 'waiting_retry' },
  'estado-vincule-novamente': { conn: 'stopped_logged_out' },
  'estado-pouco-espaco': { diskLow: true },
  'estado-atualizacao': { update: { status: 'available', version: '0.2.4' } }
}
for (const [name, patch] of Object.entries(states)) {
  await page.goto(`${BASE}?state=${encodeURIComponent(JSON.stringify(patch))}`)
  await page.locator('header.statusbar').waitFor()
  await page.waitForTimeout(300)
  await shot(name, { clip: { x: 0, y: 0, width: 1366, height: 64 } })
}
await browser.close()
