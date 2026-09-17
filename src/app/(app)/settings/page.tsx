import type { Metadata } from 'next';

import SettingsScreen from '@/components/settings/SettingsScreen';

export const metadata: Metadata = { title: 'Settings · helparr' };

/**
 * `?add=1` opens the add form on arrival — the landing point for the guided
 * first run's call to action (T17), so a fresh install reaches the form in one
 * click instead of two. Read server-side rather than with `useSearchParams`, the
 * same way `/search?q=` is, so the screen stays a plain client component with no
 * Suspense boundary around it.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string | string[] }>;
}) {
  const { add } = await searchParams;
  return <SettingsScreen initiallyAdding={add === '1'} />;
}
