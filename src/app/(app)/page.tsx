import type { Metadata } from 'next';

import QueueScreen from '@/components/queue/QueueScreen';
import { getConfig } from '@/server/config';

export const metadata: Metadata = { title: 'Overview · helparr' };

// The interval is read at request time, not at build time. A `NEXT_PUBLIC_*`
// variable would be inlined into the bundle, which bakes one operator's choice
// into the published image — exactly wrong for a self-hosted app that ships as
// a container someone else configures (ADR-2).
export const dynamic = 'force-dynamic';

export default function OverviewPage() {
  // Validated at startup, including the five-second floor. This page used to do
  // its own coercion and fall back silently on a bad value; now a bad value
  // never reaches a request, because the process refuses to start with one.
  return <QueueScreen refreshMs={getConfig().queueRefreshSeconds * 1_000} />;
}
