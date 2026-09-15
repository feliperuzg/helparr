import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import Providers from './providers';
import './globals.css';

/**
 * Fonts are self-hosted by next/font rather than pulled from Google at runtime.
 * helparr is a LAN-first app that may have no outbound internet at all — a
 * runtime <link> to fonts.googleapis.com would stall first paint on exactly the
 * networks this is built for.
 */
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'helparr',
  description: 'A companion console for Sonarr, Radarr, Prowlarr and your download client.',
};

export const viewport: Viewport = {
  themeColor: '#0F172A',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      style={{
        // Overrides the raw font primitives in globals.css with the hashed
        // self-hosted families, keeping every downstream reference on the
        // --font-heading / --font-body tokens.
        '--font-heading': mono.style.fontFamily,
        '--font-body': sans.style.fontFamily,
      } as React.CSSProperties}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
