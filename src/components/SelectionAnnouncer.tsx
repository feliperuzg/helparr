'use client';

import { useCallback, useState } from 'react';

/**
 * The polite live region a range gesture speaks through (REQ-A11Y-011, ADR-8
 * of queue-triage-ergonomics).
 *
 * Always mounted, and empty until there is something to say: a live region
 * inserted together with its first message announces nothing, which is why
 * neither the bulk bar (mounted at count ≥ 1) nor a toast can carry this.
 */
export function SelectionAnnouncer({ message }: { message: Announcement }) {
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {/* The trailing no-break space alternates so the same sentence twice in
          a row — six rows, then six again — is still a change the screen
          reader hears. */}
      {message.text}{message.text && message.seq % 2 === 1 ? ' ' : ''}
    </div>
  );
}

export interface Announcement {
  text: string;
  seq: number;
}

export function useAnnouncer() {
  const [message, setMessage] = useState<Announcement>({ text: '', seq: 0 });
  const announce = useCallback((text: string) => {
    setMessage((current) => ({ text, seq: current.seq + 1 }));
  }, []);
  return { message, announce };
}

/** "6 items selected" — the sentence a selection range announces. */
export function selectionSentence(total: number, noun = 'item'): string {
  return `${total} ${total === 1 ? noun : `${noun}s`} selected`;
}
