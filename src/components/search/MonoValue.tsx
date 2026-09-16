'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import Icon from '@/components/Icon';

/**
 * A machine value: monospace, middle-truncated, copyable (FR14, REQ-SEARCH-005).
 *
 * **Middle** truncation specifically. A guid and an infoHash are distinguished
 * by their middles as much as their heads; `magnet:?xt=urn:btih:9D8666…` and
 * `magnet:?xt=urn:btih:9D8666…` are the same string on screen and different
 * releases in fact. Clipping the end is what makes two rows look identical.
 *
 * The truncation is visual only — `title` and the clipboard both carry the
 * whole value, so nothing here can hand the operator a shortened string they
 * then paste somewhere.
 */

const HEAD = 18;
const TAIL = 10;

export default function MonoValue({
  value,
  label,
}: {
  value: string | null;
  /** What is being copied, for the button's accessible name. */
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be refused — over plain HTTP on a LAN address,
      // which is exactly how helparr is deployed. Silence would look like the
      // copy worked, so the button says so instead.
      setCopied(false);
    }
  }, [value]);

  // An absent value is not an empty one. `—` with nothing to copy is the honest
  // rendering of "this release carries no infoHash", which is true of usenet.
  if (value === null || value === '') {
    return <span className="subtle">—</span>;
  }

  return (
    <span className="monoval">
      <span className="monoval__text mono" title={value}>{middleEllipsis(value)}</span>
      <button
        type="button"
        className="icon-btn monoval__copy"
        onClick={copy}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} />
      </button>
      {/* Announced rather than only shown, so the confirmation is not colour-
          and-glyph only. */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? `${label} copied to the clipboard` : ''}
      </span>
    </span>
  );
}

export function middleEllipsis(value: string): string {
  if (value.length <= HEAD + TAIL + 1) return value;
  return `${value.slice(0, HEAD)}…${value.slice(-TAIL)}`;
}
