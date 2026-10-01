'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent,
  type RefObject,
} from 'react';

import Icon from '@/components/Icon';
import { useUnmapped } from '@/components/unmapped/useUnmapped';
import { useListKeyboard } from '@/components/useListKeyboard';
import { Callout, EmptyState, KeyboardHints, ScreenHead, SearchField } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { formatAge, formatBytes } from '@/lib/queue';
import type { UnmappedFolderRow, UnmappedInstance, UnmappedRoot } from '@/lib/unmapped';

/**
 * The unmapped-folders screen (REQ-GAPS-022..026, ADR-9; T21).
 *
 * The inverse of Gaps — a folder on disk that no instance is monitoring — laid
 * out the way the data is owned: instance → root folder → folder. Three
 * decisions live here and nowhere else:
 *
 * 1. **Unknown is never none.** A root folder whose response omitted
 *    `unmappedFolders` and one that reported an empty set are different
 *    outcomes, and they differ on three channels at once — glyph, wording and
 *    tone — so that no single one carries the distinction alone (REQ-GAPS-023).
 *    The "nothing unmapped" empty state is reachable only when *every* root on
 *    *every* instance confirmed zero; one unknown root, or one unreadable
 *    instance, and the groups render instead.
 * 2. **Read-only by construction.** No selection, no bulk bar, no inspector
 *    with write actions. The only control on a folder row is a link into
 *    helparr's own `/search` (REQ-GAPS-024, -025). Retry and Refresh re-read;
 *    neither touches an instance's state.
 * 3. **A down instance costs only itself.** It is named in a banner and in
 *    its own place in the hierarchy, and every instance that answered still
 *    renders (REQ-GAPS-026).
 *
 * Not virtualized, unlike GapsGrid: the read is root-folder scale, not library
 * scale, and keeping it as plain markup is what lets the hierarchy be real
 * headings rather than rows spliced into a flat list.
 */

const HINTS: Array<[string[], string]> = [
  [['/'], 'filter'],
  [['j', 'k'], 'move'],
  [['enter'], 'search indexers'],
  [['?'], 'all shortcuts'],
];

/** How often "read N ago" re-renders. The age is coarse; a second-level tick would only cost renders. */
const AGE_TICK_MS = 15_000;

/** Ticks a timestamp so a relative age does not freeze at whatever it said on first paint. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function rootKey(instanceId: string, rootPath: string): string {
  return `${instanceId}::${rootPath}`;
}

function matches(folder: UnmappedFolderRow, needle: string): boolean {
  if (needle === '') return true;
  const q = needle.toLowerCase();
  return folder.name.toLowerCase().includes(q) || folder.path.toLowerCase().includes(q);
}

/** `formatBytes` renders 0 as an em dash; for free space, zero is a fact, not a gap. */
function formatFree(bytes: number | null): string {
  if (bytes === null) return 'free space not reported';
  if (bytes === 0) return '0 B free';
  return `${formatBytes(bytes)} free`;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface FolderView {
  folder: UnmappedFolderRow;
  /** Position in the cursor's flat list; `null` while its group is collapsed. */
  flatIndex: number | null;
}

interface RootView {
  key: string;
  root: UnmappedRoot;
  folders: FolderView[];
  collapsed: boolean;
}

interface InstanceView {
  instance: UnmappedInstance;
  roots: RootView[];
}

export default function UnmappedScreen() {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const now = useNow(AGE_TICK_MS);

  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const unmapped = useUnmapped();
  const instances = useMemo(() => unmapped.data?.instances ?? [], [unmapped.data]);
  const needle = query.trim();

  const failed = useMemo(() => instances.filter((i) => i.status !== 'ok'), [instances]);
  const answered = instances.length - failed.length;
  const totalFailure = instances.length > 0 && answered === 0;

  const totalFolders = useMemo(
    () => instances.reduce((n, i) => n + i.roots.reduce((m, r) => m + r.folders.length, 0), 0),
    [instances],
  );

  /**
   * Every root on every instance confirmed zero — the only condition under
   * which "nothing unmapped" is a true statement. An unreadable instance or an
   * unknown root is an outcome the operator has to see, never folded in here.
   */
  const allConfirmedNone = failed.length === 0
    && instances.some((i) => i.roots.length > 0)
    && instances.every((i) => i.roots.every((r) => r.state === 'none'));

  // One pass builds the hierarchy and the cursor's flat list together, so the
  // index a row renders with and the index `j`/`k` move over cannot disagree.
  const { views, flat } = useMemo(() => {
    const order: UnmappedFolderRow[] = [];
    const built: InstanceView[] = instances.map((instance) => ({
      instance,
      roots: instance.roots.flatMap((root): RootView[] => {
        const key = rootKey(instance.instanceId, root.rootPath);
        const hits = root.folders.filter((folder) => matches(folder, needle));
        // Under a filter, a root that listed nothing matching drops out — but
        // an unknown root stays: the folder being looked for may be in it, and
        // hiding it would be the filter answering a question nobody can.
        if (needle !== '' && hits.length === 0 && root.state !== 'unknown') return [];
        const isCollapsed = collapsed.has(key);
        return [{
          key,
          root,
          collapsed: isCollapsed,
          folders: hits.map((folder) => {
            if (isCollapsed) return { folder, flatIndex: null };
            order.push(folder);
            return { folder, flatIndex: order.length - 1 };
          }),
        }];
      }),
    }));
    return { views: built, flat: order };
  }, [instances, needle, collapsed]);

  const shownFolders = useMemo(
    () => views.reduce((n, v) => n + v.roots.reduce((m, r) => m + r.folders.length, 0), 0),
    [views],
  );

  const onOpen = useCallback((index: number) => {
    const url = flat[index]?.searchUrl;
    if (url) router.push(url);
  }, [flat, router]);

  // Nothing to close: no inspector, no selection. Escape still blurs the
  // filter field, which `useListKeyboard` handles before this is asked.
  const onEscape = useCallback(() => false, []);

  const { cursor, setCursor } = useListKeyboard({
    count: flat.length,
    onOpen,
    onEscape,
    searchRef,
  });

  const toggleRoot = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const reread = unmapped.refresh;
  const refresh = useCallback(() => { void reread(); }, [reread]);

  const readLine = unmapped.readAt ? `${sentenceCase(formatAge(unmapped.readAt, now))}.` : null;

  return (
    <main className="main" id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Unmapped"
          sub={(
            <>
              Folders on disk that no instance is monitoring. Read-only — nothing here creates,
              imports, or deletes anything.
              {readLine ? <> <span className="subtle">{readLine}</span></> : null}
            </>
          )}
          actions={(
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={refresh}
              disabled={unmapped.isFetching}
            >
              <Icon name="refresh" size={12} />
              {unmapped.isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        />

        <div className="toolbar">
          <SearchField
            inputRef={searchRef}
            value={query}
            onChange={setQuery}
            label="Filter the unmapped folders"
            placeholder="Filter by folder name or path…"
          />
          <span className="toolbar__spacer" />
          <span className="subtle" style={{ fontSize: 'var(--text-sm)' }} role="status">
            {shownFolders} of {totalFolders} folder{totalFolders === 1 ? '' : 's'} shown
          </span>
        </div>

        <div className="content__scroll">
          {failed.length > 0 && !totalFailure ? (
            <section className="section">
              <PartialBanner failed={failed} onRetry={refresh} busy={unmapped.isFetching} />
            </section>
          ) : null}

          <section className="section">
            {unmapped.isPending ? (
              <LoadingGroups />
            ) : unmapped.isError ? (
              <Callout tone="error">
                {unmapped.error instanceof ApiError
                  ? unmapped.error.message
                  : 'Could not read the root folders.'}
              </Callout>
            ) : instances.length === 0 ? (
              <EmptyState title="No Sonarr or Radarr instance">
                Unmapped folders come from Sonarr and Radarr root folders, and neither is
                configured. <Link href="/settings">Add one in Settings</Link>.
              </EmptyState>
            ) : totalFailure ? (
              <EmptyState title="No instance answered">
                <ul className="msg-list" style={{ textAlign: 'left' }}>
                  {failed.map((instance) => (
                    <li key={instance.instanceId}>
                      {instance.label} — {instance.error ?? 'the read did not complete'}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ marginTop: 'var(--space-4)' }}
                  onClick={refresh}
                  disabled={unmapped.isFetching}
                >
                  <Icon name="refresh" size={12} />Retry
                </button>
              </EmptyState>
            ) : allConfirmedNone ? (
              <EmptyState title="Nothing unmapped across any instance">
                Every root folder on {joinLabels(instances.map((i) => i.label))} reports zero
                folders that aren&rsquo;t mapped to a library item.
              </EmptyState>
            ) : views.every((v) => v.roots.length === 0) && needle !== '' ? (
              <EmptyState title="Nothing matches that filter">
                No unmapped folder mentions &ldquo;{needle}&rdquo;. Clear the filter to see
                everything.
              </EmptyState>
            ) : (
              <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
                {views.map((view) => (
                  <InstanceSection
                    key={view.instance.instanceId}
                    view={view}
                    filtering={needle !== ''}
                    cursor={cursor}
                    onCursorChange={setCursor}
                    onToggleRoot={toggleRoot}
                    listRef={listRef}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="section">
            <KeyboardHints items={HINTS} />
          </section>
        </div>
      </div>
    </main>
  );
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Names every instance that could not be read, with its own reason. One Retry,
 * because retrying here is re-reading — the same request as Refresh, never a
 * write — and the read is one request across every instance.
 */
function PartialBanner({
  failed,
  onRetry,
  busy,
}: {
  failed: UnmappedInstance[];
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div className="callout callout--warn banner" role="status" aria-live="polite">
      <Icon name="alert" size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {failed.map((instance) => (
          <div key={instance.instanceId} className="banner__line">
            <span>
              <strong>{instance.label}</strong>
              {` did not respond — ${instance.error ?? 'the read did not complete'}.`}
            </span>
          </div>
        ))}
        <div className="banner__line" style={{ marginTop: 'var(--space-2)' }}>
          <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
            Root folders from the instances that answered are shown below.
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={onRetry} disabled={busy}>
            <Icon name="refresh" size={12} />
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    </div>
  );
}

const SKELETON_GROUPS: string[][] = [['38%', '54%', '46%'], ['31%', '61%']];

/**
 * Skeleton root-folder groups at the real row height. Grouping, free space and
 * the listed / none / unknown state are all unknown until the read lands, so
 * nothing here pretends to one of them.
 */
function LoadingGroups() {
  return (
    <div
      className="card"
      aria-busy="true"
      aria-label="Reading root folders"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      {SKELETON_GROUPS.map((rows, group) => (
        <div key={group} aria-hidden="true">
          <div className="ggrid__skeleton" style={{ background: 'var(--color-bg-tinted)' }}>
            <span style={{ width: '24%' }} />
          </div>
          {rows.map((width, index) => (
            <div className="ggrid__skeleton" key={index}>
              <span style={{ width, marginLeft: 'var(--space-5)' }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const instanceHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  margin: '0 0 var(--space-2)',
  fontFamily: 'var(--font-heading)',
  fontSize: 'var(--text-sm)',
  fontWeight: 600,
  color: 'var(--color-foreground)',
};

function InstanceSection({
  view,
  filtering,
  cursor,
  onCursorChange,
  onToggleRoot,
  listRef,
}: {
  view: InstanceView;
  filtering: boolean;
  cursor: number;
  onCursorChange: (index: number) => void;
  onToggleRoot: (key: string) => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const { instance, roots } = view;
  const headingId = `unmapped-instance-${instance.instanceId}`;

  // Under a filter, an instance with nothing matching says nothing at all —
  // except a failed one, whose failure is still true whatever was typed.
  if (filtering && roots.length === 0 && instance.status === 'ok') return null;

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} style={instanceHeadStyle}>
        <Icon name={instance.kind === 'sonarr' ? 'tv' : 'film'} size={13} aria-hidden="true" />
        <span>{instance.label}</span>
        <span className="subtle" style={{ fontSize: 'var(--text-2xs)', fontWeight: 400 }}>
          {instance.kind === 'sonarr' ? 'Sonarr' : 'Radarr'}
        </span>
      </h2>

      {instance.status !== 'ok' ? (
        // In place as well as in the banner: the hierarchy should not read as
        // if this instance simply has no root folders.
        <div className="card" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline' }}>
          <span className="badge badge-error"><Icon name="x" size={11} />not read</span>
          <span style={{ fontSize: 'var(--text-sm)' }}>
            {instance.label} could not be read — {instance.error ?? 'the read did not complete'}.
            Its root folders are unknown, not empty.
          </span>
        </div>
      ) : roots.length === 0 ? (
        <div className="card subtle" style={{ fontSize: 'var(--text-sm)' }}>
          {instance.label} reports no root folders.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {roots.map((root) => (
            <RootFolderGroup
              key={root.key}
              view={root}
              instanceLabel={instance.label}
              cursor={cursor}
              onCursorChange={onCursorChange}
              onToggle={() => onToggleRoot(root.key)}
              listRef={listRef}
            />
          ))}
        </div>
      )}
    </section>
  );
}

const groupHeadStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--space-1) var(--space-3)',
  minHeight: 'var(--row-height)',
  padding: 'var(--space-1) var(--space-3)',
  background: 'var(--color-bg-tinted)',
  borderBottom: '1px solid var(--color-border)',
};

const metaStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-2xs)',
  color: 'var(--color-text-muted)',
};

const messageStyle: CSSProperties = {
  padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-8)',
  fontSize: 'var(--text-sm)',
  borderBottom: '1px solid var(--color-border-subtle)',
};

/**
 * One root folder: header plus whichever of the three bodies its state calls
 * for. `listed`, `none` and `unknown` must never render alike (REQ-GAPS-023):
 *
 * - listed  — "N unmapped" in the header, one row per folder.
 * - none    — "0 unmapped" plain, and a plain sentence. No glyph, no tone: a
 *             confirmed empty set is not a problem.
 * - unknown — a warn-toned "? unknown" badge, and a full sentence naming the
 *             instance and the likely cause.
 */
function RootFolderGroup({
  view,
  instanceLabel,
  cursor,
  onCursorChange,
  onToggle,
  listRef,
}: {
  view: RootView;
  instanceLabel: string;
  cursor: number;
  onCursorChange: (index: number) => void;
  onToggle: () => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const { root, folders, collapsed } = view;
  const bodyId = `unmapped-root-${view.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const collapsible = root.state === 'listed';

  return (
    <div>
      <h3 style={{ ...groupHeadStyle, margin: 0, fontWeight: 'inherit' }}>
        {collapsible ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            // The list layer is bound to the window and claims Enter; stopped
            // here so the disclosure stays keyboard-operable (same reason as
            // GapsGrid's season button).
            onKeyDown={stopListKeys}
            onClick={onToggle}
            style={{ paddingLeft: 'var(--space-1)', minWidth: 0 }}
          >
            <Icon
              name="chevronRight"
              size={12}
              style={{
                transform: collapsed ? 'none' : 'rotate(90deg)',
                transition: 'transform var(--duration-fast) var(--ease-productive)',
              }}
            />
            <span className="mono truncate" style={{ color: 'var(--color-foreground)' }}>
              {root.rootPath}
            </span>
          </button>
        ) : (
          <span
            className="mono truncate"
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-foreground)',
              paddingLeft: 'var(--space-6)',
              minWidth: 0,
            }}
          >
            {root.rootPath}
          </span>
        )}

        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', marginLeft: 'auto' }}>
          <span style={metaStyle}>{instanceLabel}</span>
          <span style={metaStyle}>{formatFree(root.freeSpace)}</span>
          {!root.accessible ? (
            <span className="badge badge-error" title={`${instanceLabel} reports it cannot access this folder`}>
              <Icon name="x" size={11} />not accessible
            </span>
          ) : null}
          <StateMarker root={root} />
        </span>
      </h3>

      {root.state === 'unknown' ? (
        <p style={messageStyle} id={bodyId}>
          Unknown — {instanceLabel} did not report unmapped folders for this root folder. It may
          have run out of time scanning it; a slow or very large mount is the usual cause.
        </p>
      ) : root.state === 'none' ? (
        <p className="subtle" style={messageStyle} id={bodyId}>
          {instanceLabel} reported none.
        </p>
      ) : collapsed ? (
        <div id={bodyId} hidden />
      ) : (
        <div
          id={bodyId}
          role="grid"
          aria-label={`Unmapped folders in ${root.rootPath} on ${instanceLabel}`}
          aria-readonly="true"
        >
          {folders.map(({ folder, flatIndex }) => (
            flatIndex === null ? null : (
              <FolderRow
                key={folder.path}
                folder={folder}
                flatIndex={flatIndex}
                isCursor={flatIndex === cursor}
                onCursorChange={onCursorChange}
                listRef={listRef}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

function StateMarker({ root }: { root: UnmappedRoot }) {
  if (root.state === 'unknown') {
    return (
      <span className="badge badge-warn">
        <span aria-hidden="true">?</span>
        unknown
      </span>
    );
  }
  // `count` is never null outside `unknown`; the fallback only keeps the type honest.
  const count = root.count ?? root.folders.length;
  return <span style={metaStyle}>{count} unmapped</span>;
}

function stopListKeys(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

const rowStyle: CSSProperties = {
  // The gaps grid's row classes give the hover, cursor and focus-ring states;
  // these undo the virtualizer's absolute positioning, which this list has no
  // use for, and its click-to-open pointer, since a row click only moves the
  // cursor here.
  position: 'relative',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--space-1) var(--space-3)',
  height: 'auto',
  minHeight: 'var(--row-height)',
  padding: 'var(--space-1) var(--space-3) var(--space-1) var(--space-6)',
  cursor: 'default',
};

function FolderRow({
  folder,
  flatIndex,
  isCursor,
  onCursorChange,
  listRef,
}: {
  folder: UnmappedFolderRow;
  flatIndex: number;
  isCursor: boolean;
  onCursorChange: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Follow the cursor into view; take DOM focus only when focus is already in
  // the list, so `j` from the filter field never drags the operator out of it.
  useEffect(() => {
    if (!isCursor) return;
    const node = ref.current;
    if (!node) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && listRef.current?.contains(active)) node.focus();
    node.scrollIntoView?.({ block: 'nearest' });
  }, [isCursor, listRef]);

  return (
    <div
      ref={ref}
      role="row"
      tabIndex={isCursor ? 0 : -1}
      className={`ggrid__body-row${isCursor ? ' is-cursor' : ''}`}
      style={rowStyle}
      onClick={() => onCursorChange(flatIndex)}
    >
      <span
        role="gridcell"
        className="ggrid__cell"
        style={{ flex: '1 1 16rem', padding: 0, display: 'flex', flexDirection: 'column' }}
      >
        <span className="truncate" style={{ fontSize: 'var(--text-sm)' }} title={folder.name}>
          {folder.name}
        </span>
        <span className="mono subtle truncate" style={{ fontSize: 'var(--text-2xs)' }} title={folder.path}>
          {folder.path}
        </span>
      </span>
      <span role="gridcell" style={{ flex: 'none', marginLeft: 'auto' }}>
        {folder.searchUrl ? (
          <Link
            href={folder.searchUrl}
            className="btn btn-ghost btn-sm"
            // Visible text "Search" stays at the front of the name (WCAG 2.5.3);
            // the folder is added because a column of identical links is
            // otherwise unreadable out of context.
            aria-label={`Search indexers for ${folder.name}`}
            onKeyDown={stopListKeys}
            onClick={(event) => event.stopPropagation()}
          >
            <Icon name="search" size={12} />Search
          </Link>
        ) : (
          <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>no search link</span>
        )}
      </span>
    </div>
  );
}
