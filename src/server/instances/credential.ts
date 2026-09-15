import 'server-only';

import { z } from 'zod';

/**
 * Credential blob (ADR-5, resolved in planning OQ-5).
 *
 * The *arr apps take a stateless `X-Api-Key`; qBittorrent takes a
 * username/password form login. Storing both in one nullable string column
 * would mean a delimiter convention or a second nullable column, and every
 * consumer would have to remember which one applies. A discriminated union
 * makes client dispatch total: an unhandled `type` is a compile error rather
 * than a runtime null.
 */

export const credentialSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api-key'), apiKey: z.string().min(1) }),
  z.object({
    type: z.literal('userpass'),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
]);

export type Credential = z.infer<typeof credentialSchema>;

export function serializeCredential(credential: Credential): string {
  return JSON.stringify(credential);
}

export function parseCredential(raw: string): Credential {
  return credentialSchema.parse(JSON.parse(raw));
}

/**
 * The only form of a credential allowed to cross the trust boundary. Shows
 * enough for the operator to tell two keys apart without being reversible.
 */
export function credentialHint(credential: Credential): string {
  if (credential.type === 'api-key') {
    const tail = credential.apiKey.slice(-4);
    return `${'•'.repeat(8)}${tail}`;
  }
  return `${credential.username} · ${'•'.repeat(8)}`;
}

/** Every secret in a credential, for registration with the log redactor. */
export function credentialSecrets(credential: Credential): string[] {
  return credential.type === 'api-key'
    ? [credential.apiKey]
    : [credential.password];
}
