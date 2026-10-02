/**
 * helparr's version, as displayed. Substituted at build time from
 * `package.json` by `next.config.mjs` (`env.HELPARR_VERSION`), so the sidebar,
 * the login screen and Settings cannot drift from the release that built them.
 */
export const APP_VERSION: string = process.env.HELPARR_VERSION ?? '';
