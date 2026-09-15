import 'server-only';

import { createHmac, randomUUID } from 'node:crypto';

import { getEncryptionKey } from '@/server/crypto';
import type { Credential } from './credential';
import { serializeCredential } from './credential';
import type { InstanceKind } from '@/lib/types';

/**
 * Test-before-save gate (REQ-INST-002 / FR2, AC2).
 *
 * A UI-only "you must test first" flag is not an enforcement mechanism — a
 * direct POST bypasses it. Instead, a successful test issues a token bound to
 * the exact tuple that was tested. Save requires a token whose binding matches
 * what is being saved, so changing the URL or the key after testing
 * invalidates the prior result server-side.
 */

const TOKEN_TTL_MS = 10 * 60_000;

export interface TestBinding {
  kind: InstanceKind;
  baseUrl: string;
  credential: Credential;
}

function fingerprint(binding: TestBinding): string {
  const payload = JSON.stringify({
    kind: binding.kind,
    baseUrl: binding.baseUrl.trim().replace(/\/+$/, ''),
    credential: serializeCredential(binding.credential),
  });
  return createHmac('sha256', `test-token:${getEncryptionKey()}`)
    .update(payload)
    .digest('base64url');
}

interface Issued {
  fingerprint: string;
  expiresAt: number;
}

// In-memory: a token is valid for one editing session, and a restart
// legitimately forces a re-test.
const issued = new Map<string, Issued>();

function prune(): void {
  const now = Date.now();
  for (const [token, entry] of issued) {
    if (entry.expiresAt <= now) issued.delete(token);
  }
}

export function issueTestToken(binding: TestBinding): string {
  prune();
  const token = randomUUID();
  issued.set(token, {
    fingerprint: fingerprint(binding),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

export type TokenVerdict =
  | { valid: true }
  | { valid: false; reason: 'missing' | 'expired' | 'stale' };

export function consumeTestToken(
  token: string | undefined,
  binding: TestBinding,
): TokenVerdict {
  prune();
  if (!token) return { valid: false, reason: 'missing' };

  const entry = issued.get(token);
  if (!entry) return { valid: false, reason: 'expired' };

  if (entry.fingerprint !== fingerprint(binding)) {
    // The operator tested one set of values and submitted another.
    return { valid: false, reason: 'stale' };
  }

  issued.delete(token);
  return { valid: true };
}

export function clearTestTokens(): void {
  issued.clear();
}
