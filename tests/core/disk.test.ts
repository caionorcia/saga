import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasFreeSpace } from '../../src/core/disk'

describe('hasFreeSpace', () => {
  it('compara o espaço livre com o mínimo pedido', async () => {
    expect(await hasFreeSpace(tmpdir(), 1)).toBe(true)
    expect(await hasFreeSpace(tmpdir(), Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  it('pasta ainda não criada usa o primeiro pai existente', async () => {
    expect(await hasFreeSpace(join(tmpdir(), 'saga-nao-existe', 'media'), 1)).toBe(true)
  })
})
