// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Settings } from '../../src/renderer/src/components/Settings'
import { StatusBar } from '../../src/renderer/src/components/StatusBar'
import { createFakeSaga, DEFAULT_STATE } from '../../src/renderer/src/dev/fakeSaga'
import { applyTheme, resolveTheme, setThemePref, themePref, toggledTheme } from '../../src/renderer/src/theme'
import { THEME_ARG, themeFromArgv } from '../../src/shared/api'

beforeEach(() => applyTheme('system'))
afterEach(cleanup)

describe('tema: regras', () => {
  it('Automático segue o sistema; Claro/Escuro valem sempre', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('o botão inverte o tema que está valendo', () => {
    expect(toggledTheme('system', true)).toBe('light')
    expect(toggledTheme('system', false)).toBe('dark')
    expect(toggledTheme('dark', false)).toBe('light')
    expect(toggledTheme('light', true)).toBe('dark')
  })

  it('o tema inicial vem da linha de comando do preload (padrão: Automático)', () => {
    expect(themeFromArgv(['electron', `${THEME_ARG}dark`])).toBe('dark')
    expect(themeFromArgv([`${THEME_ARG}light`])).toBe('light')
    expect(themeFromArgv([`${THEME_ARG}roxo`])).toBe('system')
    expect(themeFromArgv([])).toBe('system')
  })

  it('applyTheme escreve <html data-theme>; setThemePref salva nas configurações', async () => {
    const ctl = createFakeSaga()
    window.saga = ctl.api
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(await setThemePref('dark')).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect((await ctl.api.getSettings()).theme).toBe('dark')
  })

  it('se não salvar, volta ao tema anterior', async () => {
    window.saga = { ...createFakeSaga().api, saveSettings: async () => ({ ok: false, code: 'invalid', message: 'x' }) }
    applyTheme('light')
    expect(await setThemePref('dark')).toBe(false)
    expect(themePref()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('tema: interface', () => {
  it('barra de cima: botão sol/lua com nome acessível; clicar troca e salva', async () => {
    const ctl = createFakeSaga()
    window.saga = ctl.api
    applyTheme('light')
    render(<StatusBar state={DEFAULT_STATE} settingsOpen={false} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Usar o tema escuro' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Usar o tema claro' })).toBeTruthy())
    expect(document.documentElement.dataset.theme).toBe('dark')
    await waitFor(async () => expect((await ctl.api.getSettings()).theme).toBe('dark'))
  })

  it('Configurações › Tema: Automático (do Windows) / Claro / Escuro, padrão Automático', async () => {
    const ctl = createFakeSaga()
    window.saga = ctl.api
    render(<Settings />)
    const auto = (await screen.findByRole('radio', { name: 'Automático (do Windows)' })) as HTMLInputElement
    expect(auto.checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Escuro' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect((screen.getByRole('radio', { name: 'Escuro' }) as HTMLInputElement).checked).toBe(true)
    await waitFor(async () => expect((await ctl.api.getSettings()).theme).toBe('dark'))
    fireEvent.click(screen.getByRole('radio', { name: 'Automático (do Windows)' }))
    expect(document.documentElement.dataset.theme).toBe('system')
  })
})
