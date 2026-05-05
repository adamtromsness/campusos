'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useWellbeingCheckins } from '@/hooks/use-wellbeing';
import { formatRelative } from '@/lib/wellbeing-format';

/**
 * /wellbeing — Student wellbeing landing page.
 *
 * The first student-input surface in CampusOS. The list endpoint is
 * row-scoped server-side to the calling student via actor.personId →
 * platform_students → sis_students, so the student only ever sees
 * their own pending + completed check-ins.
 *
 * Tile is gated on COU-004:read which the Step 3 IAM seed grants to
 * students; the row-scope at the service layer keeps each student
 * bound to their own student_id.
 */
export default function StudentWellbeingPage() {
  const pendingQ = useWellbeingCheckins({ pending: true });
  const recentQ = useWellbeingCheckins({ pending: false });

  const pending = pendingQ.data ?? [];
  const recent = (recentQ.data ?? []).slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wellbeing"
        description="A short check-in to share how you're doing. Your responses go to the counselling team — not to teachers, parents, or other students."
      />

      {/* Pending */}
      <section className="rounded-lg border border-rose-200 bg-rose-50/40 p-5">
        <h2 className="text-base font-semibold text-rose-900">Pending check-ins</h2>
        <p className="mt-1 text-xs text-rose-800">
          Your counsellor sent these and is waiting for your responses.
        </p>
        {pendingQ.isLoading ? (
          <LoadingSpinner />
        ) : pending.length === 0 ? (
          <p className="mt-4 text-sm text-rose-900">
            All caught up — no pending check-ins right now.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {pending.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-rose-100 bg-white p-4 shadow-sm transition hover:border-rose-300"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{c.templateName}</div>
                    <div className="mt-1 text-xs text-gray-500">
                      Sent {formatRelative(c.createdAt)} ·{' '}
                      {c.assignedCounselorName
                        ? 'From ' + c.assignedCounselorName
                        : 'From the counselling team'}
                    </div>
                  </div>
                  <Link
                    href={'/wellbeing/checkins/' + c.id}
                    className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700"
                  >
                    Start check-in →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* My recent responses */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-gray-900">My recent check-ins</h2>
          <Link
            href="/wellbeing/history"
            className="text-sm font-medium text-campus-700 hover:underline"
          >
            See all →
          </Link>
        </div>
        {recentQ.isLoading ? (
          <LoadingSpinner />
        ) : recent.length === 0 ? (
          <EmptyState
            title="No check-ins yet"
            description="Once you complete a check-in, you'll see it here."
          />
        ) : (
          <ul className="mt-3 space-y-2">
            {recent.map((c) => (
              <li
                key={c.id}
                className="flex items-baseline justify-between rounded-md border border-gray-200 p-3"
              >
                <div className="text-sm font-medium text-gray-900">{c.templateName}</div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">{formatRelative(c.completedAt)}</span>
                  <Link
                    href={'/wellbeing/history#' + c.id}
                    className="text-xs font-medium text-campus-700 hover:underline"
                  >
                    View
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-gray-500">
        Your counsellor reads these so they can support you. Your responses are kept private from
        teachers and parents.
      </p>
    </div>
  );
}
