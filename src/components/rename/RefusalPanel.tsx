'use client';

import Icon from '@/components/Icon';
import { Callout } from '@/components/ui';
import type { RenamePlanDto, RenameRefusal } from '@/lib/types';

/**
 * Expiry and drift (T15, FR10, FR11, NFR3, REQ-RENAME-013/014).
 *
 * **Regeneration is the only control on this screen**, and that is the design,
 * not an omission. There is no force flag, no "apply anyway", no override, no
 * "ignore the drifted rows and send the rest" — NFR3, and the absence has to
 * hold in the markup as well as in the server, because an affordance offered
 * here is one an operator will look for and, in a hurry, find a way to want.
 *
 * The refusal is whole-plan on purpose. One drifted precondition means the
 * preview the operator read no longer describes the library; applying "the rest
 * of it" would apply something nobody has read.
 */

export interface RefusalPanelProps {
  plan: RenamePlanDto;
  onRegenerate: () => void;
  /** True while the replacement plan is being started. */
  busy: boolean;
  /**
   * Whether the scope that produced this plan is still known. It only changes
   * the wording — the button is offered either way, because "go back and pick
   * again" is still regeneration, and a dead end here would leave the operator
   * with a refusal and nothing to do about it.
   */
  hasScope: boolean;
}

export default function RefusalPanel({
  plan, onRegenerate, busy, hasScope,
}: RefusalPanelProps) {
  const expired = plan.phase === 'expired' || plan.refusal?.kind === 'expired';
  const refusal: RenameRefusal | null = plan.refusal;
  const drifted = refusal?.drifted ?? [];

  return (
    <>
      <div className="ribbon ribbon--refused" role="status">
        <Icon name="alert" size={14} />
        <span className="ribbon__title">
          {expired ? 'PLAN EXPIRED — nothing was renamed' : 'PLAN REFUSED — nothing was renamed'}
        </span>
      </div>

      <div className="content__scroll">
        <section className="section">
          <div className="card refusal">
            <h2 className="refusal__title">
              {expired
                ? 'This preview is too old to apply'
                : refusal?.kind === 'precondition-drift'
                  ? 'The library moved underneath this preview'
                  : 'There is no plan to apply'}
            </h2>

            <p className="refusal__body">
              {expired ? (
                <>
                  A plan is valid for five minutes from the moment it is built. Past that,
                  helparr cannot promise the files are still where the preview says they are,
                  so it will not send the rename. <strong>No file was renamed</strong> — not
                  one, not partially.
                </>
              ) : refusal?.kind === 'precondition-drift' ? (
                <>
                  Before renaming anything, helparr re-checks every file against the plan: the
                  same file id, at the same path the preview recorded. At least one no longer
                  matches, which means something changed the library after you read the
                  preview. <strong>The whole plan was refused and no file was renamed</strong>,
                  including the files that had not changed — a plan that is partly wrong is a
                  plan you did not approve.
                </>
              ) : (
                <>
                  Nothing could be previewed, so there is nothing to approve.{' '}
                  <strong>No file was renamed.</strong>
                </>
              )}
            </p>

            {refusal?.reason ? (
              <Callout tone="idle" icon="info">{refusal.reason}</Callout>
            ) : null}

            {drifted.length > 0 ? (
              <>
                <h3 className="refusal__subtitle">
                  {drifted.length} file{drifted.length === 1 ? '' : 's'} no longer{' '}
                  {drifted.length === 1 ? 'matches' : 'match'} the preview
                </h3>
                <ul className="refusal__paths">
                  {drifted.map((path) => (
                    <li key={path} className="mono">{path}</li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="refusal__foot">
              {/* The only control. Not a default that hides a second option
                  behind a disclosure — the second option does not exist
                  (NFR3). */}
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRegenerate}
                disabled={busy}
              >
                <Icon name="refresh" size={13} />
                {busy
                  ? 'Building…'
                  : hasScope ? 'Build a fresh preview' : 'Choose titles again'}
              </button>
              <p className="refusal__note subtle">
                {hasScope
                  ? 'Reads the same titles again and shows you what they look like now. There '
                    + 'is no way to send this plan as it stands, and adding one would mean '
                    + 'renaming files against a description you have not read.'
                  : 'Pick the titles again and helparr will build a fresh preview of them. '
                    + 'This plan cannot be sent as it stands, and there is no setting that '
                    + 'changes that.'}
              </p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
