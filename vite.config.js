import { defineConfig } from 'vite';
import injectHTML from 'vite-plugin-html-inject';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: '.', 
  publicDir: 'static',
  plugins: [
    injectHTML(),
    tailwindcss()
  ],
  server: {
    host: '0.0.0.0',
    port: 8621,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8500',
        changeOrigin: true,
      },
      '/static/data': {
        target: 'http://127.0.0.1:8500',
        changeOrigin: true,
      },
    },
  },
});