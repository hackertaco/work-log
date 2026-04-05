import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  root: 'frontend',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    host: 'localhost',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4310',
      '/auth': 'http://localhost:4310',
    },
  },
});
