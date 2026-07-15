import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3100',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: false,
  },
});
