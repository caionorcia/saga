import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devCsp } from './config/devCsp'

// Pré-visualização da interface no navegador, com `window.saga` falso (src/renderer/src/dev/fakeSaga.ts).
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), devCsp()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true }
})
