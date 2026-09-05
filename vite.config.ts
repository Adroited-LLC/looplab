import { defineConfig } from 'vite';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,

  server: {
    port:       1420,
    strictPort: true,
    host:       host || false,
    hmr:        host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    headers: {
      // Required for SharedArrayBuffer (not used yet but good practice)
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  // Allow soundtouchjs dist to be imported with ?raw
  assetsInclude: [],
});
