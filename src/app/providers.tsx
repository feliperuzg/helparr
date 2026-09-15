'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiError } from '@/lib/api';

/**
 * One QueryClient per browser session, created inside state so React's strict
 * double-render in development does not spawn a second cache (ADR-7).
 */
export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The health endpoint already reports per-instance failure as a
            // 200 payload, so a retry here would only ever hammer helparr
            // itself. A 401 must not be retried at all — it redirects.
            retry: (failureCount, error) =>
              !(error instanceof ApiError) && failureCount < 2,
            refetchOnWindowFocus: false,
            staleTime: 10_000,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
