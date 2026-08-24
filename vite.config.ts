import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      // Dev-time proxy to the local gantt-api (same-origin /api in prod
      // is handled by the nginx vhost).
      '/api': 'http://127.0.0.1:4600',
    },
  },
})
