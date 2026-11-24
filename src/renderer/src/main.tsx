import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

async function boot(): Promise<void> {
  // pré-visualização no navegador (`npm run preview:ui`): sem o Electron, usa dados de demonstração
  if (import.meta.env.DEV && !('saga' in window)) {
    const { installFakeSaga } = await import('./dev/fakeSaga')
    await installFakeSaga()
  }
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
