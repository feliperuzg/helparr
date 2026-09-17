/**
 * Startup contract (REQ-DEPLOY-008, REQ-DEPLOY-010 / NFR2, NFR6).
 *
 * Next calls `register()` once, before the server accepts its first request.
 * Until this file existed, helparr had no such moment: every piece of
 * configuration was resolved lazily, on whatever request happened to need it
 * first. That makes "fail fast with an actionable message" unimplementable
 * rather than merely unimplemented — a missing encryption key could only ever
 * surface as a broken page halfway through an operator's evening, and a
 * container with a bad key would report itself healthy right up until someone
 * tried to use it.
 *
 * So the order here is deliberate, cheapest and most-likely-wrong first:
 *
 *   1. Parse the configuration, reporting every problem at once.
 *   2. Check the compiled base path against the configured one.
 *   3. Resolve the encryption key — from the variable or the `_FILE`
 *      indirection — without touching the database.
 *   4. Open the database, which proves the key against page 1 and runs any
 *      pending migrations.
 *
 * Every failure is terminal. None of them is retried, and none of them is
 * downgraded to a warning: a process that starts in a state it has already
 * identified as broken is worse than one that refuses, because the former gets
 * put behind a healthcheck and forgotten.
 */

export async function register(): Promise<void> {
  // The proxy runs on the edge runtime and must not drag `node:fs`, the native
  // SQLite binding, or anything else server-only into its bundle.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const [{ getConfig, assertBasePathMatches }, { assertEncryptionKeyPresent }, { getDb }, { logger }] =
    await Promise.all([
      import('@/server/config'),
      import('@/server/crypto'),
      import('@/server/db'),
      import('@/server/logging/redact'),
    ]);

  try {
    const config = getConfig();
    assertBasePathMatches();
    assertEncryptionKeyPresent();

    // Opening the handle here is what makes migrations automatic (NFR6):
    // `getDb()` runs them and is a no-op against a current schema, so an
    // upgraded image migrates before it serves rather than during a request.
    getDb();

    logger.info('helparr ready', {
      databasePath: config.databasePath,
      basePath: config.basePath || '(root)',
      logLevel: config.logLevel,
      queueRefreshSeconds: config.queueRefreshSeconds,
      // Which source, never the value. `registerSecret` already covers the
      // value; naming the source is what tells an operator whether the
      // indirection they configured is the one actually in use.
      encryptionKeySource: config.encryptionKeySource,
    });
  } catch (error) {
    fail(error);
  }
}

/**
 * Writes the cause to stderr and exits non-zero.
 *
 * Deliberately `console.error` rather than the structured logger: this message
 * is the only thing an operator will see, it may be the reason the logger's own
 * configuration could not be parsed, and `docker logs` on a container that
 * exited immediately should show a paragraph a human can act on rather than a
 * JSON object they have to decode.
 */
function fail(error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`\nhelparr failed to start.\n\n${detail}\n`);
  process.exit(1);
}
