'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useStudent } from '@/hooks/use-children';
import {
  useBehaviorPlans,
  useCreateBehaviorPlan,
  useDisciplineIncidents,
} from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_STATUS_PILL,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_PILL,
  PLAN_TYPE_LABELS,
  PLAN_TYPES,
  SEVERITIES,
  SEVERITY_LABELS,
  SEVERITY_PILL,
  formatIncidentDate,
  isIncidentLive,
} from '@/lib/discipline-format';
import type { BehaviorPlanType, Severity } from '@/lib/types';

function todayPlus30Iso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

export default function StudentBehaviourSummaryPage() {
  const params = useParams<{ id: string }>();
  const studentId = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['beh-001:read']);
  const canWrite = !!user && hasAnyPermission(user, ['beh-002:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['beh-001:admin', 'sch-001:admin']);

  const student = useStudent(studentId);
  const incidents = useDisciplineIncidents({ studentId, limit: 200 }, !!studentId && canRead);
  const plans = useBehaviorPlans({ studentId }, !!studentId && canRead);

  const [createOpen, setCreateOpen] = useState(false);

  const recentIncidents = useMemo(() => {
    return (incidents.data ?? [])
      .slice()
      .sort((a, b) => b.incidentDate.localeCompare(a.incidentDate))
      .slice(0, 5);
  }, [incidents.data]);

  const incidentsBySeverity = useMemo(() => {
    const counts: Record<Severity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const inc of incidents.data ?? []) {
      if (isIncidentLive(inc.status)) counts[inc.severity]++;
    }
    return counts;
  }, [incidents.data]);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Student behaviour" />
        <EmptyState
          title="Access required"
          description="You need behaviour-read access to view this page."
        />
      </div>
    );
  }

  const studentLabel = student.data
    ? student.data.fullName + (student.data.gradeLevel ? ' · Grade ' + student.data.gradeLevel : '')
    : 'Loading…';

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={'Behaviour · ' + (student.data?.fullName ?? '…')}
        description={studentLabel}
        actions={
          <Link href="/behaviour" className="text-sm text-gray-500 hover:text-gray-700">
            ← Queue
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900">Live incidents</h3>
            <Link
              href={'/behaviour?student=' + studentId}
              className="text-xs text-campus-700 hover:underline"
            >
              All incidents →
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-4 gap-3">
            {SEVERITIES.map((sev) => (
              <div key={sev} className={cn('rounded-lg p-3 text-center', SEVERITY_PILL[sev])}>
                <dt className="text-[10px] uppercase tracking-wide opacity-80">
                  {SEVERITY_LABELS[sev]}
                </dt>
                <dd className="mt-1 text-2xl font-semibold">{incidentsBySeverity[sev]}</dd>
              </div>
            ))}
          </dl>

          <h4 className="mt-5 text-sm font-medium text-gray-900">Recent incidents</h4>
          {incidents.isLoading ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : recentIncidents.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">No incidents on file.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {recentIncidents.map((i) => (
                <li key={i.id} className="rounded-md border border-gray-200 bg-gray-50 p-2 text-sm">
                  <Link href={'/behaviour/' + i.id} className="block hover:underline">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          SEVERITY_PILL[i.severity],
                        )}
                      >
                        {SEVERITY_LABELS[i.severity]}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          INCIDENT_STATUS_PILL[i.status],
                        )}
                      >
                        {INCIDENT_STATUS_LABELS[i.status]}
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatIncidentDate(i.incidentDate)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-900">{i.categoryName}</p>
                    <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{i.description}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900">Behaviour plans</h3>
            {canWrite && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="rounded-lg bg-campus-700 px-3 py-1 text-sm font-medium text-white hover:bg-campus-800"
              >
                Create plan
              </button>
            )}
          </div>

          {plans.isLoading ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : (plans.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No behaviour plans on file.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {(plans.data ?? []).map((p) => (
                <li key={p.id} className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
                  <Link href={'/behavior-plans/' + p.id} className="block hover:underline">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">
                        {PLAN_TYPE_LABELS[p.planType]}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          PLAN_STATUS_PILL[p.status],
                        )}
                      >
                        {PLAN_STATUS_LABELS[p.status]}
                      </span>
                      <span className="text-xs text-gray-500">
                        Review by {formatIncidentDate(p.reviewDate)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {p.goals.length} goal{p.goals.length === 1 ? '' : 's'} · {p.feedback.length}{' '}
                      feedback row{p.feedback.length === 1 ? '' : 's'}
                      {p.createdByName ? ' · Created by ' + p.createdByName : ''}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {createOpen && (
        <CreatePlanModal
          studentId={studentId}
          isAdmin={isAdmin}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

function CreatePlanModal({
  studentId,
  isAdmin,
  onClose,
}: {
  studentId: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const create = useCreateBehaviorPlan();

  const [planType, setBehaviorPlanType] = useState<BehaviorPlanType>('BIP');
  const [reviewDate, setReviewDate] = useState<string>(todayPlus30Iso());
  const [target, setTarget] = useState<string>('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const targetBehaviors = target
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (targetBehaviors.length === 0) {
      toast('Add at least one target behaviour', 'error');
      return;
    }
    try {
      const created = await create.mutateAsync({
        studentId,
        planType,
        reviewDate,
        targetBehaviors,
      });
      toast('Plan created (DRAFT)', 'success');
      router.push('/behavior-plans/' + created.id);
    } catch (err: any) {
      toast('Could not create plan: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create behaviour plan"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-plan-form"
            disabled={create.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {create.isPending ? 'Saving…' : 'Create as DRAFT'}
          </button>
        </>
      }
    >
      <form id="create-plan-form" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-600">
          The plan will be created as DRAFT. Open it in the editor to add goals, replacement
          behaviours, and reinforcement strategies before activating.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Plan type</label>
            <select
              value={planType}
              onChange={(e) => setBehaviorPlanType(e.target.value as BehaviorPlanType)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              {PLAN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PLAN_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Review date</label>
            <input
              type="date"
              value={reviewDate}
              onChange={(e) => setReviewDate(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Target behaviours <span className="text-gray-400">(one per line, at least one)</span>
          </label>
          <textarea
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            rows={4}
            placeholder="e.g. Verbal confrontation with peers"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
        {!isAdmin && (
          <p className="text-xs text-gray-500">
            Counsellors and admins can author plans. The Step 5 service partial UNIQUE will refuse a
            second ACTIVE plan of the same type for this student — expire the existing one first.
          </p>
        )}
      </form>
    </Modal>
  );
}
