import 'server-only';

import type { ArrCommandStatus, ClientResult } from '@/server/clients/types';

/**
 * Shared by rename apply (ADR-7) and force-import apply: polling an *arr
 * command to completion.
 *
 * Typed against a minimal structural interface rather than `RenameClient` so
 * that any client capable of reporting command status — including an
 * import-capable one — can reuse it without carrying the whole rename
 * surface.
 */
export interface CommandStatusSource {
  commandStatus(commandId: number, signal?: AbortSignal): Promise<ClientResult<ArrCommandStatus>>;
}

/** How long a command is waited on before outcomes are verified. */
export const COMMAND_DEADLINE_MS = 10 * 60 * 1000;
export const COMMAND_POLL_MS = 1_000;

export interface CommandResult {
  /** Non-null when the command itself never completed. */
  failure: string | null;
  /**
   * The instance's own note about the completed command.
   *
   * Worth carrying even on success, because it is the only place the upstream
   * admits to doing nothing: a Sonarr that renamed zero files still reports
   * `completed` / `successful`, and says so only here — measured verbatim as
   * `0 selected episode files renamed for <title>` on 2026-09-17.
   */
  message: string | null;
}

/**
 * `noun` names the command in the two failure sentences the operator reads —
 * "rename" by default so rename's copy is unchanged, "import" for force import.
 */
export async function awaitCommand(
  client: CommandStatusSource,
  commandId: number,
  noun = 'rename',
): Promise<CommandResult> {
  const deadline = Date.now() + COMMAND_DEADLINE_MS;
  while (Date.now() < deadline) {
    const status = await client.commandStatus(commandId);
    if (!status.ok) return { failure: status.error.reason, message: null };
    if (status.value.state === 'completed') {
      return { failure: null, message: status.value.message };
    }
    if (status.value.state === 'failed') {
      return {
        failure: status.value.message ?? `The instance reported the ${noun} command failed.`,
        message: status.value.message,
      };
    }
    await new Promise((done) => setTimeout(done, COMMAND_POLL_MS));
  }
  return {
    failure: `The ${noun} command did not finish in time. Check the instance before retrying.`,
    message: null,
  };
}
