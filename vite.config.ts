import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: fileURLToPath(new URL('./src/monitor/ui/', import.meta.url)),
  base: '/',
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./dist/monitor-ui/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
