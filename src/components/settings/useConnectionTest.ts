'use client';

import { useCallback, useRef, useState } from 'react';

import { api, ApiError, type CredentialInput } from '@/lib/api';
import { KIND_LABEL, type InstanceKind, type TestOutcome } from '@/lib/types';
import type { Tone } from '@/components/ui';

export interface TestResult {
  tone: Tone;
  text: string;
  ok: boolean;
}

/**
 * The connection test is deliberately non-optimistic: `result` stays null until
 * the round-trip resolves, and a successful test hands back the token the save
 * endpoint demands (FR2 / AC2). Any edit to the tested values clears both, so
 * the UI can never offer a Save backed by a stale test.
 */
export function useConnectionTest(kind: InstanceKind) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const seq = useRef(0);

  const clear = useCallback(() => {
    seq.current += 1; // invalidates any test still in flight
    setResult(null);
    setToken(null);
  }, []);

  const run = useCallback(
    async (baseUrl: string, credential: CredentialInput): Promise<TestResult> => {
      seq.current += 1;
      const ticket = seq.current;
      setPending(true);
      setResult(null);
      setToken(null);

      let outcome: TestResult;
      try {
        const response = await api.testConnection({ kind, baseUrl, credential });
        outcome = describe(kind, response);
        if (ticket === seq.current && response.outcome === 'ok') setToken(response.testToken);
      } catch (error) {
        outcome = {
          tone: 'error',
          ok: false,
          text: error instanceof ApiError ? error.message : 'The test could not be run.',
        };
      }

      // A superseded test must not overwrite a newer one's verdict.
      if (ticket === seq.current) {
        setPending(false);
        setResult(outcome);
      }
      return outcome;
    },
    [kind],
  );

  return { pending, result, token, run, clear };
}

function describe(kind: InstanceKind, outcome: TestOutcome): TestResult {
  switch (outcome.outcome) {
    case 'ok':
      return {
        tone: 'ok',
        ok: true,
        text: `${KIND_LABEL[kind]} ${outcome.version} responded in ${outcome.latencyMs} ms`,
      };
    case 'unauthorized':
      return { tone: 'error', ok: false, text: outcome.reason };
    case 'unreachable':
      return { tone: 'error', ok: false, text: outcome.reason };
    case 'unexpected-response':
      return { tone: 'warn', ok: false, text: outcome.reason };
  }
}
