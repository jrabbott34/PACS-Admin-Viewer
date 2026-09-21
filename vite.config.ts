import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Single source of truth for the version shown in the About dialog — read from
// package.json at build time rather than duplicated by hand, so it can't drift.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')) as {
  version: string;
};

// Cornerstone3D notes:
//  - the DICOM image loader spawns module workers and loads WASM codecs itself,
//    so it must not be pre-bundled by the dependency optimizer.
//  - dicom-parser is CommonJS and needs to be pre-bundled.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    // dcmjs pulls in xmlbuilder2, which expects Node's `events`/`url` to exist.
    alias: {
      events: 'events/events.js',
      url: 'url/url.js',
    },
  },
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: [
      'dicom-parser',
      '@cornerstonejs/codec-charls/decodewasmjs',
      '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
      '@cornerstonejs/codec-openjpeg/decodewasmjs',
      '@cornerstonejs/codec-openjph/wasmjs',
    ],
  },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
