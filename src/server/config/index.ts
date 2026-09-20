import 'server-only';

import { resolve } from 'node:path';

import { z } from 'zod';

import { MIN_OPERATOR_PASSWORD_LENGTH } from '@/lib/types';

/**
 * The single place helparr reads its environment (REQ-DEPLOY-008 / NFR2).
 *
 * Before this module, four unrelated files each reached into `process.env` and
 * coerced one variable their own way. None of them could fail at startup,
 * because none of them ran at startup: a typo in `HELPARR_LOG_LEVEL` surfaced
 * as a silently wrong log level, and a typo in `HELPARR_QUEUE_REFRESH_SECONDS`
 * as a silently ignored setting. An operator has no way to tell "accepted" from
 * "ignored" when the program never says.
 *
 * So every variable is declared here, parsed once, and reported together —
 * *together* being the point. Fixing one misconfiguration per restart is how a
 * five-minute install becomes a half-hour one, so `ConfigError` lists every
 * problem it found, each naming the variable, what was expected, and what was
 * actually there.
 *
 * What this module deliberately does NOT do is resolve the encryption key. It
 * validates that the key variables are *consistent* — a configuration concern —
 * and leaves the material itself to `@/server/crypto`, which owns its
 * validation and its redaction. `instance-connections` ADR-2 put the key in one
 * module and this change is not moving it.
 *
 * Parsing is lazy for the same reason the database handle is: `next build`
 * imports server modules to collect their metadata, and a build machine has
 * neither a key nor a volume.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_DB_PATH = './data/helparr.db';
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_QUEUE_REFRESH_SECONDS = 30;
export const MIN_QUEUE_REFRESH_SECONDS = 5;
/**
 * Re-exported rather than redeclared. The browser-side change-password form
 * needs the same number and cannot import a `server-only` module, so the value
 * itself lives in `@/lib/types` and every consumer sees one rule (ADR-7).
 */
export const MIN_INITIAL_PASSWORD_LENGTH = MIN_OPERATOR_PASSWORD_LENGTH;

/** Where the encryption key is expected to come from. Resolved by `@/server/crypto`. */
export type EncryptionKeySource = 'env' | 'file' | 'none';

export interface RuntimeConfig {
  /** Absolute path to the database file. Its directory holds the -wal and -shm sidecars. */
  databasePath: string;
  logLevel: LogLevel;
  queueRefreshSeconds: number;
  /** '' when helparr is served from the root. Never has a trailing slash. */
  basePath: string;
  /** First-run bootstrap only; ignored once an operator password exists. */
  initialPassword: string | null;
  /**
   * Deliberate recovery from a forgotten password: lets `initialPassword` win
   * once more, at the next start. Separate from `initialPassword` on purpose —
   * the bootstrap value alone must never be able to undo a rotation.
   */
  passwordReset: boolean;
  encryptionKeySource: EncryptionKeySource;
  encryptionKeyFilePath: string | null;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const list = problems.map((p) => `  - ${p}`).join('\n');
    super(`helparr cannot start with this configuration:\n${list}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const optionalText = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value === '' ? undefined : value))
  .optional();

/**
 * Every variable is optional at this layer. Absence is a valid configuration
 * for all of them — including the key, whose *presence* is a startup
 * requirement rather than a parsing one (see `assertStartupConfig`).
 */
const schema = z
  .object({
    HELPARR_DB_PATH: optionalText,
    HELPARR_ENCRYPTION_KEY: z.string().optional(),
    HELPARR_ENCRYPTION_KEY_FILE: optionalText,
    HELPARR_INITIAL_PASSWORD: z.string().optional(),
    HELPARR_PASSWORD_RESET: optionalText,
    HELPARR_LOG_LEVEL: optionalText,
    HELPARR_QUEUE_REFRESH_SECONDS: optionalText,
    HELPARR_BASE_PATH: optionalText,
  })
  .passthrough();

function parseLogLevel(raw: string | undefined, problems: string[]): LogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  const lowered = raw.toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(lowered)) return lowered as LogLevel;
  problems.push(
    `HELPARR_LOG_LEVEL is "${raw}"; expected one of ${LOG_LEVELS.join(', ')}`,
  );
  return DEFAULT_LOG_LEVEL;
}

function parseRefreshSeconds(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_QUEUE_REFRESH_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(
      `HELPARR_QUEUE_REFRESH_SECONDS is "${raw}"; expected a number of seconds`,
    );
    return DEFAULT_QUEUE_REFRESH_SECONDS;
  }
  if (value < MIN_QUEUE_REFRESH_SECONDS) {
    // Below the floor the reads cost the instance more than the freshness is
    // worth (NFR1). Previously this silently fell back to the default, which
    // meant an operator who asked for 1s got 30s and was never told.
    problems.push(
      `HELPARR_QUEUE_REFRESH_SECONDS is ${value}; the minimum is ${MIN_QUEUE_REFRESH_SECONDS}`,
    );
    return DEFAULT_QUEUE_REFRESH_SECONDS;
  }
  return Math.round(value);
}

function parseBasePath(raw: string | undefined, problems: string[]): string {
  if (raw === undefined) return '';
  if (!raw.startsWith('/')) {
    problems.push(`HELPARR_BASE_PATH is "${raw}"; it must begin with "/" (for example "/helparr")`);
    return '';
  }
  if (raw !== '/' && raw.endsWith('/')) {
    problems.push(`HELPARR_BASE_PATH is "${raw}"; it must not end with "/"`);
    return '';
  }
  // "/" and "" mean the same thing to Next, and normalising here means the
  // compiled-vs-runtime comparison in `assertBasePathMatches` cannot report a
  // mismatch that is purely cosmetic.
  return raw === '/' ? '' : raw;
}

function parseInitialPassword(raw: string | undefined, problems: string[]): string | null {
  if (raw === undefined || raw === '') return null;
  if (raw.length < MIN_INITIAL_PASSWORD_LENGTH) {
    problems.push(
      `HELPARR_INITIAL_PASSWORD is ${raw.length} characters; at least `
      + `${MIN_INITIAL_PASSWORD_LENGTH} are required. The value itself is never logged.`,
    );
    return null;
  }
  return raw;
}

const TRUTHY = ['1', 'true', 'yes', 'on'];
const FALSY = ['0', 'false', 'no', 'off'];

/**
 * The recovery flag is strict about its values rather than treating any
 * non-empty string as true. `HELPARR_PASSWORD_RESET=false` reads as an
 * instruction *not* to reset in every other tool an operator uses, and the one
 * place that must not surprise them is the one that overwrites their password.
 */
function parsePasswordReset(raw: string | undefined, problems: string[]): boolean {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  if (TRUTHY.includes(lowered)) return true;
  if (FALSY.includes(lowered)) return false;
  problems.push(
    `HELPARR_PASSWORD_RESET is "${raw}"; expected one of ${[...TRUTHY, ...FALSY].join(', ')}`,
  );
  return false;
}

function parseKeySource(
  key: string | undefined,
  keyFile: string | undefined,
  problems: string[],
): { source: EncryptionKeySource; filePath: string | null } {
  const hasKey = key !== undefined && key.trim() !== '';
  const hasFile = keyFile !== undefined;

  if (hasKey && hasFile) {
    // Refused rather than resolved by precedence. A silent winner between two
    // secrets is how an operator ends up encrypting against a key they did not
    // think they were using — and finds out when the other one stops working.
    problems.push(
      'HELPARR_ENCRYPTION_KEY and HELPARR_ENCRYPTION_KEY_FILE are both set; '
      + 'set exactly one so it is unambiguous which key is in use',
    );
    return { source: 'none', filePath: null };
  }
  if (hasKey) return { source: 'env', filePath: null };
  if (hasFile) return { source: 'file', filePath: keyFile };
  return { source: 'none', filePath: null };
}

function build(env: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Reaching here means a variable was not even a string — effectively
    // impossible for `process.env`, but the branch is cheap and the alternative
    // is a thrown ZodError with no variable name in it.
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const problems: string[] = [];

  const { source, filePath } = parseKeySource(
    raw.HELPARR_ENCRYPTION_KEY,
    raw.HELPARR_ENCRYPTION_KEY_FILE,
    problems,
  );

  const config: RuntimeConfig = {
    // `turbopackIgnore` for the same reason `getDatabasePath` carries it: a
    // `resolve` of a non-literal makes Turbopack trace the whole project into
    // the standalone output.
    databasePath: resolve(
      /* turbopackIgnore: true */ raw.HELPARR_DB_PATH ?? DEFAULT_DB_PATH,
    ),
    logLevel: parseLogLevel(raw.HELPARR_LOG_LEVEL, problems),
    queueRefreshSeconds: parseRefreshSeconds(raw.HELPARR_QUEUE_REFRESH_SECONDS, problems),
    basePath: parseBasePath(raw.HELPARR_BASE_PATH, problems),
    initialPassword: parseInitialPassword(raw.HELPARR_INITIAL_PASSWORD, problems),
    passwordReset: parsePasswordReset(raw.HELPARR_PASSWORD_RESET, problems),
    encryptionKeySource: source,
    encryptionKeyFilePath: filePath,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * The base path this artifact was built with (ADR-1, REQ-DEPLOY-007 / FR7).
 *
 * `basePath` is compiled into the server, the client bundles and every asset
 * URL. It cannot be read from the environment at runtime — the direct question
 * of whether it could be made dynamic has been answered "no" — so an operator
 * who sets `HELPARR_BASE_PATH` against a build that did not have it gets an
 * application that starts, answers, and 404s every stylesheet. That failure is
 * indistinguishable from a broken install and it is the reason this check
 * exists: helparr refuses to run rather than run subtly wrong.
 */
export function assertBasePathMatches(): void {
  // Substituted at build time by `next.config.mjs`, so this is the compiled
  // value rather than a second reading of the environment.
  const compiled = process.env.HELPARR_COMPILED_BASE_PATH ?? '';
  const configured = getConfig().basePath;

  if (compiled === configured) return;

  throw new ConfigError([
    `HELPARR_BASE_PATH is "${configured || '(root)'}" but this build was compiled `
    + `for "${compiled || '(root)'}". A base path is baked into the build and cannot `
    + 'be changed at startup: either unset the variable to match this artifact, or '
    + 'rebuild with HELPARR_BASE_PATH set to the path you want.',
  ]);
}

let cached: RuntimeConfig | null = null;

/**
 * The validated configuration. Throws `ConfigError` listing every problem it
 * found. Cached for the process lifetime — the environment does not change
 * under a running process, and re-reading it per request would mean a
 * configuration that drifts from the one validated at startup.
 */
export function getConfig(): RuntimeConfig {
  if (cached !== null) return cached;
  cached = build(process.env);
  return cached;
}

/** Test seam — the configuration is read once in production. */
export function resetConfigCache(): void {
  cached = null;
}
