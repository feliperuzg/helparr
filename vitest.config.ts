import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws unless it is resolved under React's react-server
      // condition. Its job is to fail the *Next build* if a server module is
      // pulled into a client bundle; under Node in vitest there is no such
      // boundary to police, so it resolves to nothing.
      'server-only': fileURLToPath(new URL('./test/helpers/noop.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The bundle-leak check reads `next build` output, so it cannot run in the
    // default lane on a clean checkout. `npm run test:bundle` sets the flag
    // after building. It is opted in rather than skipped-when-missing so a
    // forgotten build fails the run instead of quietly passing.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.HELPARR_BUNDLE_TEST ? [] : ['**/bundle-leak.test.ts']),
      // Same reasoning for the axe scan, which additionally needs a downloaded
      // Chromium and boots the standalone server on a real port.
      ...(process.env.HELPARR_A11Y_TEST ? [] : ['**/a11y.test.ts']),
      // And for the browser lane: the removal walkthrough, which drives the
      // real DELETE route against a real upstream, the perf guards, which
      // measure real frames against a real 500-row queue and a real 300-release
      // answer, the keyboard layers, which need a real focus model, and the grab
      // confirmation, whose whole claim is about what the UI has *not* sent yet.
      ...(process.env.HELPARR_E2E_TEST
        ? []
        : [
          '**/queue-removal.test.ts',
          '**/queue-perf.test.ts',
          '**/queue-interaction.test.ts',
          '**/search-grab.test.ts',
          '**/search-interaction.test.ts',
          '**/search-perf.test.ts',
          '**/saved-search-interaction.test.ts',
          '**/first-run.test.ts',
          '**/reduced-motion.test.ts',
          '**/gaps-interaction.test.ts',
          '**/gaps-perf.test.ts',
          '**/rename-interaction.test.ts',
          '**/rename-perf.test.ts',
        ]),
    ],
    // The suite opens real encrypted SQLite files and real loopback HTTP
    // servers; running files in parallel would have them fight over ports and
    // over the module-level client caches.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
