import Link from 'next/link';

import { ScreenHead } from './ui';

/**
 * Placeholder for a screen that the roadmap delivers in a later change. The
 * navigation contract from the prototype is five screens; shipping four of them
 * as dead links would be a worse lie than saying plainly what is not built yet.
 */
export default function ComingSoon({
  title,
  changeId,
  children,
}: {
  title: string;
  changeId: string;
  children: React.ReactNode;
}) {
  return (
    <main className="main" id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead title={title} sub={children} />
        <div className="content__scroll">
          <section className="section">
            <div className="empty">
              <p className="empty__title">Not built yet</p>
              <p className="empty__body">
                This screen ships with the <code className="mono">{changeId}</code> change. Until
                then, configure your instances in{' '}
                <Link href="/settings">Settings</Link>.
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
