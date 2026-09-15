import type { Metadata } from 'next';

import QueueScreen from '@/components/queue/QueueScreen';
import { DEFAULT_REFRESH_MS } from '@/components/queue/useQueue';

export const metadata: Metadata = { title: 'Overview · helparr' };

// The interval is read at request time, not at build time. A `NEXT_PUBLIC_*`
// variable would be inlined into the bundle, which bakes one operator's choice
// into the published image — exactly wrong for a self-hosted app that ships as
// a container someone else configures (ADR-2).
export const dynamic = 'force-dynamic';

function refreshMs(): number {
  const raw = Number(process.env.HELPARR_QUEUE_REFRESH_SECONDS);
  // A misconfigured value falls back rather than polling every 0ms. Five seconds
  // is the floor: below that the reads cost the instance more than the freshness
  // is worth (NFR1).
  if (!Number.isFinite(raw) || raw < 5) return DEFAULT_REFRESH_MS;
  return Math.round(raw) * 1_000;
}

export default function OverviewPage() {
  return <QueueScreen refreshMs={refreshMs()} />;
}
