import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const backendPort = process.env.PORT ?? '3000';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://localhost:${backendPort}`, ws: true },
      '/health': { target: `http://localhost:${backendPort}` },
    },
  },
});
