import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiagLog, diagnosticsText, redactSecrets } from '../../src/main/diagLog'

describe('registro de diagnóstico', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-log-'))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('cria a pasta e grava uma linha por evento, com horário ISO', () => {
    const dir = join(tmp, 'logs')
    const log = createDiagLog(dir, { now: () => Date.UTC(2026, 10, 24, 12) })
    log.write('wa_close', 'código 405:\nConnection Failure')
    log.write('startup')
    const text = readFileSync(join(dir, 'saga.log'), 'utf8')
    expect(text).toBe('2026-11-24T12:00:00.000Z wa_close código 405: | Connection Failure\n2026-11-24T12:00:00.000Z startup\n')
  })

  it('gira ao passar do tamanho, guardando só um arquivo antigo', () => {
    const log = createDiagLog(tmp, { maxBytes: 200 })
    for (let i = 0; i < 30; i++) log.write('linha', `numero ${i} ${'x'.repeat(20)}`)
    expect(existsSync(join(tmp, 'saga.log.1'))).toBe(true)
    expect(existsSync(join(tmp, 'saga.log.2'))).toBe(false)
    expect(readFileSync(join(tmp, 'saga.log'), 'utf8').length).toBeLessThan(260)
    // tail junta o antigo e o atual, em ordem
    const t = log.tail(5)
    expect(t).toHaveLength(5)
    expect(t.at(-1)).toMatch(/numero 29 /)
    expect(t[0]).toMatch(/numero 25 /)
  })

  it('mascara chaves de API', () => {
    expect(redactSecrets('chave gsk_ABCDEFGH12345678 e sk-ant-api03-XYZXYZXYZ e sk-proj-abcdefgh1')).toBe(
      'chave [chave omitida] e [chave omitida] e [chave omitida]'
    )
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [omitido]')
    const log = createDiagLog(tmp)
    log.write('ai_error', 'falhou com gsk_SEGREDO123456789')
    expect(readFileSync(join(tmp, 'saga.log'), 'utf8')).not.toMatch(/SEGREDO/)
  })

  it('falha de escrita não lança', () => {
    const log = createDiagLog(join(tmp, 'saga.log', 'nao-e-pasta'))
    // a "pasta" é um arquivo depois do primeiro write abaixo
    createDiagLog(tmp).write('x')
    expect(() => log.write('y')).not.toThrow()
    expect(log.tail(10)).toEqual([])
  })

  it('texto do diagnóstico: cabeçalho e as últimas linhas', () => {
    const log = createDiagLog(tmp)
    for (let i = 0; i < 5; i++) log.write('ev', String(i))
    const t = diagnosticsText(log, { 'SagaZap': '0.1.1', 'Electron': '45' }, 3)
    expect(t).toMatch(/^=== Diagnóstico do SagaZap ===\nSagaZap: 0.1.1\nElectron: 45\nRegistro: 3 linhas/)
    expect(t.trim().split('\n').slice(-3).map((l) => l.split(' ').at(-1))).toEqual(['2', '3', '4'])
    expect(diagnosticsText(createDiagLog(join(tmp, 'vazio')), {})).toMatch(/\(registro vazio\)/)
  })
})
