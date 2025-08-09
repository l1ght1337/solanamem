import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import nodePolyfills from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills()
  ],
  define: {
    'process.env': {}, // some packages expect this
    global: 'globalThis',
  },
  server: {
    host: true
  },
  preview: {
    host: true
  }
})
