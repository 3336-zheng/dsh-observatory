import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist-demo',
    sourcemap: true,
  },
  server: {
    port: 4173,
    strictPort: false,
  },
})
