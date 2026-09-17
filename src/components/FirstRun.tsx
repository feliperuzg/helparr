'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';

import Icon, { type IconName } from './Icon';
import { Callout } from './ui';
import { api } from '@/lib/api';
import type { InstanceKind } from '@/lib/types';

/**
 * Guided first run (FR10 / REQ-DEPLOY-013 / AC13, T17).
 *
 * A fresh install lands on five screens that are all correct and all useless:
 * each one has an empty state, but every one of them means "nothing matched",
 * not "you have not connected anything yet". The difference matters, because the
 * second has one fix that repairs all five at once.
 *
 * The zero-instance state needs no new endpoint. The shell already polls
 * `/api/health` every 60s (`AppShell.tsx`), so `instances.length === 0` is
 * already in the query cache under the same key — reading it here is a cache
 * read, not a request.
 */

interface KindCard {
  icon: IconName;
  title: string;
  what: string;
  unlocks: string;
}

/**
 * Three cards, not four. Sonarr and Radarr share one because they answer the
 * same question — "what library tooling do you run" — and an operator with only
 * one of them still gets a working Gaps and Rename screen for that half of their
 * library. There is deliberately no "0 of 3" progress meter: these are options,
 * not a checklist, and Sonarr-only is a legitimate end state this screen has no
 * business asking anyone to justify.
 */
const CARDS: KindCard[] = [
  {
    icon: 'tv',
    title: 'Sonarr / Radarr',
    what: 'Manage your TV and movie library',
    unlocks: "Powers Overview's queue, Gaps and Rename",
  },
  {
    icon: 'search',
    title: 'Prowlarr',
    what: 'Aggregates your indexers',
    unlocks: 'Powers Indexer Search',
  },
  {
    icon: 'down',
    title: 'Download client (qBittorrent)',
    what: 'Optional',
    unlocks: 'Shows transfer progress in Overview',
  },
];

export interface FirstRunProps {
  /** The screen this is standing in for, so the heading still says where you are. */
  title: string;
  children: ReactNode;
}

/**
 * Renders `children` unless there are no instances at all, in which case it
 * renders the guided body in their place.
 *
 * Children are held back rather than rendered underneath: on a fresh install
 * every screen behind this would otherwise mount its own queries and poll
 * upstreams that do not exist yet.
 *
 * While health is still unknown the children render as usual. Waiting instead
 * would put a health round trip in front of every screen's first paint for every
 * configured install, to spare a single flash on an install that has this screen
 * exactly once.
 */
export default function FirstRun({ title, children }: FirstRunProps) {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });

  if (health.data === undefined || health.data.instances.length > 0) {
    return <>{children}</>;
  }

  return (
    <main className="main" id="main" tabIndex={-1}>
      <div className="content">
        <div className="content__scroll">
          <div className="firstrun">
            <h1 className="firstrun__title">Welcome to helparr</h1>
            <p className="firstrun__lede">
              helparr is a control surface over your Sonarr, Radarr and Prowlarr — it has
              nothing to read or write until it can reach at least one of them.
            </p>

            <ul className="firstrun__cards">
              {CARDS.map((card) => (
                <li key={card.title} className="firstrun__card">
                  <span className="firstrun__icon" aria-hidden="true">
                    <Icon name={card.icon} size={15} />
                  </span>
                  <span className="firstrun__copy">
                    <span className="firstrun__name">{card.title}</span>
                    <span className="firstrun__what">{card.what}</span>
                    <span className="firstrun__unlocks">{card.unlocks}</span>
                  </span>
                  <span className="firstrun__state subtle">not added</span>
                </li>
              ))}
            </ul>

            <p className="firstrun__note subtle">
              There is no required order — add whichever of these you already have running.
            </p>

            <Link className="btn btn-primary" href="/settings?add=1">
              Add your first instance
              <Icon name="arrowRight" size={12} />
            </Link>
          </div>
        </div>
      </div>
      {/* The heading above is the screen's own h1, so `title` is not drawn twice.
          It is still worth carrying: a screen reader announcing the region wants
          to know which screen was taken over. */}
      <span className="sr-only">{title}</span>
    </main>
  );
}

/* ── The softer, later nudge ─────────────────────────────────────────────── */

const DISMISS_KEY = 'helparr.setup-nudge-dismissed';

/** The kinds worth naming. The download client is optional, so it is not chased. */
const CORE: Array<{ kind: InstanceKind; unlocks: string }> = [
  { kind: 'sonarr', unlocks: 'to also see TV gaps and renames' },
  { kind: 'radarr', unlocks: 'to also see movie gaps and renames' },
  { kind: 'prowlarr', unlocks: 'to unlock Indexer Search' },
];

const LABEL: Record<InstanceKind, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  prowlarr: 'Prowlarr',
  'download-client': 'a download client',
};

function subscribeToDismissal(onChange: () => void) {
  window.addEventListener('helparr:setup-nudge', onChange);
  return () => window.removeEventListener('helparr:setup-nudge', onChange);
}

function useDismissed(): [boolean, () => void] {
  const dismissed = useSyncExternalStore(
    subscribeToDismissal,
    () => window.localStorage.getItem(DISMISS_KEY) === '1',
    // No storage on the server, and the honest first-paint answer is "not
    // dismissed" — a banner that appears is recoverable, one that never does
    // because the server guessed is not.
    () => false,
  );

  const dismiss = useCallback(() => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    window.dispatchEvent(new Event('helparr:setup-nudge'));
  }, []);

  return [dismissed, dismiss];
}

/**
 * Shown on Overview only, once at least one instance exists.
 *
 * Every other screen now has real, screen-specific work to show or a real,
 * screen-specific reason it cannot — Search's "Prowlarr unavailable" callout
 * already covers its own half. Repeating one generic nudge across all five would
 * be the empty-screens problem's mirror image: noise instead of silence.
 *
 * `Dismiss` is a dismissal, not a snooze. It does not return on its own. If
 * every instance is later removed, `FirstRun` above takes the screen over
 * entirely — a stronger state, over which this banner's dismissal has no say.
 */
export function SetupNudge() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
  const [dismissed, dismiss] = useDismissed();

  const instances = health.data?.instances ?? [];
  const missing = CORE.filter((c) => !instances.some((i) => i.kind === c.kind));

  if (dismissed || instances.length === 0 || missing.length === 0) return null;

  return (
    <div className="firstrun__nudge">
      <Callout>
        <span className="firstrun__nudge-copy">
          Setup isn&apos;t finished. Add{' '}
          {missing.map((entry, index) => (
            <span key={entry.kind}>
              {index === 0 ? '' : index === missing.length - 1 ? ', or ' : ', '}
              {LABEL[entry.kind]} {entry.unlocks}
            </span>
          ))}
          .
        </span>
        <span className="firstrun__nudge-actions">
          <Link className="btn btn-ghost btn-sm" href="/settings">Settings</Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>Dismiss</button>
        </span>
      </Callout>
    </div>
  );
}
