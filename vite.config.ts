import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 0.4.0 ships one extensionless import, which plain Node ESM cannot resolve; Vite can.
    server: { deps: { inline: ['@material/material-color-utilities'] } },
  },
})
