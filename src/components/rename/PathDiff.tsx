'use client';

import Icon from '@/components/Icon';
import { diffPath, type PathDiff, type Span } from '@/components/rename/planView';

/**
 * The before/after rendering (T12, FR3, NFR6).
 *
 * Colour is never the channel that carries the difference. Three others do, and
 * each one survives on its own:
 *
 * 1. **Position and a sign glyph** — the old path is on the `−` line, the new
 *    one on the `+` line, in that order.
 * 2. **Brackets around the changed span** — `«…»`, computed by trimming the
 *    common prefix and suffix, so the eye lands on the characters that differ
 *    rather than on a wall of identical path.
 * 3. **A sentence** — the inspector states the change in words
 *    ("Folder: Season 3 → Season 03"), which is the channel that works when the
 *    path wraps, when it is read aloud, and when it is printed in black ink.
 *
 * The wireframe's caret underline (`^^^^`) is the one channel not used: it is
 * an alignment trick, and these paths wrap on `break-all` at every width the
 * grid is used at, so the carets would point at the wrong characters. The
 * sentence replaces it and carries strictly more information.
 */

function Marked({ span, empty }: { span: Span; empty: string }) {
  if (span.changed === '') {
    return (
      <>
        {span.lead}
        <span className="diff__unchanged"> {empty}</span>
      </>
    );
  }
  return (
    <>
      {span.lead}
      <mark className="diff__mark">
        <span aria-hidden="true">«</span>
        {span.changed}
        <span aria-hidden="true">»</span>
      </mark>
      {span.trail}
    </>
  );
}

/**
 * The full two-line diff. Used in the inspector, where there is width for the
 * whole path — the grid shows the filename only, because a column cannot hold
 * two absolute paths and still be a row.
 */
export function DiffBlock({
  existingPath,
  proposedPath,
}: {
  existingPath: string;
  proposedPath: string;
}) {
  const diff = diffPath(existingPath, proposedPath);
  return (
    <div className="diff">
      <div className="diff__row diff__row--from">
        <span className="diff__sign" aria-hidden="true">−</span>
        <span className="sr-only">Currently at</span>
        <span className="diff__path"><Marked span={diff.fromBaseSpan} empty="" /></span>
      </div>
      <div className="diff__row diff__row--to">
        <span className="diff__sign" aria-hidden="true">+</span>
        <span className="sr-only">Would become</span>
        <span className="diff__path"><Marked span={diff.toBaseSpan} empty="" /></span>
      </div>
      <FolderLines diff={diff} />
    </div>
  );
}

function FolderLines({ diff }: { diff: PathDiff }) {
  if (!diff.dirChanged) {
    return (
      <p className="diff__note">
        Folder unchanged — <span className="mono">{diff.fromDir || '/'}</span>
      </p>
    );
  }
  return (
    <>
      <div className="diff__row diff__row--from">
        <span className="diff__sign" aria-hidden="true">−</span>
        <span className="sr-only">Currently in folder</span>
        <span className="diff__path"><Marked span={diff.fromDirSpan} empty="" /></span>
      </div>
      <div className="diff__row diff__row--to">
        <span className="diff__sign" aria-hidden="true">+</span>
        <span className="sr-only">Would move to folder</span>
        <span className="diff__path"><Marked span={diff.toDirSpan} empty="" /></span>
      </div>
      <p className="diff__note diff__note--move">
        <Icon name="folder" size={12} />
        The folder changes, so this file is <strong>moved</strong> as well as renamed:{' '}
        <span className="mono">{diff.fromDirSpan.changed || diff.fromDir}</span>
        {' → '}
        <span className="mono">{diff.toDirSpan.changed || diff.toDir}</span>
      </p>
    </>
  );
}

/**
 * The one-line grid form: filename only, old then new, with the arrow reading
 * as "becomes" for anything that cannot see it.
 */
export function DiffCell({
  existingPath,
  proposedPath,
}: {
  existingPath: string;
  proposedPath: string;
}) {
  const diff = diffPath(existingPath, proposedPath);
  return (
    <span className="path-cell">
      <span className="path-cell__from mono" title={existingPath}>
        <Marked span={diff.fromBaseSpan} empty="(unchanged)" />
      </span>
      <span className="path-cell__arrow" aria-hidden="true">→</span>
      <span className="sr-only">becomes</span>
      <span className="path-cell__to mono" title={proposedPath}>
        <Marked span={diff.toBaseSpan} empty="(unchanged)" />
      </span>
      {diff.dirChanged ? (
        <span className="path-cell__move" title="The folder changes too — this is a move">
          <Icon name="folder" size={11} />
          <span className="sr-only">and moves to a different folder</span>
        </span>
      ) : null}
    </span>
  );
}
