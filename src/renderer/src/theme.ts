/**
 * Tema da interface: Automático (segue o Windows), Claro ou Escuro. O valor fica em `<html data-theme>`; o CSS escolhe
 * as cores com light-dark() e `color-scheme`. A escolha é salva nas configurações (processo principal), que também
 * acerta a moldura da janela e as barras de rolagem (`nativeTheme.themeSource`).
 */
import { useEffect, useState } from 'react'
import type { ThemePref } from '../../shared/api'

const DARK_QUERY = '(prefers-color-scheme: dark)'
let current: ThemePref = 'system'
const listeners = new Set<() => void>()

/** Escreve o tema em `<html data-theme>` (antes da primeira pintura, no início do app). */
export function applyTheme(pref: ThemePref): void {
  current = pref
  document.documentElement.dataset.theme = pref
  listeners.forEach((l) => l())
}

export const themePref = (): ThemePref => current

/** O Windows (ou o navegador) está no modo escuro? */
export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

/** O tema que está valendo agora. */
export function resolveTheme(pref: ThemePref, systemDark = systemPrefersDark()): 'light' | 'dark' {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}

/** O botão da barra de cima: inverte o tema que está valendo (e passa a ser uma escolha fixa). */
export const toggledTheme = (pref: ThemePref, systemDark = systemPrefersDark()): ThemePref =>
  resolveTheme(pref, systemDark) === 'dark' ? 'light' : 'dark'

/** Muda o tema já e salva nas configurações; se não salvar, volta ao anterior. */
export async function setThemePref(pref: ThemePref): Promise<boolean> {
  const prev = current
  applyTheme(pref)
  try {
    const r = await window.saga.saveSettings({ theme: pref })
    if (!r.ok) applyTheme(prev)
    return r.ok
  } catch {
    applyTheme(prev)
    return false
  }
}

/** O tema escolhido e o que está valendo (acompanha o Windows no Automático). */
export function useTheme(): { pref: ThemePref; resolved: 'light' | 'dark' } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    let mq: MediaQueryList | null = null
    try {
      mq = typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null
      mq?.addEventListener?.('change', l)
    } catch {
      mq = null
    }
    return () => {
      listeners.delete(l)
      mq?.removeEventListener?.('change', l)
    }
  }, [])
  return { pref: current, resolved: resolveTheme(current) }
}

export const THEME_LABELS: Record<ThemePref, string> = {
  system: 'Automático (do Windows)',
  light: 'Claro',
  dark: 'Escuro'
}
