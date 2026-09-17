'use client';

import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { RenameTitlesRead } from '@/lib/types';

/**
 * The scope picker's title source (T10, FR1).
 *
 * FR1 wants a *set* of titles across instances, so the picker needs a list of
 * every series and film helparr could rename. That is `GET /api/rename/titles`
 * — deliberately not the gaps read, which returns monitored items with *no*
 * file and is therefore the exact complement of what a rename targets.
 *
 * Selecting titles here reaches no instance: this read is the only upstream
 * traffic the picker causes, and it is a library listing. The first call that
 * touches a title is the rescan the build starts.
 */

export const RENAME_TITLES_KEY = ['rename-titles'] as const;

export function useRenameTitles() {
  return useQuery<RenameTitlesRead>({
    queryKey: RENAME_TITLES_KEY,
    queryFn: ({ signal }) => api.renameTitles(signal),
    // A library listing is a library-scale read of every instance, so it is
    // cached for the length of a sitting and refreshed on demand — the same
    // rule the gaps screen follows, and for the same reason.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
