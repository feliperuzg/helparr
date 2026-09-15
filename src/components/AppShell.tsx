'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import Icon, { type IconName } from './Icon';
import { StatusDot } from './ui';
import { api } from '@/lib/api';
import { STATUS_LABEL, STATUS_TONE } from '@/lib/status';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  key: string;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: 'gauge', key: '1', end: true },
  { to: '/search', label: 'Search', icon: 'search', key: '2' },
  { to: '/gaps', label: 'Gaps', icon: 'gap', key: '3' },
  { to: '/rename', label: 'Rename', icon: 'rename', key: '4' },
  { to: '/settings', label: 'Settings', icon: 'settings', key: '5' },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile drawer on navigation.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  // Digit shortcuts for screen switching — ignored while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (
        el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
      );
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = NAV.find((n) => n.key === e.key);
      if (hit) { e.preventDefault(); router.push(hit.to); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  /**
   * FR10 / AC10: the shell polls health on a fixed interval and keeps rendering
   * whatever it last knew. A failing poll never blanks the shell, and a degraded
   * instance never blocks a screen that does not depend on it — the badge is the
   * only thing that changes.
   */
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    // Keeps the previously rendered states on screen while a refetch is in
    // flight, so the sidebar does not flicker every minute.
    placeholderData: (previous) => previous,
  });

  const instances = health.data?.instances ?? [];
  const degraded = health.data?.degradedCount ?? 0;
  const current = NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)));

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>

      <div className="brand">
        <span className="brand__mark" aria-hidden="true"><Icon name="plug" size={13} /></span>
        <span className="brand__name">helparr</span>
        <span className="brand__version">0.1.0</span>
      </div>

      <header className="topbar">
        <button
          type="button"
          className="icon-btn topbar__menu"
          onClick={() => setNavOpen((v) => !v)}
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
        >
          <Icon name="menu" size={16} />
        </button>
        <span className="topbar__crumb">{current?.label ?? 'helparr'}</span>
        <span className="topbar__spacer" />
        <HealthBadge degraded={degraded} known={health.data !== undefined} total={instances.length} />
        <LogoutButton />
      </header>

      {navOpen ? <div className="sidebar-scrim" onClick={() => setNavOpen(false)} /> : null}

      <nav className={`sidebar${navOpen ? ' is-open' : ''}`} aria-label="Primary">
        <div className="sidebar__section">
          {NAV.map((item) => {
            const active = item.end ? pathname === item.to : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                href={item.to}
                className={`navlink${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <Icon name={item.icon} size={14} />
                <span>{item.label}</span>
                <kbd className="navlink__key">{item.key}</kbd>
              </Link>
            );
          })}
        </div>

        <div className="sidebar__spacer" />

        <div className="sidebar__section">
          <div className="sidebar__label" id="instances-label">Instances</div>
          {instances.length === 0 ? (
            <p className="subtle" style={{ padding: '0 var(--space-2)', fontSize: 12 }}>
              {health.isPending ? 'Checking…' : 'None configured yet.'}
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-labelledby="instances-label">
              {instances.map((inst) => (
                <li key={inst.instanceId}>
                  <Link href="/settings" className="instance">
                    <StatusDot
                      tone={STATUS_TONE[inst.state]}
                      pulse={inst.state === 'ok'}
                      label={`${inst.label}: ${STATUS_LABEL[inst.state]}`}
                    />
                    <span style={{ minWidth: 0 }}>
                      <span className="instance__name truncate" style={{ display: 'block' }}>{inst.label}</span>
                      <span className="instance__meta truncate" style={{ display: 'block' }}>
                        {STATUS_LABEL[inst.state]}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>

      {children}
    </div>
  );
}

function HealthBadge({ degraded, known, total }: { degraded: number; known: boolean; total: number }) {
  if (!known) {
    return <span className="badge badge-idle"><Icon name="clock" size={11} />checking instances</span>;
  }
  if (total === 0) {
    return (
      <Link href="/settings" className="badge badge-idle" style={{ textDecoration: 'none' }}>
        <Icon name="plug" size={11} />no instances yet
      </Link>
    );
  }
  if (degraded === 0) {
    return <span className="badge badge-ok"><Icon name="check" size={11} />all instances healthy</span>;
  }
  return (
    <Link href="/settings" className="badge badge-warn" style={{ textDecoration: 'none' }}>
      <Icon name="alert" size={11} />
      {degraded} instance{degraded === 1 ? '' : 's'} degraded
    </Link>
  );
}

function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api.logout();
    } finally {
      // Even if revocation errored, get the operator off the authenticated
      // surface rather than leaving them on a screen that will 401 anyway.
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <button type="button" className="icon-btn" onClick={signOut} disabled={busy} aria-label="Sign out">
      <Icon name="logout" size={14} />
    </button>
  );
}
