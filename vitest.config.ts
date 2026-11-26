import { defineConfig } from 'vitest/config'

// Os testes de horário (horário de envio, datas) usam o fuso de Brasília, em qualquer máquina.
process.env.TZ = 'America/Sao_Paulo'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}']
  }
})
