import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme } from './theme'
import './styles.css'

async function boot(): Promise<void> {
  // pré-visualização no navegador (`npm run preview:ui`): sem o Electron, usa dados de demonstração
  if (import.meta.env.DEV && !('saga' in window)) {
    const { installFakeSaga } = await import('./dev/fakeSaga')
    await installFakeSaga()
  }
  // o tema salvo vem do processo principal junto com a janela: aplica antes de desenhar
  applyTheme(window.saga.initialTheme ?? 'system')
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
