import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    host: true,
  },
  optimizeDeps: {
    exclude: ['@robot-arena/shared'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
});
