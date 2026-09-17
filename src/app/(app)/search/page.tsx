import FirstRun from '@/components/FirstRun';
import SearchScreen from '@/components/search/SearchScreen';

/**
 * `?q=` pre-populates the query field and nothing else — the gaps inspector's
 * cross-link lands here with the item already typed, not already searched
 * (FR16). Read server-side rather than with `useSearchParams` so the screen
 * stays a plain client component with no Suspense boundary around it.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  return (
    <FirstRun title="Indexer Search">
      <SearchScreen initialQuery={typeof q === 'string' ? q : ''} />
    </FirstRun>
  );
}
