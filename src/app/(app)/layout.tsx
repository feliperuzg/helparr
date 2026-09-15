import type { ReactNode } from 'react';

import AppShell from '@/components/AppShell';

/**
 * Everything in this route group is behind the session cookie. `middleware.ts`
 * bounces an unauthenticated request before it gets here; each route handler
 * re-checks the session itself, because middleware presence is not authorization
 * (ADR-3 / design/sequence-login.md).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
