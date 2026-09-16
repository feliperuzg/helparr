'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

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
  // Activity takes `5` and pushes Settings to `6`: the log belongs next to the
  // screens that write to it, not after the configuration screen.
  { to: '/operations', label: 'Activity', icon: 'history', key: '5' },
  { to: '/settings', label: 'Settings', icon: 'settings', key: '6' },
];

/**
 * The width below which the nav stops being a rail and becomes a drawer. Must
 * stay in step with the 860px breakpoint in globals.css §Responsive — the
 * stylesheet decides the layout, this only decides what the menu button means
 * and what the button reports to a screen reader.
 */
const NAV_DRAWER_QUERY = '(max-width: 860px)';

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    // On the server there is no viewport. helparr is a desktop console, so the
    // rail is the honest default for the first paint.
    () => false,
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const drawer = useMediaQuery(NAV_DRAWER_QUERY);

  // Two states rather than one, because the same button is asking for opposite
  // things at the two widths: below the breakpoint the nav is hidden until it
  // is opened, above it the nav is shown until it is collapsed. Collapsing the
  // rail is a preference, so unlike the drawer it survives navigation.
  const [navOpen, setNavOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const navVisible = drawer ? navOpen : !navCollapsed;

  /**
   * Close the mobile drawer on navigation — including a back/forward gesture,
   * which no click handler on the links would catch.
   *
   * Adjusted during render rather than in an effect. The effect form
   * (`useEffect(() => setNavOpen(false), [pathname])`) commits the new route
   * with the drawer still covering it and only then re-renders, which is both a
   * visible flash on a slow device and what `react-hooks/set-state-in-effect`
   * exists to catch. Setting state during render instead makes React discard
   * this pass and re-run with the drawer already closed, before anything
   * reaches the DOM. https://react.dev/reference/react/useState#storing-information-from-previous-renders
   */
  const [renderedAt, setRenderedAt] = useState(pathname);
  if (renderedAt !== pathname) {
    setRenderedAt(pathname);
    setNavOpen(false);
  }

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
    <div className={`shell${navCollapsed ? ' is-nav-collapsed' : ''}`}>
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
          onClick={() => (drawer ? setNavOpen((v) => !v) : setNavCollapsed((v) => !v))}
          aria-label="Toggle navigation"
          aria-expanded={navVisible}
        >
          <Icon name="menu" size={16} />
        </button>
        <span className="topbar__crumb">{current?.label ?? 'helparr'}</span>
        <span className="topbar__spacer" />
        <HealthBadge degraded={degraded} known={health.data !== undefined} total={instances.length} />
        <LogoutButton />
      </header>

      {/* `drawer &&`, not just `navOpen`: the scrim is positioned only inside
          the mobile media query, so widening the window with the drawer open
          would otherwise drop an unstyled div into the shell's grid. */}
      {drawer && navOpen ? <div className="sidebar-scrim" onClick={() => setNavOpen(false)} /> : null}

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
