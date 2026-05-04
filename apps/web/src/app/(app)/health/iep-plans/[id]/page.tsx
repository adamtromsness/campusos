'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useCreateAccommodation,
  useCreateGoalProgress,
  useCreateIepGoal,
  useCreateIepService,
  useDeleteAccommodation,
  useIepPlan,
  useUpdateAccommodation,
  useUpdateIepGoal,
  useUpdateIepPlan,
} from '@/hooks/use-health';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  IEP_DELIVERY_METHOD_LABELS,
  IEP_GOAL_STATUSES,
  IEP_GOAL_STATUS_LABELS,
  IEP_GOAL_STATUS_PILL,
  IEP_PLAN_STATUSES,
  IEP_PLAN_STATUS_LABELS,
  IEP_PLAN_STATUS_PILL,
  IEP_PLAN_TYPE_LABELS,
  formatDate,
} from '@/lib/health-format';
import type {
  CreateAccommodationPayload,
  CreateIepGoalPayload,
  CreateIepServicePayload,
  IepAccommodationDto,
  IepAppliesTo,
  IepDeliveryMethod,
  IepGoalDto,
  IepPlanDto,
} from '@/lib/types';

/* /health/iep-plans/[id] — full IEP / 504 editor.
 * Resolves the plan by id via the existing studentId-keyed
 * useIepPlan hook (the controller exposes /students/:studentId/iep
 * but not /iep-plans/:id read; the plan id and studentId are both
 * surfaced together in the response so we read by studentId). The
 * editor link in the student health record + bell deep-links carry
 * the studentId in the query string.
 */

export default function IepEditorPage() {
  const params = useParams<{ id: string }>();
  const planId = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['hlt-001:read']);

  // The plan endpoint is keyed on studentId. The editor page is
  // navigated to with a `?studentId=` query param. Fall back to a
  // plan-id lookup on the access log if missing.
  const studentId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('studentId')
      : null;

  const plan = useIepPlan(studentId, canRead);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader title="IEP / 504 Plan" />
        <EmptyState
          title="Not available"
          description="Your role does not include health-record read access."
        />
      </div>
    );
  }

  if (!studentId) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader title="IEP / 504 Plan" />
        <EmptyState
          title="Missing student context"
          description="Open this plan from the student's health record to load it."
        />
      </div>
    );
  }

  if (plan.isLoading) return <LoadingSpinner />;
  if (!plan.data) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader title="IEP / 504 Plan" />
        <EmptyState title="No plan on file" description="No active or draft plan was found." />
      </div>
    );
  }
  if (plan.data.id !== planId) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader title="IEP / 504 Plan" />
        <EmptyState
          title="Plan id mismatch"
          description="The plan in the URL does not match this student's current plan."
        />
      </div>
    );
  }

  return <IepEditor plan={plan.data} />;
}

// ─── Editor body ───────────────────────────────────────────

function IepEditor({ plan }: { plan: IepPlanDto }) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['hlt-001:admin', 'sch-001:admin']);
  const canWrite = !!user && hasAnyPermission(user, ['hlt-001:write']);
  const canEdit = isAdmin || canWrite;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title={`${IEP_PLAN_TYPE_LABELS[plan.planType]} for ${
          plan.studentFirstName ?? ''
        } ${plan.studentLastName ?? ''}`.trim()}
        description="Editable plan with goals, services, and accommodations. Accommodation changes sync to teachers via the Cycle 10 ADR-030 read model."
        actions={
          <Link
            href={`/health/students/${plan.studentId}`}
            className="text-sm font-medium text-campus-600 hover:text-campus-700"
          >
            ← Health record
          </Link>
        }
      />

      <PlanHeaderCard plan={plan} canEdit={canEdit} />
      <GoalsSection plan={plan} canEdit={canEdit} />
      <ServicesSection plan={plan} canEdit={canEdit} />
      <AccommodationsSection plan={plan} canEdit={canEdit} />
    </div>
  );
}

function PlanHeaderCard({ plan, canEdit }: { plan: IepPlanDto; canEdit: boolean }) {
  const { toast } = useToast();
  const update = useUpdateIepPlan(plan.id);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">Plan details</h2>
        <span
          className={
            'rounded-full px-2 py-0.5 text-xs font-medium ' + IEP_PLAN_STATUS_PILL[plan.status]
          }
        >
          {IEP_PLAN_STATUS_LABELS[plan.status]}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Type</dt>
          <dd className="mt-1 text-gray-900">{IEP_PLAN_TYPE_LABELS[plan.planType]}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Case manager
          </dt>
          <dd className="mt-1 text-gray-900">{plan.caseManagerName ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Start date</dt>
          <dd className="mt-1 text-gray-900">
            {plan.startDate ? formatDate(plan.startDate) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Review date</dt>
          <dd className="mt-1 text-gray-900">
            {plan.reviewDate ? formatDate(plan.reviewDate) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">End date</dt>
          <dd className="mt-1 text-gray-900">{plan.endDate ? formatDate(plan.endDate) : '—'}</dd>
        </div>
      </dl>
      {canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {IEP_PLAN_STATUSES.filter((s) => s !== plan.status).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() =>
                update.mutate(
                  { status: s },
                  {
                    onSuccess: () => toast(`Plan moved to ${IEP_PLAN_STATUS_LABELS[s]}`, 'success'),
                    onError: (e) => toast((e as Error).message, 'error'),
                  },
                )
              }
              disabled={update.isPending}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              Move to {IEP_PLAN_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ─── Goals ─────────────────────────────────────────────────

function GoalsSection({ plan, canEdit }: { plan: IepPlanDto; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 p-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Goals</h2>
          <p className="text-sm text-gray-500">Measurable outcomes with progress tracking.</p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Add goal
          </button>
        ) : null}
      </header>
      <div className="p-4">
        {plan.goals.length === 0 ? (
          <EmptyState title="No goals yet" />
        ) : (
          <ul className="space-y-3">
            {plan.goals.map((g) => (
              <GoalRow key={g.id} goal={g} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </div>
      {adding ? <AddGoalModal planId={plan.id} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

function GoalRow({ goal, canEdit }: { goal: IepGoalDto; canEdit: boolean }) {
  const { toast } = useToast();
  const updateGoal = useUpdateIepGoal(goal.id);
  const [progressOpen, setProgressOpen] = useState(false);

  return (
    <li className="rounded-md border border-gray-100 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <span
          className={
            'rounded-full px-2 py-0.5 text-xs font-medium ' + IEP_GOAL_STATUS_PILL[goal.status]
          }
        >
          {IEP_GOAL_STATUS_LABELS[goal.status]}
        </span>
        {goal.goalArea ? (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {goal.goalArea}
          </span>
        ) : null}
        <p className="flex-1 text-sm font-medium text-gray-900">{goal.goalText}</p>
      </div>
      {goal.measurementCriteria ? (
        <p className="mt-1 text-xs text-gray-600">Criteria: {goal.measurementCriteria}</p>
      ) : null}
      <div className="mt-2 grid grid-cols-3 gap-3 text-xs text-gray-600 sm:flex sm:gap-6">
        {goal.baseline ? <span>Baseline: {goal.baseline}</span> : null}
        {goal.currentValue ? <span>Current: {goal.currentValue}</span> : null}
        {goal.targetValue ? <span>Target: {goal.targetValue}</span> : null}
      </div>

      {goal.progress.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-campus-700">
            {goal.progress.length} progress {goal.progress.length === 1 ? 'entry' : 'entries'}
          </summary>
          <ul className="mt-2 space-y-1">
            {goal.progress.map((p) => (
              <li key={p.id} className="rounded bg-gray-50 p-2">
                <p className="text-gray-700">{p.observationNotes ?? p.progressValue ?? '—'}</p>
                <p className="text-gray-500">
                  {p.recordedByName ?? '—'} · {formatDate(p.recordedAt)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canEdit ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setProgressOpen(true)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Add progress
          </button>
          {IEP_GOAL_STATUSES.filter((s) => s !== goal.status).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() =>
                updateGoal.mutate(
                  { status: s },
                  {
                    onSuccess: () => toast(`Goal moved to ${IEP_GOAL_STATUS_LABELS[s]}`, 'success'),
                    onError: (e) => toast((e as Error).message, 'error'),
                  },
                )
              }
              disabled={updateGoal.isPending}
              className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {IEP_GOAL_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      ) : null}

      {progressOpen ? (
        <AddProgressModal goalId={goal.id} onClose={() => setProgressOpen(false)} />
      ) : null}
    </li>
  );
}

function AddGoalModal({ planId, onClose }: { planId: string; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateIepGoal(planId);
  const [draft, setDraft] = useState<CreateIepGoalPayload>({
    goalText: '',
    measurementCriteria: '',
    baseline: '',
    targetValue: '',
    currentValue: '',
    goalArea: '',
  });
  return (
    <Modal open={true} title="Add goal" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            {
              goalText: draft.goalText.trim(),
              measurementCriteria: draft.measurementCriteria || null,
              baseline: draft.baseline || null,
              targetValue: draft.targetValue || null,
              currentValue: draft.currentValue || null,
              goalArea: draft.goalArea || null,
            },
            {
              onSuccess: () => {
                toast('Goal added', 'success');
                onClose();
              },
              onError: (e) => toast((e as Error).message, 'error'),
            },
          );
        }}
      >
        <Field label="Goal text" required>
          <textarea
            required
            rows={3}
            value={draft.goalText}
            onChange={(e) => setDraft({ ...draft, goalText: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Goal area">
          <input
            type="text"
            value={draft.goalArea ?? ''}
            onChange={(e) => setDraft({ ...draft, goalArea: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="Academic / Behavioural / Speech / OT…"
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Baseline">
            <input
              type="text"
              value={draft.baseline ?? ''}
              onChange={(e) => setDraft({ ...draft, baseline: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Current">
            <input
              type="text"
              value={draft.currentValue ?? ''}
              onChange={(e) => setDraft({ ...draft, currentValue: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Target">
            <input
              type="text"
              value={draft.targetValue ?? ''}
              onChange={(e) => setDraft({ ...draft, targetValue: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Measurement criteria">
          <textarea
            rows={2}
            value={draft.measurementCriteria ?? ''}
            onChange={(e) => setDraft({ ...draft, measurementCriteria: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <ModalFooter onClose={onClose} submitting={create.isPending} submitLabel="Add goal" />
      </form>
    </Modal>
  );
}

function AddProgressModal({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateGoalProgress(goalId);
  const [progressValue, setProgressValue] = useState('');
  const [observationNotes, setObservationNotes] = useState('');
  return (
    <Modal open={true} title="Add progress entry" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            {
              progressValue: progressValue || null,
              observationNotes: observationNotes || null,
            },
            {
              onSuccess: () => {
                toast('Progress recorded', 'success');
                onClose();
              },
              onError: (e) => toast((e as Error).message, 'error'),
            },
          );
        }}
      >
        <Field label="Progress value">
          <input
            type="text"
            value={progressValue}
            onChange={(e) => setProgressValue(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="e.g. 80% / 12 of 15 / Improved"
          />
        </Field>
        <Field label="Observation notes">
          <textarea
            rows={3}
            value={observationNotes}
            onChange={(e) => setObservationNotes(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <ModalFooter onClose={onClose} submitting={create.isPending} submitLabel="Save" />
      </form>
    </Modal>
  );
}

// ─── Services ──────────────────────────────────────────────

function ServicesSection({ plan, canEdit }: { plan: IepPlanDto; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 p-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Services</h2>
          <p className="text-sm text-gray-500">
            Pull-out / push-in / consultative supports delivered to the student.
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Add service
          </button>
        ) : null}
      </header>
      <div className="p-4">
        {plan.services.length === 0 ? (
          <EmptyState title="No services yet" />
        ) : (
          <ul className="space-y-2 text-sm">
            {plan.services.map((s) => (
              <li key={s.id} className="rounded-md border border-gray-100 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-gray-900">{s.serviceType}</span>
                  <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                    {IEP_DELIVERY_METHOD_LABELS[s.deliveryMethod]}
                  </span>
                  {s.minutesPerSession ? (
                    <span className="text-xs text-gray-500">{s.minutesPerSession} min/session</span>
                  ) : null}
                </div>
                {s.providerName ? (
                  <p className="mt-1 text-xs text-gray-600">Provider: {s.providerName}</p>
                ) : null}
                {s.frequency ? (
                  <p className="text-xs text-gray-600">Frequency: {s.frequency}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {adding ? <AddServiceModal planId={plan.id} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

function AddServiceModal({ planId, onClose }: { planId: string; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateIepService(planId);
  const [draft, setDraft] = useState<CreateIepServicePayload>({
    serviceType: '',
    providerName: '',
    frequency: '',
    minutesPerSession: null,
    deliveryMethod: 'PULL_OUT',
  });
  return (
    <Modal open={true} title="Add service" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            {
              serviceType: draft.serviceType.trim(),
              providerName: draft.providerName || null,
              frequency: draft.frequency || null,
              minutesPerSession: draft.minutesPerSession,
              deliveryMethod: draft.deliveryMethod,
            },
            {
              onSuccess: () => {
                toast('Service added', 'success');
                onClose();
              },
              onError: (e) => toast((e as Error).message, 'error'),
            },
          );
        }}
      >
        <Field label="Service type" required>
          <input
            required
            type="text"
            value={draft.serviceType}
            onChange={(e) => setDraft({ ...draft, serviceType: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="e.g. Speech therapy"
          />
        </Field>
        <Field label="Provider">
          <input
            type="text"
            value={draft.providerName ?? ''}
            onChange={(e) => setDraft({ ...draft, providerName: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Frequency">
            <input
              type="text"
              value={draft.frequency ?? ''}
              onChange={(e) => setDraft({ ...draft, frequency: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="e.g. 2× weekly"
            />
          </Field>
          <Field label="Minutes / session">
            <input
              type="number"
              min={1}
              value={draft.minutesPerSession ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  minutesPerSession: e.target.value ? Number(e.target.value) : null,
                })
              }
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Delivery method" required>
          <select
            value={draft.deliveryMethod}
            onChange={(e) =>
              setDraft({ ...draft, deliveryMethod: e.target.value as IepDeliveryMethod })
            }
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="PULL_OUT">{IEP_DELIVERY_METHOD_LABELS.PULL_OUT}</option>
            <option value="PUSH_IN">{IEP_DELIVERY_METHOD_LABELS.PUSH_IN}</option>
            <option value="CONSULT">{IEP_DELIVERY_METHOD_LABELS.CONSULT}</option>
          </select>
        </Field>
        <ModalFooter onClose={onClose} submitting={create.isPending} submitLabel="Add service" />
      </form>
    </Modal>
  );
}

// ─── Accommodations ────────────────────────────────────────

function AccommodationsSection({ plan, canEdit }: { plan: IepPlanDto; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  const sorted = useMemo(
    () =>
      plan.accommodations
        .slice()
        .sort((a, b) => a.accommodationType.localeCompare(b.accommodationType)),
    [plan.accommodations],
  );
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 p-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Accommodations</h2>
          <p className="text-sm text-gray-500">
            Sync to teachers via the ADR-030 read model on every save.
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Add accommodation
          </button>
        ) : null}
      </header>
      <div className="p-4">
        {sorted.length === 0 ? (
          <EmptyState title="No accommodations yet" />
        ) : (
          <ul className="space-y-2">
            {sorted.map((a) => (
              <AccommodationRow key={a.id} accommodation={a} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </div>
      {adding ? <AccommodationModal planId={plan.id} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

function AccommodationRow({
  accommodation,
  canEdit,
}: {
  accommodation: IepAccommodationDto;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const remove = useDeleteAccommodation(accommodation.id);
  return (
    <li className="rounded-md border border-gray-100 p-3 text-sm">
      <div className="flex flex-wrap items-start gap-2">
        <span className="font-semibold text-gray-900">{accommodation.accommodationType}</span>
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
          {appliesToLabel(accommodation.appliesTo)}
        </span>
        {accommodation.specificAssignmentTypes &&
        accommodation.specificAssignmentTypes.length > 0 ? (
          <span className="text-xs text-gray-500">
            ({accommodation.specificAssignmentTypes.join(', ')})
          </span>
        ) : null}
      </div>
      {accommodation.description ? (
        <p className="mt-1 text-xs text-gray-700">{accommodation.description}</p>
      ) : null}
      {accommodation.effectiveFrom ? (
        <p className="mt-1 text-xs text-gray-500">
          Effective {formatDate(accommodation.effectiveFrom)}
          {accommodation.effectiveTo ? ' – ' + formatDate(accommodation.effectiveTo) : ''}
        </p>
      ) : null}
      {canEdit ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                !window.confirm('Remove this accommodation? Teachers will lose access immediately.')
              )
                return;
              remove.mutate(undefined, {
                onSuccess: () => toast('Accommodation removed', 'success'),
                onError: (e) => toast((e as Error).message, 'error'),
              });
            }}
            disabled={remove.isPending}
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-60"
          >
            Remove
          </button>
        </div>
      ) : null}
      {editing ? (
        <AccommodationModal
          planId={accommodation.iepPlanId}
          existing={accommodation}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </li>
  );
}

function AccommodationModal({
  planId,
  existing,
  onClose,
}: {
  planId: string;
  existing?: IepAccommodationDto;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateAccommodation(planId);
  const update = useUpdateAccommodation(existing?.id ?? '');
  const isEdit = !!existing;
  const [draft, setDraft] = useState<CreateAccommodationPayload>({
    accommodationType: existing?.accommodationType ?? '',
    description: existing?.description ?? '',
    appliesTo: existing?.appliesTo ?? 'ALL_ASSESSMENTS',
    specificAssignmentTypes: existing?.specificAssignmentTypes ?? null,
    effectiveFrom: existing?.effectiveFrom ?? '',
    effectiveTo: existing?.effectiveTo ?? '',
  });
  const [specificText, setSpecificText] = useState(
    (existing?.specificAssignmentTypes ?? []).join(', '),
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const specific =
      draft.appliesTo === 'SPECIFIC'
        ? specificText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
    if (draft.appliesTo === 'SPECIFIC' && (!specific || specific.length === 0)) {
      toast('SPECIFIC scope requires at least one assignment type', 'error');
      return;
    }
    const payload: CreateAccommodationPayload = {
      accommodationType: draft.accommodationType.trim(),
      description: draft.description || null,
      appliesTo: draft.appliesTo,
      specificAssignmentTypes: specific,
      effectiveFrom: draft.effectiveFrom || null,
      effectiveTo: draft.effectiveTo || null,
    };
    const onResult = {
      onSuccess: () => {
        toast(isEdit ? 'Accommodation updated' : 'Accommodation added', 'success');
        onClose();
      },
      onError: (err: Error) => toast(err.message, 'error'),
    };
    if (isEdit) {
      update.mutate(payload, onResult);
    } else {
      create.mutate(payload, onResult);
    }
  };

  return (
    <Modal
      open={true}
      title={isEdit ? 'Edit accommodation' : 'Add accommodation'}
      onClose={onClose}
    >
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Accommodation type" required>
          <input
            required
            type="text"
            value={draft.accommodationType}
            onChange={(e) => setDraft({ ...draft, accommodationType: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="e.g. Extended time"
          />
        </Field>
        <Field label="Description">
          <textarea
            rows={2}
            value={draft.description ?? ''}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Applies to" required>
          <select
            value={draft.appliesTo}
            onChange={(e) => setDraft({ ...draft, appliesTo: e.target.value as IepAppliesTo })}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="ALL_ASSESSMENTS">All assessments</option>
            <option value="ALL_ASSIGNMENTS">All assignments</option>
            <option value="SPECIFIC">Specific assignment types</option>
          </select>
        </Field>
        {draft.appliesTo === 'SPECIFIC' ? (
          <Field label="Specific assignment types (comma-separated)" required>
            <input
              type="text"
              value={specificText}
              onChange={(e) => setSpecificText(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="e.g. essay, lab-report"
            />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Effective from">
            <input
              type="date"
              value={draft.effectiveFrom ?? ''}
              onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Effective to">
            <input
              type="date"
              value={draft.effectiveTo ?? ''}
              onChange={(e) => setDraft({ ...draft, effectiveTo: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <ModalFooter
          onClose={onClose}
          submitting={create.isPending || update.isPending}
          submitLabel={isEdit ? 'Save' : 'Add accommodation'}
        />
      </form>
    </Modal>
  );
}

// ─── shared ────────────────────────────────────────────────

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
        {label} {required ? <span className="text-rose-600">*</span> : null}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ModalFooter({
  onClose,
  submitting,
  submitLabel,
}: {
  onClose: () => void;
  submitting: boolean;
  submitLabel: string;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button
        type="button"
        onClick={onClose}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
      >
        {submitting ? 'Saving…' : submitLabel}
      </button>
    </div>
  );
}

function appliesToLabel(s: IepAppliesTo): string {
  switch (s) {
    case 'ALL_ASSESSMENTS':
      return 'All assessments';
    case 'ALL_ASSIGNMENTS':
      return 'All assignments';
    case 'SPECIFIC':
      return 'Specific';
  }
}
