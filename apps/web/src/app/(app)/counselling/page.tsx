'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useCaseloads, useReferrals, useSessions } from '@/hooks/use-counselling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CASELOAD_STATUS_PILL,
  PRIMARY_CONCERN_LABELS,
  PRIMARY_CONCERN_PILL,
  REFERRAL_PRIORITY_LABELS,
  REFERRAL_PRIORITY_PILL,
  REFERRAL_STATUS_LABELS,
  REFERRAL_STATUS_PILL,
  SESSION_STATUS_LABELS,
  SESSION_STATUS_PILL,
  SESSION_TYPE_LABELS,
  SESSION_TYPE_PILL,
  formatDateOnly,
  formatRelative,
  isTriageWorthy,
  priorityRank,
  studentDisplay,
  todayIso,
} from '@/lib/counselling-format';
import type { ReferralDto, SessionDto } from '@/lib/types';

export default function CounsellingDashboardPage() {
  const { user } = useAuthStore();
  const isGuardian = user?.activePersona?.type === 'PARENT';

  // Active caseloads (counsellor sees own; admin sees school-wide; parent sees own children).
  const caseloadsQ = useCaseloads({ status: 'ACTIVE' });

  // Triage queue: SUBMITTED + TRIAGED rows. Counsellor sees their assigned + the unassigned-triage queue.
  const triageQ = useReferrals({
    enabled: !isGuardian && hasAnyPermission(user, ['cou-002:read']),
  });

  // Today's sessions for the counsellor.
  const today = todayIso();
  const sessionsQ = useSessions({
    fromDate: today,
    toDate: today,
    enabled: !isGuardian && hasAnyPermission(user, ['cou-001:read']),
  });

  const triageList = useMemo(() => {
    const all = triageQ.data ?? [];
    return all
      .filter((r) => isTriageWorthy(r.status))
      .sort((a, b) => {
        const pr = priorityRank(a.priority) - priorityRank(b.priority);
        if (pr !== 0) return pr;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
  }, [triageQ.data]);

  const todaySessions = useMemo(() => {
    const all = sessionsQ.data ?? [];
    return [...all].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  }, [sessionsQ.data]);

  return (
    <div>
      <PageHeader
        title="Counselling"
        description={
          isGuardian
            ? 'Your child’s caseload assignment.'
            : 'Caseloads, referrals, and today’s sessions.'
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* My caseload */}
        <section className="xl:col-span-1">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-gray-900">My caseload</h2>
            <span className="text-xs text-gray-500">
              {caseloadsQ.data ? caseloadsQ.data.length + ' active' : ''}
            </span>
          </div>
          {caseloadsQ.isLoading ? (
            <LoadingSpinner />
          ) : (caseloadsQ.data ?? []).length === 0 ? (
            <EmptyState
              title="No active caseloads"
              description={
                isGuardian
                  ? 'Your child does not currently have a counsellor assigned.'
                  : 'Open a caseload from the Referrals queue when you accept a referral.'
              }
            />
          ) : (
            <ul className="space-y-2">
              {(caseloadsQ.data ?? []).map((cl) => (
                <li key={cl.id}>
                  <Link
                    href={'/counselling/caseloads/' + cl.id}
                    className="block rounded-lg border border-gray-200 bg-white p-3 hover:border-campus-300 hover:shadow-sm"
                  >
                    <div className="flex items-baseline justify-between">
                      <div className="text-sm font-medium text-gray-900">
                        {studentDisplay(cl.studentFirstName, cl.studentLastName)}
                        {cl.studentGradeLevel ? (
                          <span className="ml-1 text-xs text-gray-500">
                            (Grade {cl.studentGradeLevel})
                          </span>
                        ) : null}
                      </div>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          CASELOAD_STATUS_PILL[cl.status],
                        )}
                      >
                        {cl.status}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          PRIMARY_CONCERN_PILL[cl.primaryConcern],
                        )}
                      >
                        {PRIMARY_CONCERN_LABELS[cl.primaryConcern]}
                      </span>
                      <span>· Counsellor: {cl.counselorName ?? 'Unknown'}</span>
                      <span>· Opened {formatDateOnly(cl.openedAt)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Referral triage queue */}
        {!isGuardian && hasAnyPermission(user, ['cou-002:read']) ? (
          <section className="xl:col-span-1">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-base font-semibold text-gray-900">Triage queue</h2>
              <Link
                href="/counselling/referrals"
                className="text-xs font-medium text-campus-700 hover:text-campus-800"
              >
                See all →
              </Link>
            </div>
            {triageQ.isLoading ? (
              <LoadingSpinner />
            ) : triageList.length === 0 ? (
              <EmptyState
                title="Triage queue is clear"
                description="No SUBMITTED or TRIAGED referrals."
              />
            ) : (
              <ul className="space-y-2">
                {triageList.map((r) => (
                  <ReferralTriageRow key={r.id} referral={r} />
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {/* Today's sessions */}
        {!isGuardian && hasAnyPermission(user, ['cou-001:read']) ? (
          <section className="xl:col-span-1">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-base font-semibold text-gray-900">Today’s sessions</h2>
              <Link
                href="/counselling/sessions"
                className="text-xs font-medium text-campus-700 hover:text-campus-800"
              >
                Session log →
              </Link>
            </div>
            {sessionsQ.isLoading ? (
              <LoadingSpinner />
            ) : todaySessions.length === 0 ? (
              <EmptyState
                title="Nothing on today"
                description="No sessions scheduled or logged for today."
              />
            ) : (
              <ul className="space-y-2">
                {todaySessions.map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ReferralTriageRow({ referral }: { referral: ReferralDto }) {
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium text-gray-900">
          {studentDisplay(referral.studentFirstName, referral.studentLastName)}
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            REFERRAL_PRIORITY_PILL[referral.priority],
          )}
        >
          {REFERRAL_PRIORITY_LABELS[referral.priority]}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            REFERRAL_STATUS_PILL[referral.status],
          )}
        >
          {REFERRAL_STATUS_LABELS[referral.status]}
        </span>
        {referral.referralTypeName ? <span>· {referral.referralTypeName}</span> : null}
        <span>· {formatRelative(referral.createdAt)}</span>
      </div>
      <div className="mt-2 line-clamp-2 text-xs text-gray-600">{referral.reason}</div>
    </li>
  );
}

function SessionRow({ session }: { session: SessionDto }) {
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium text-gray-900">
          {session.primaryStudentName ?? SESSION_TYPE_LABELS[session.sessionType] + ' session'}
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            SESSION_STATUS_PILL[session.status],
          )}
        >
          {SESSION_STATUS_LABELS[session.status]}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            SESSION_TYPE_PILL[session.sessionType],
          )}
        >
          {SESSION_TYPE_LABELS[session.sessionType]}
        </span>
        {session.durationMinutes ? <span>· {session.durationMinutes} min</span> : null}
        {session.counselorName ? <span>· {session.counselorName}</span> : null}
      </div>
    </li>
  );
}
