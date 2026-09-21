import { defineConfig } from 'vite';

// Cornerstone3D notes:
//  - the DICOM image loader spawns module workers and loads WASM codecs itself,
//    so it must not be pre-bundled by the dependency optimizer.
//  - dicom-parser is CommonJS and needs to be pre-bundled.
export default defineConfig({
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
