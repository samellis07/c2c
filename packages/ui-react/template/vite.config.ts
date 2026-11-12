/**
 * Build config of a generated c2c app. Platform file: written on the first
 * generation and by an explicit platform upgrade, never by a regeneration.
 * Slate builds with `npm run build` and serves dist/ (framework react-vite).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { c2cBuild, readSwTemplate } from './lib/c2c-ui/vite/plugin.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Slate serves from the site root; a non-root base would break every asset URL.
  base: '/',
  plugins: [react(), c2cBuild({ swTemplate: readSwTemplate(here('./lib/c2c-ui/pwa/sw.template.js')) })],
  resolve: {
    alias: { '@c2c/ui': here('./lib/c2c-ui/index.ts') },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      // The entry keeps its exports: boot(spec, document) is part of the bundle contract.
      preserveEntrySignatures: 'exports-only',
      input: here('./src/main.tsx'),
      output: {
        entryFileNames: 'assets/runtime.[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
        minifyInternalExports: false,
        manualChunks(id: string) {
          return /[\\/]src[\\/]generated[\\/]model\.ts$/.test(id) ? 'model' : undefined;
        },
      },
    },
  },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
