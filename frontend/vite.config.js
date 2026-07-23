import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Same-origin in dev: cookies flow to the API and the WebSocket.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
