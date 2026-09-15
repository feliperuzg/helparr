import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

/**
 * Flat config, required since Next 16: `next lint` was removed and
 * `eslint-config-next@16` peers on ESLint >= 9, which no longer reads
 * `.eslintrc.json`. `npm run lint` now calls the ESLint CLI directly.
 */
const config = [
  // Flat config has no `ignorePatterns` — ignores are a config object of their
  // own, and it must come first to apply to the whole run.
  {
    ignores: [
      '.next/**',
      // A design-system visualization, not production code. It is plain JSX on
      // its own Vite toolchain and deliberately does not follow the app's rules.
      'arx/prototype/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
];

export default config;
