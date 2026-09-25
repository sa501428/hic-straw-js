import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'HicStraw',
      fileName: (format) => format === 'es' ? 'hic-straw.esm.js' : 'hic-straw.cjs',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Keep runtime dependencies external. In particular, bundling zstddec can
      // capture another module's lexical `fetch` binding in the CommonJS build,
      // which prevents its WebAssembly decoder from initializing under Node.
      external: [
        /^hdf5-indexed-reader(\/|$)/,
        'node-fetch',
        'zstddec',
      ],
      output: {
        esModule: true,
        exports: 'named',
      },
    },
    sourcemap: true,
  },
});
