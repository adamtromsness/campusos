'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthStore } from '@/lib/auth-store';
import {
  useCheckouts,
  useDismissRecommendation,
  useFines,
  useHolds,
  useReadingLog,
  useReadingProgrammes,
  useRecommendations,
} from '@/hooks/use-library';
import { useMyStudent } from '@/hooks/use-classroom';
import {
  CHECKOUT_STATUS_PILL,
  FINE_STATUS_PILL,
  HOLD_STATUS_PILL,
  LIBRARY_HOLD_STATUS_LABELS,
  RECOMMENDATION_REASON_LABELS,
  RECOMMENDATION_REASON_PILL,
  formatCurrency,
  formatDate,
  formatDaysUntilDue,
  isOverdue,
} from '@/lib/library-format';
import { useToast } from '@/components/ui/Toast';

/**
 * /library/my — student-only combined library landing.
 *
 * Pulls together checkouts + holds + fines + reading log + programme
 * progress in one place. The default /library page works for everyone;
 * this page is a richer student-focused view including reading-log +
 * programme-progress summaries that aren't on the simple patron
 * dashboard.
 */
export default function MyLibraryPage() {
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.personType === 'STUDENT';

  const checkoutsQ = useCheckouts();
  const holdsQ = useHolds();
  const finesQ = useFines({ status: 'OUTSTANDING' });
  const logQ = useReadingLog();
  const programmesQ = useReadingProgrammes(false);

  if (!isStudent) {
    return (
      <div className="space-y-4">
        <PageHeader title="My library" />
        <p className="rounded-md bg-amber-50 p-4 text-sm text-amber-900">
          This page is the student portal. Use{' '}
          <Link href="/library" className="font-medium underline">
            /library
          </Link>{' '}
          for the librarian and patron dashboards.
        </p>
      </div>
    );
  }

  const checkouts = checkoutsQ.data ?? [];
  const active = checkouts.filter((c) => c.status === 'ACTIVE' || c.status === 'OVERDUE');
  const holds = (holdsQ.data ?? []).filter((h) => h.status === 'PENDING' || h.status === 'READY');
  const outstandingFines = (finesQ.data ?? []).filter((f) => f.status === 'OUTSTANDING');
  const log = logQ.data ?? [];
  const completed = log.filter((l) => l.completedDate);
  const inProgress = log.filter((l) => !l.completedDate);
  const programmes = (programmesQ.data ?? []).filter((p) => p.isActive);
  const totalPages = log.reduce((s, l) => s + (l.pagesRead ?? 0), 0);
  const totalFinesOwed = outstandingFines.reduce((s, f) => s + Number(f.amount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My library"
        description="Your checkouts, holds, fines, reading log, and programme progress in one place."
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Checked out" value={String(active.length)} />
        <Stat label="On hold" value={String(holds.length)} />
        <Stat
          label="Owed"
          value={formatCurrency(totalFinesOwed)}
          tone={totalFinesOwed > 0 ? 'rose' : 'gray'}
        />
        <Stat label="Books read" value={String(completed.length)} />
        <Stat label="Pages read" value={String(totalPages)} />
      </section>

      <RecommendationsShelf />

      {programmes.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Reading programmes</h2>
            <Link
              href="/library/programmes"
              className="text-xs font-medium text-campus-700 hover:text-campus-800"
            >
              See all →
            </Link>
          </div>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {programmes.slice(0, 4).map((p) => {
              const progress = p.myProgress;
              const target = p.targetBooks ?? p.targetPages ?? 0;
              const value =
                p.targetBooks !== null ? (progress?.booksRead ?? 0) : (progress?.pagesRead ?? 0);
              const label = p.targetBooks !== null ? 'books' : 'pages';
              const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
              return (
                <li key={p.id} className="rounded-lg border border-gray-200 bg-white p-4">
                  <Link
                    href={`/library/programmes/${p.id}`}
                    className="font-medium text-gray-900 hover:text-campus-700"
                  >
                    {p.name}
                  </Link>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="font-medium text-gray-700">
                      {value} / {target} {label}
                    </span>
                    <span
                      className={
                        progress?.isComplete ? 'font-semibold text-emerald-700' : 'text-gray-500'
                      }
                    >
                      {progress?.isComplete ? '✓ Complete' : pct + '%'}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={
                        'h-full ' + (progress?.isComplete ? 'bg-emerald-500' : 'bg-campus-500')
                      }
                      style={{ width: pct + '%' }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Currently reading</h2>
          <Link
            href="/library/reading-log"
            className="text-xs font-medium text-campus-700 hover:text-campus-800"
          >
            Open my reading log →
          </Link>
        </div>
        {logQ.isLoading ? (
          <LoadingSpinner />
        ) : inProgress.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">
            No books in progress.{' '}
            <Link href="/library/reading-log" className="font-medium text-campus-700">
              Log a book
            </Link>{' '}
            to track your reading.
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {inProgress.slice(0, 4).map((l) => (
              <li key={l.id} className="rounded border border-gray-100 bg-gray-50/40 p-3">
                <div className="font-medium text-gray-900">{l.itemTitle ?? '—'}</div>
                <div className="mt-0.5 text-xs text-gray-500">
                  Started {formatDate(l.startedDate)}
                  {l.pagesRead !== null && ` · ${l.pagesRead} pages so far`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">My active checkouts</h2>
        {checkoutsQ.isLoading ? (
          <LoadingSpinner />
        ) : active.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">No active checkouts.</p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-100">
            {active.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <div className="font-medium text-gray-900">{c.itemTitle ?? '—'}</div>
                  <div className="text-xs text-gray-500">
                    {c.copyBarcode} · checked out {formatDate(c.checkoutDate)}
                  </div>
                </div>
                <span
                  className={
                    'rounded px-2 py-0.5 text-xs font-medium ' +
                    (isOverdue(c.daysUntilDue)
                      ? CHECKOUT_STATUS_PILL.OVERDUE
                      : CHECKOUT_STATUS_PILL.ACTIVE)
                  }
                >
                  {formatDaysUntilDue(c.daysUntilDue)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">My holds</h2>
        {holdsQ.isLoading ? (
          <LoadingSpinner />
        ) : holds.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">No holds placed.</p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-100">
            {holds.map((h) => (
              <li key={h.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="font-medium text-gray-900">{h.itemTitle ?? '—'}</div>
                  <div className="text-xs text-gray-500">
                    Placed {formatDate(h.placedAt)}
                    {h.queuePosition !== null && ` · queue position ${h.queuePosition}`}
                  </div>
                </div>
                <span
                  className={
                    'rounded px-2 py-0.5 text-xs font-medium ' + HOLD_STATUS_PILL[h.status]
                  }
                >
                  {LIBRARY_HOLD_STATUS_LABELS[h.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {outstandingFines.length > 0 && (
        <section className="rounded-lg border border-rose-200 bg-rose-50/40 p-5">
          <h2 className="text-base font-semibold text-rose-900">Outstanding fines</h2>
          <p className="mt-1 text-xs text-rose-800">
            Visit the librarian to pay or discuss a waiver.
          </p>
          <ul className="mt-4 divide-y divide-rose-200">
            {outstandingFines.map((f) => (
              <li key={f.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="font-medium text-rose-900">{f.itemTitle ?? '—'}</div>
                  <div className="text-xs text-rose-700">
                    {f.daysOverdue !== null ? `${f.daysOverdue} days overdue` : '—'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-rose-900">
                    {formatCurrency(Number(f.amount))}
                  </span>
                  <span
                    className={
                      'rounded px-2 py-0.5 text-xs font-medium ' + FINE_STATUS_PILL[f.status]
                    }
                  >
                    {f.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'gray',
}: {
  label: string;
  value: string;
  tone?: 'gray' | 'rose';
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div
        className={
          'mt-1 text-xl font-semibold ' + (tone === 'rose' ? 'text-rose-700' : 'text-gray-900')
        }
      >
        {value}
      </div>
    </div>
  );
}

function RecommendationsShelf() {
  const me = useMyStudent();
  const recsQ = useRecommendations(me.data?.id ?? null);
  const dismiss = useDismissRecommendation(me.data?.id ?? null);
  const { toast } = useToast();

  if (!me.data) return null;
  const recs = recsQ.data ?? [];
  if (recs.length === 0 && !recsQ.isLoading) return null;

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Recommended for you</h2>
        <span className="text-xs text-gray-500">Refreshed weekly</span>
      </div>
      {recsQ.isLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recs.slice(0, 6).map((r) => (
            <article
              key={r.id}
              className="flex flex-col gap-2 rounded-md border border-gray-200 p-3 transition hover:border-campus-300"
            >
              <div className="flex items-start gap-3">
                {r.itemCoverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.itemCoverImageUrl}
                    alt=""
                    className="h-16 w-12 flex-shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-12 flex-shrink-0 items-center justify-center rounded bg-gray-100 text-xs text-gray-400">
                    book
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/library/catalogue/${r.recommendedItemId}`}
                    className="block truncate font-medium text-gray-900 hover:text-campus-700"
                  >
                    {r.itemTitle ?? '—'}
                  </Link>
                  {r.itemAuthor && (
                    <div className="truncate text-xs text-gray-600">by {r.itemAuthor}</div>
                  )}
                  <span
                    className={
                      'mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ' +
                      RECOMMENDATION_REASON_PILL[r.reasonType]
                    }
                  >
                    {RECOMMENDATION_REASON_LABELS[r.reasonType]}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  dismiss.mutate(r.id, {
                    onSuccess: () => toast('Dismissed', 'success'),
                    onError: (err) => toast((err as Error).message, 'error'),
                  })
                }
                className="self-end text-xs text-gray-500 hover:text-rose-600"
              >
                Not interested
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
