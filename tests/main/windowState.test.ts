import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIZE,
  clampToDisplays,
  parseWindowState,
  serializeWindowState,
  windowCreateOptions
} from '../../src/main/windowState'

const MAIN = { x: 0, y: 0, width: 1366, height: 728 }
const RIGHT = { x: 1366, y: 0, width: 1920, height: 1040 }

describe('estado da janela', () => {
  it('padrão: maximizada, sem tamanho salvo (também com lixo salvo)', () => {
    for (const raw of [null, '', 'não é json', '[]', '42', '{"bounds":{"x":"a"}}']) {
      const s = parseWindowState(raw)
      expect(s.maximized).toBe(true)
      expect(s.bounds).toBeNull()
    }
  })

  it('lembra quando o mentor tirou do maximizado (ida e volta)', () => {
    const raw = serializeWindowState({ maximized: false, bounds: { x: 40, y: 30, width: 1000, height: 650 } })
    expect(parseWindowState(raw)).toEqual({ maximized: false, bounds: { x: 40, y: 30, width: 1000, height: 650 } })
    expect(windowCreateOptions(parseWindowState(raw), [MAIN])).toEqual({ x: 40, y: 30, width: 1000, height: 650, maximize: false })
  })

  it('maximizada com tamanho normal salvo: cria com o tamanho normal e maximiza', () => {
    const o = windowCreateOptions({ maximized: true, bounds: { x: 10, y: 10, width: 900, height: 600 } }, [MAIN])
    expect(o).toMatchObject({ width: 900, height: 600, maximize: true })
  })

  it('tela que não existe mais (monitor desligado): abre centralizada na principal', () => {
    const s = { maximized: false, bounds: { x: 2000, y: 100, width: 1200, height: 800 } }
    expect(clampToDisplays(s.bounds, [MAIN])).toBeNull()
    expect(windowCreateOptions(s, [MAIN])).toEqual({ ...DEFAULT_SIZE, maximize: false })
    // com o segundo monitor ligado, vale a posição
    expect(clampToDisplays(s.bounds, [MAIN, RIGHT])).toEqual(s.bounds)
  })

  it('maior que a tela ou meio para fora: encolhe e puxa para dentro da área útil', () => {
    expect(clampToDisplays({ x: -300, y: -50, width: 3000, height: 2000 }, [MAIN])).toEqual(MAIN)
    expect(clampToDisplays({ x: 1000, y: 500, width: 1000, height: 700 }, [MAIN])).toEqual({ x: 366, y: 28, width: 1000, height: 700 })
  })

  it('só uma pontinha visível não conta', () => {
    expect(clampToDisplays({ x: 1300, y: 700, width: 800, height: 600 }, [MAIN])).toBeNull()
  })
})
