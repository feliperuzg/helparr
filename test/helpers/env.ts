import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Side-effect module: sets the environment the server modules read at first
 * use. It must be imported BEFORE any `@/server/...` module, because both the
 * encryption key and the database handle are cached on first access.
 */

export const testDir = mkdtempSync(join(tmpdir(), 'helparr-test-'));
export const testDbPath = join(testDir, 'helparr.db');

process.env.HELPARR_DB_PATH = testDbPath;
process.env.HELPARR_ENCRYPTION_KEY = 'test-encryption-key-0123456789ab';
process.env.HELPARR_LOG_LEVEL = 'error';

export function cleanupTestDir(): void {
  rmSync(testDir, { recursive: true, force: true });
}
