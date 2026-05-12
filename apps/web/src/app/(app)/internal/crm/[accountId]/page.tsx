'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ACCOUNT_STATUSES,
  AccountStatus,
  RISK_PILL,
  STATUS_PILL,
  formatCents,
  useCrmAccountTimeline,
  usePatchOnboardingTask,
  useRecomputeHealth,
  useTransitionAccountStatus,
} from '@/hooks/use-crm';

/**
 * P2-21a — Internal CRM account detail.
 *
 * Renders the full account timeline (interactions, health-score
 * history, onboarding checklist, subscriptions, renewals) plus the
 * lifecycle transition bar that drives AccountService.transitionStatus
 * server-side. The ONBOARDING > ACTIVE flip happens automatically
 * once the onboarding checklist hits all-non-PENDING — this UI just
 * surfaces task progress + manual override of individual tasks.
 */
export default function AccountDetailPage() {
  const params = useParams<{ accountId: string }>();
  const accountId = params?.accountId;
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['crm-001:read']);
  const canWrite = !!user && hasAnyPermission(user, ['crm-001:write']);

  const timeline = useCrmAccountTimeline(accountId);
  const transition = useTransitionAccountStatus(accountId ?? '');
  const recompute = useRecomputeHealth(accountId ?? '');
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Account" />
        <EmptyState
          title="Internal CRM — Platform Admin only"
          description="This dashboard is internal to CampusOS-the-company."
        />
      </div>
    );
  }

  if (timeline.isLoading || !timeline.data) {
    return (
      <div className="mx-auto max-w-5xl">
        <PageHeader title="Loading account…" />
        <LoadingSpinner />
      </div>
    );
  }

  const { account, interactions, healthScores, onboardingChecklist, subscriptions, renewals } =
    timeline.data;
  const latestHealth = healthScores[0];

  const handleTransition = async (target: AccountStatus): Promise<void> => {
    setError(null);
    try {
      await transition.mutateAsync({ status: target });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={account.accountName}
        description={`Account ${account.id.slice(0, 8)} · Status: ${account.status}`}
      />

      <nav className="text-sm">
        <Link href="/internal/crm" className="text-campus-700 hover:underline">
          ← Back to CRM dashboard
        </Link>
      </nav>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          {error}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Status">
          <span
            className={`rounded px-2 py-0.5 text-sm font-medium ${STATUS_PILL[account.status]}`}
          >
            {account.status}
          </span>
        </Card>
        <Card label="Billing email">
          <span className="text-sm text-gray-700">{account.billingEmail}</span>
        </Card>
        <Card label="Renewal">
          <span className="text-sm text-gray-700">
            {account.renewalDate ? new Date(account.renewalDate).toLocaleDateString() : '—'}
          </span>
        </Card>
        <Card label="Health">
          {latestHealth ? (
            <span className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${RISK_PILL[latestHealth.riskLevel]}`}
              >
                {latestHealth.riskLevel}
              </span>
              <span className="text-sm text-gray-700">{latestHealth.overallScore}/100</span>
            </span>
          ) : (
            <span className="text-sm text-gray-400">Not scored</span>
          )}
        </Card>
      </section>

      {canWrite && (
        <section className="rounded-card border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Lifecycle transition</h2>
          <div className="flex flex-wrap items-center gap-2">
            {ACCOUNT_STATUSES.map((target) => (
              <button
                key={target}
                type="button"
                disabled={target === account.status || transition.isPending}
                onClick={() => handleTransition(target)}
                className={`rounded border px-3 py-1 text-sm transition ${
                  target === account.status
                    ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400'
                    : 'border-campus-700 text-campus-700 hover:bg-campus-50'
                }`}
              >
                {target}
              </button>
            ))}
            <button
              type="button"
              onClick={() => recompute.mutate()}
              disabled={recompute.isPending}
              className="ml-auto rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:border-campus-700 hover:text-campus-700"
            >
              Recompute health
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            PILOT requires <code>signed_date</code>. ONBOARDING → ACTIVE auto-flips when the
            onboarding checklist hits COMPLETED.
          </p>
        </section>
      )}

      <section className="rounded-card border bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Subscriptions</h2>
        {subscriptions.length === 0 ? (
          <EmptyState
            title="No subscriptions yet."
            description="Create one when the customer signs."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="pb-2">Plan</th>
                <th className="pb-2">Interval</th>
                <th className="pb-2">MRR</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Period</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id} className="border-b border-gray-100">
                  <td className="py-2 font-medium text-gray-900">{s.planName}</td>
                  <td className="py-2 text-gray-600">{s.billingInterval}</td>
                  <td className="py-2 text-gray-900">{formatCents(s.mrrCents)}</td>
                  <td className="py-2 text-gray-600">{s.status}</td>
                  <td className="py-2 text-gray-500">
                    {s.currentPeriodStart && s.currentPeriodEnd
                      ? `${s.currentPeriodStart} → ${s.currentPeriodEnd}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-card border bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Onboarding</h2>
        {!onboardingChecklist ? (
          <EmptyState
            title="No onboarding checklist initialised."
            description="POST /internal/crm/accounts/:id/onboarding to start the default 8-task template."
          />
        ) : (
          <OnboardingPanel
            checklist={onboardingChecklist}
            canWrite={canWrite}
            onPatched={() => timeline.refetch()}
          />
        )}
      </section>

      <section className="rounded-card border bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Renewals</h2>
        {renewals.length === 0 ? (
          <EmptyState
            title="No renewals tracked yet."
            description="Add one as the renewal date approaches."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="pb-2">Date</th>
                <th className="pb-2">Stage</th>
                <th className="pb-2">Current MRR</th>
                <th className="pb-2">Proposed</th>
                <th className="pb-2">Risk factors</th>
              </tr>
            </thead>
            <tbody>
              {renewals.map((r) => (
                <tr key={r.id} className="border-b border-gray-100">
                  <td className="py-2 text-gray-700">
                    {new Date(r.renewalDate).toLocaleDateString()}
                  </td>
                  <td className="py-2 text-gray-700">{r.stage}</td>
                  <td className="py-2 text-gray-900">{formatCents(r.currentMrrCents)}</td>
                  <td className="py-2 text-gray-700">
                    {r.proposedMrrCents ? formatCents(r.proposedMrrCents) : '—'}
                  </td>
                  <td className="py-2 text-xs text-gray-600">
                    {r.riskFactors.length > 0 ? r.riskFactors.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-card border bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Health-score history</h2>
        {healthScores.length === 0 ? (
          <EmptyState
            title="No health scores yet."
            description="The weekly worker will populate this."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="pb-2">Date</th>
                <th className="pb-2">Overall</th>
                <th className="pb-2">Adoption</th>
                <th className="pb-2">Engagement</th>
                <th className="pb-2">Support</th>
                <th className="pb-2">Risk</th>
              </tr>
            </thead>
            <tbody>
              {healthScores.map((s) => (
                <tr key={s.id} className="border-b border-gray-100">
                  <td className="py-2 text-gray-700">{s.scoreDate}</td>
                  <td className="py-2 text-gray-900">{s.overallScore}</td>
                  <td className="py-2 text-gray-700">{s.adoptionScore ?? '—'}</td>
                  <td className="py-2 text-gray-700">{s.engagementScore ?? '—'}</td>
                  <td className="py-2 text-gray-700">{s.supportTicketScore ?? '—'}</td>
                  <td className="py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${RISK_PILL[s.riskLevel]}`}
                    >
                      {s.riskLevel}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-card border bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Interactions</h2>
        {interactions.length === 0 ? (
          <EmptyState
            title="No interactions logged."
            description="Use the API to log calls, emails, demos, and support touch-points."
          />
        ) : (
          <ul className="space-y-3 text-sm">
            {interactions.map((i) => (
              <li key={i.id} className="rounded border border-gray-100 bg-gray-50 p-3">
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-gray-900">{i.subject}</span>
                  <span className="text-xs text-gray-500">
                    {new Date(i.interactionAt).toLocaleString()} · {i.interactionType}
                  </span>
                </div>
                {i.notes && <p className="text-gray-700">{i.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function OnboardingPanel({
  checklist,
  canWrite,
  onPatched,
}: {
  checklist: NonNullable<
    NonNullable<ReturnType<typeof useCrmAccountTimeline>['data']>['onboardingChecklist']
  >;
  canWrite: boolean;
  onPatched: () => void;
}) {
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-gray-700">
          Status: <span className="font-medium">{checklist.status}</span>
        </span>
        <span className="text-xs text-gray-500">
          {checklist.taskCounts.completed} / {checklist.taskCounts.total} completed (
          {checklist.taskCounts.pending} pending · {checklist.taskCounts.skipped} skipped)
        </span>
      </header>
      <ul className="space-y-2 text-sm">
        {checklist.tasks.map((t) => (
          <TaskRow key={t.id} task={t} canWrite={canWrite} onPatched={onPatched} />
        ))}
      </ul>
    </div>
  );
}

function TaskRow({
  task,
  canWrite,
  onPatched,
}: {
  task: NonNullable<
    NonNullable<ReturnType<typeof useCrmAccountTimeline>['data']>['onboardingChecklist']
  >['tasks'][number];
  canWrite: boolean;
  onPatched: () => void;
}) {
  const patch = usePatchOnboardingTask(task.id);
  const isTerminal = task.status === 'COMPLETED' || task.status === 'SKIPPED';

  return (
    <li className="flex items-center justify-between rounded border border-gray-100 bg-white px-3 py-2">
      <div>
        <div className="font-medium text-gray-900">
          <span className="mr-2 text-xs text-gray-400">{task.sortOrder + 1}.</span>
          {task.taskName}
        </div>
        <div className="mt-0.5 text-xs text-gray-500">
          {task.taskCategory} ·{' '}
          <span
            className={
              task.status === 'COMPLETED'
                ? 'text-emerald-700'
                : task.status === 'SKIPPED'
                  ? 'text-gray-500'
                  : 'text-amber-700'
            }
          >
            {task.status}
          </span>
        </div>
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-1">
          {!isTerminal && (
            <>
              <button
                type="button"
                disabled={patch.isPending}
                onClick={async () => {
                  await patch.mutateAsync({ status: 'COMPLETED' });
                  onPatched();
                }}
                className="rounded border border-emerald-700 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50"
              >
                Complete
              </button>
              <button
                type="button"
                disabled={patch.isPending}
                onClick={async () => {
                  await patch.mutateAsync({ status: 'SKIPPED' });
                  onPatched();
                }}
                className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
              >
                Skip
              </button>
            </>
          )}
          {isTerminal && (
            <button
              type="button"
              disabled={patch.isPending}
              onClick={async () => {
                await patch.mutateAsync({ status: 'PENDING' });
                onPatched();
              }}
              className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              Re-open
            </button>
          )}
        </div>
      )}
    </li>
  );
}
