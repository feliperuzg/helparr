import 'server-only';

/**
 * Credential redaction (REQ-INST-012, REQ-AUTH-007 / NFR1).
 *
 * AC7 asserts that no log line contains an API key at any level. Relying on
 * call sites to remember not to log a credential is the failure mode this
 * module exists to remove: every log goes through `logger`, and `logger`
 * redacts structurally rather than by pattern-matching the message text.
 */

const REDACTED = '[redacted]';

/** Keys whose values are never printable, regardless of nesting depth. */
const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'x-api-key',
  'password',
  'pass',
  'credential',
  'credentials',
  'secret',
  'token',
  'authorization',
  'cookie',
  'set-cookie',
  'sid',
  'sessionid',
  'session_id',
  'encryptionkey',
  'helparr_encryption_key',
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[-\s]/g, ''))
    || SECRET_KEYS.has(key.toLowerCase());
}

/**
 * Values registered here are scrubbed from log output even when they appear in
 * a free-text message rather than a structured field — a URL with an embedded
 * `?apikey=`, an upstream error string that echoes the request back.
 */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  // Short values would cause absurd false positives ("ok", "1") and are not
  // credentials worth protecting anyway.
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function forgetSecret(value: string | null | undefined): void {
  if (value) knownSecrets.delete(value);
}

/** Test seam — the health poller re-registers on every credential change. */
export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

function scrubString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // Credentials embedded in a URL query string or userinfo segment.
  out = out.replace(/([?&](?:apikey|api_key|token|password)=)[^&\s]+/gi, `$1${REDACTED}`);
  out = out.replace(/(\/\/[^/\s:@]+):[^/\s@]+@/g, `$1:${REDACTED}@`);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Headers) {
    const out: Record<string, unknown> = {};
    value.forEach((v, k) => {
      out[k] = isSecretKey(k) ? REDACTED : scrubString(v);
    });
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.HELPARR_LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[configured as Level] ?? LEVELS.info;
}

function emit(level: Level, message: string, context?: unknown): void {
  if (LEVELS[level] < threshold()) return;
  const line: Record<string, unknown> = {
    level,
    msg: scrubString(message),
  };
  if (context !== undefined) line.ctx = redact(context);
  // Single structured line per event — grep-able, and never interpolated with
  // a raw value that bypassed `redact`.
  const serialized = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(serialized);
  else console.log(serialized);
}

export const logger = {
  debug: (message: string, context?: unknown) => emit('debug', message, context),
  info: (message: string, context?: unknown) => emit('info', message, context),
  warn: (message: string, context?: unknown) => emit('warn', message, context),
  error: (message: string, context?: unknown) => emit('error', message, context),
};
