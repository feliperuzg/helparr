import type { Metadata } from 'next';

import SettingsScreen from '@/components/settings/SettingsScreen';

export const metadata: Metadata = { title: 'Settings · helparr' };

export default function SettingsPage() {
  return <SettingsScreen />;
}
