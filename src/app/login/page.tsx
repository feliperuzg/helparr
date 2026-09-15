import type { Metadata } from 'next';
import { Suspense } from 'react';

import LoginScreen from '@/components/LoginScreen';

export const metadata: Metadata = { title: 'Sign in · helparr' };

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to keep the rest of the page
  // static-renderable.
  return (
    <Suspense fallback={null}>
      <LoginScreen />
    </Suspense>
  );
}
