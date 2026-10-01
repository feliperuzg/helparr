import FirstRun from '@/components/FirstRun';
import ImportScreen from '@/components/import/ImportScreen';

export const metadata = {
  title: 'Force import — helparr',
  description: 'Review the candidates the instance resolved before a single file is imported.',
};

/**
 * Force import (T17; ADR-3, REQ-QUEUE-021/022).
 *
 * Reached only from the queue inspector — there is no nav entry, because there
 * is no valid way to start here without a record in mind
 * (`wireframes/components.md`, "No left-nav entry for Force Import").
 *
 * Two entry shapes, both read server-side for the same reason `/search` reads
 * `?q=`: the screen stays a plain client component with no Suspense boundary.
 *
 * - `?instanceId=<id>&recordId=<n>` — the inspector's link. The screen builds a
 *   plan from it and then swaps the URL for the next shape.
 * - `?plan=<id>` — a plan that already exists. A reload lands here and resumes
 *   the same plan (including one that is mid-import) instead of quietly reading
 *   a second candidate set.
 */
export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{
    instanceId?: string | string[];
    recordId?: string | string[];
    plan?: string | string[];
  }>;
}) {
  const { instanceId, recordId, plan } = await searchParams;

  const parsedRecord = typeof recordId === 'string' && /^\d+$/.test(recordId)
    ? Number(recordId)
    : null;

  return (
    <FirstRun title="Force import">
      <ImportScreen
        initialInstanceId={typeof instanceId === 'string' && instanceId !== '' ? instanceId : null}
        initialRecordId={parsedRecord !== null && parsedRecord > 0 ? parsedRecord : null}
        initialPlanId={typeof plan === 'string' && plan !== '' ? plan : null}
      />
    </FirstRun>
  );
}
