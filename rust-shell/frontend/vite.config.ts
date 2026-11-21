import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.RUST_SHELL_DEV_PORT || 5173),
    strictPort: true,
    hmr: { path: '/__vite_hmr' },
    fs: { strict: true, allow: [fileURLToPath(new URL('.', import.meta.url))] },
  },
});
