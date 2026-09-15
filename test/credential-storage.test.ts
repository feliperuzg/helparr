import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupTestDir, testDbPath } from './helpers/env';
import { closeDb } from '@/server/db';
import { createInstance, getInstance, listInstances } from '@/server/instances/registry';

const API_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const QBIT_PASSWORD = 'correct-horse-battery-staple';

/**
 * AC5 / AC6 — credentials are encrypted at rest and never cross the boundary.
 */
describe('credential storage', () => {
  afterAll(() => {
    closeDb();
    cleanupTestDir();
  });

  it('never returns a credential in an instance DTO', () => {
    const created = createInstance({
      kind: 'sonarr', label: 'Sonarr', baseUrl: 'http://127.0.0.1:8989',
      credential: { type: 'api-key', apiKey: API_KEY },
    });

    // Not "the field is undefined" — the field does not exist. A DTO that
    // cannot describe a credential cannot leak one through a careless spread.
    expect(created).not.toHaveProperty('credential');
    expect(created).not.toHaveProperty('apiKey');
    expect(JSON.stringify(created)).not.toContain(API_KEY);

    expect(created.credentialType).toBe('api-key');
    expect(created.credentialHint).toBe('••••••••8f90');

    const fetched = getInstance(created.id)!;
    expect(JSON.stringify(fetched)).not.toContain(API_KEY);
    expect(JSON.stringify(listInstances())).not.toContain(API_KEY);
  });

  it('masks a download-client password down to the username alone', () => {
    const created = createInstance({
      kind: 'download-client', label: 'qBittorrent', baseUrl: 'http://127.0.0.1:8080',
      credential: { type: 'userpass', username: 'admin', password: QBIT_PASSWORD },
    });

    expect(created.credentialHint).toBe('admin · ••••••••');
    expect(JSON.stringify(created)).not.toContain(QBIT_PASSWORD);
  });

  it('writes an encrypted database that holds no plaintext credential', () => {
    closeDb();
    const raw = readFileSync(testDbPath);

    // A cleartext SQLite file starts with this magic string; an encrypted one
    // has a randomised first page.
    expect(raw.subarray(0, 15).toString('utf8')).not.toBe('SQLite format 3');

    const asText = raw.toString('latin1');
    expect(asText).not.toContain(API_KEY);
    expect(asText).not.toContain(QBIT_PASSWORD);
  });

  it('refuses to open the database without the encryption key', () => {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3-multiple-ciphers');

    expect(() => {
      const db = new Database(testDbPath, { readonly: true });
      try {
        db.prepare('SELECT count(*) FROM sqlite_master').get();
      } finally {
        db.close();
      }
    }).toThrow(/not a database|file is encrypted/i);
  });
});
