import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { searchForWorkspaceRoot } from 'vite'
import { defineConfig } from 'vitest/config'

// The UI kit (@tomato1337/m3e-*) has the same browser floor: WebKitGTK/Safari 17.5 (Linux, macOS) and
// Chromium 123 (WebView2). Older CSS targets would make Lightning CSS rewrite light-dark().
const targets = ['chrome123', 'safari17.5']

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // One React for the app and a kit linked from ../m3e with `npm link` (AGENTS.md, "UI kit").
    dedupe: ['react', 'react-dom'],
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // A linked kit lives outside the project; its fonts are served from there.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('../m3e', import.meta.url))] },
  },
  build: { target: ['es2023', ...targets], cssTarget: targets },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // @tomato1337/m3e-tokens uses @material/material-color-utilities 0.4, which ships one extensionless
    // import that plain Node ESM cannot resolve; Vite can. Both go through Vite: an externalized kit
    // would load the utilities through Node.
    server: { deps: { inline: ['@tomato1337/m3e-tokens', '@material/material-color-utilities'] } },
  },
})
