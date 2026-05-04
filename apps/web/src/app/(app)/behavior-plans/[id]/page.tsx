'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useEmployees } from '@/hooks/use-hr';
import {
  useActivateBehaviorPlan,
  useAddGoal,
  useBehaviorPlan,
  useDeleteGoal,
  useExpireBehaviorPlan,
  useRequestFeedback,
  useUpdateBehaviorPlan,
  useUpdateGoal,
} from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  FEEDBACK_EFFECTIVENESS_LABELS,
  FEEDBACK_EFFECTIVENESS_PILL,
  GOAL_PROGRESS_LABELS,
  GOAL_PROGRESS_OPTIONS,
  GOAL_PROGRESS_PILL,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_PILL,
  PLAN_TYPE_LABELS,
  formatIncidentDate,
} from '@/lib/discipline-format';
import type { BIPFeedbackDto, GoalDto } from '@/lib/types';

export default function BehaviorPlanEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['beh-002:read']);
  const canWrite = !!user && hasAnyPermission(user, ['beh-002:write']);
  const { toast } = useToast();

  const plan = useBehaviorPlan(id, canRead);
  const update = useUpdateBehaviorPlan(id);
  const activate = useActivateBehaviorPlan(id);
  const expire = useExpireBehaviorPlan(id);

  const [editStrategiesOpen, setEditStrategiesOpen] = useState(false);
  const [addGoalOpen, setAddGoalOpen] = useState(false);
  const [requestFeedbackOpen, setRequestFeedbackOpen] = useState(false);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Behaviour plan" />
        <EmptyState
          title="Access required"
          description="You need behaviour plan read access to view this page."
        />
      </div>
    );
  }

  if (plan.isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Behaviour plan" />
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      </div>
    );
  }

  if (plan.isError || !plan.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Behaviour plan" />
        <EmptyState
          title="Not found"
          description="This plan does not exist or is not visible to you."
        />
      </div>
    );
  }

  const p = plan.data;
  const isReadOnly = p.status === 'EXPIRED' || !canWrite;
  const studentName =
    p.studentFirstName && p.studentLastName
      ? p.studentFirstName + ' ' + p.studentLastName
      : 'Student';

  async function handleActivate() {
    if (
      !confirm(
        'Activate this plan? This will lock other ACTIVE ' +
          p.planType +
          ' plans on this student out via the partial UNIQUE keystone.',
      )
    )
      return;
    try {
      await activate.mutateAsync();
      toast('Plan activated', 'success');
    } catch (err: any) {
      toast('Could not activate: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  async function handleMarkReview() {
    try {
      await update.mutateAsync({ status: 'REVIEW' });
      toast('Plan marked for review', 'success');
    } catch (err: any) {
      toast('Could not move to review: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  async function handleBackToDraft() {
    try {
      await update.mutateAsync({ status: 'DRAFT' });
      toast('Plan moved back to DRAFT', 'success');
    } catch (err: any) {
      toast('Could not return to draft: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  async function handleExpire() {
    if (
      !confirm(
        'Expire this plan? It will become read-only and the partial UNIQUE on ACTIVE plans will release.',
      )
    )
      return;
    try {
      await expire.mutateAsync();
      toast('Plan expired', 'success');
    } catch (err: any) {
      toast('Could not expire: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title={'Plan · ' + studentName}
        actions={
          <Link
            href={'/students/' + p.studentId + '/behaviour'}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Student
          </Link>
        }
      />
      <p className="-mt-2 text-sm">
        <Link
          href={'/students/' + p.studentId + '/behaviour'}
          className="text-campus-700 hover:underline"
        >
          View student behaviour summary →
        </Link>
      </p>

      {/* Header card */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-violet-200">
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
          {p.studentGradeLevel && (
            <span className="text-xs text-gray-500">Grade {p.studentGradeLevel}</span>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <Field label="Review date" value={formatIncidentDate(p.reviewDate)} />
          <Field label="Created by" value={p.createdByName ?? '—'} />
          <Field
            label="Source incident"
            value={p.sourceIncidentId ? p.sourceIncidentId.slice(0, 8).toUpperCase() : '—'}
            href={p.sourceIncidentId ? '/behaviour/' + p.sourceIncidentId : null}
          />
        </dl>

        {canWrite && p.status !== 'EXPIRED' && (
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
            {p.status === 'DRAFT' && (
              <button
                type="button"
                onClick={handleActivate}
                disabled={activate.isPending}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-gray-300"
              >
                Activate
              </button>
            )}
            {p.status === 'ACTIVE' && (
              <button
                type="button"
                onClick={handleMarkReview}
                disabled={update.isPending}
                className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
              >
                Mark for review
              </button>
            )}
            {p.status === 'REVIEW' && (
              <button
                type="button"
                onClick={handleBackToDraft}
                disabled={update.isPending}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Back to draft
              </button>
            )}
            {(p.status === 'ACTIVE' || p.status === 'REVIEW' || p.status === 'DRAFT') && (
              <button
                type="button"
                onClick={handleExpire}
                disabled={expire.isPending}
                className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
              >
                Expire
              </button>
            )}
          </div>
        )}
      </section>

      {/* Strategies */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Behaviours &amp; strategies</h3>
          {canWrite && p.status !== 'EXPIRED' && (
            <button
              type="button"
              onClick={() => setEditStrategiesOpen(true)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Edit
            </button>
          )}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <ListBlock label="Target behaviours" items={p.targetBehaviors} />
          <ListBlock label="Replacement behaviours" items={p.replacementBehaviors} />
          <ListBlock label="Reinforcement strategies" items={p.reinforcementStrategies} />
        </div>
      </section>

      {/* Goals */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">
            Goals <span className="text-xs font-normal text-gray-500">({p.goals.length})</span>
          </h3>
          {canWrite && p.status !== 'EXPIRED' && (
            <button
              type="button"
              onClick={() => setAddGoalOpen(true)}
              className="rounded-lg bg-campus-700 px-3 py-1 text-sm font-medium text-white hover:bg-campus-800"
            >
              Add goal
            </button>
          )}
        </div>
        {p.goals.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No goals on this plan yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {p.goals.map((g) => (
              <GoalRow key={g.id} goal={g} planId={p.id} canEdit={!isReadOnly} />
            ))}
          </ul>
        )}
      </section>

      {/* Feedback */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">
            Teacher feedback{' '}
            <span className="text-xs font-normal text-gray-500">({p.feedback.length})</span>
          </h3>
          {canWrite && p.status !== 'EXPIRED' && (
            <button
              type="button"
              onClick={() => setRequestFeedbackOpen(true)}
              className="rounded-lg bg-campus-700 px-3 py-1 text-sm font-medium text-white hover:bg-campus-800"
            >
              Request feedback
            </button>
          )}
        </div>
        {p.feedback.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No feedback requests on this plan yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {p.feedback.map((f) => (
              <FeedbackRow key={f.id} feedback={f} />
            ))}
          </ul>
        )}
      </section>

      {editStrategiesOpen && (
        <EditStrategiesModal plan={p} onClose={() => setEditStrategiesOpen(false)} />
      )}
      {addGoalOpen && <AddGoalModal planId={p.id} onClose={() => setAddGoalOpen(false)} />}
      {requestFeedbackOpen && (
        <RequestFeedbackModal planId={p.id} onClose={() => setRequestFeedbackOpen(false)} />
      )}
    </div>
  );
}

function Field({ label, value, href }: { label: string; value: string; href?: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">
        {href ? (
          <Link href={href} className="text-campus-700 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function ListBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">
        {items.length === 0 ? (
          <span className="text-gray-400">—</span>
        ) : (
          <ul className="list-inside list-disc space-y-0.5">
            {items.map((it, idx) => (
              <li key={idx}>{it}</li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

function GoalRow({ goal, planId, canEdit }: { goal: GoalDto; planId: string; canEdit: boolean }) {
  const update = useUpdateGoal(goal.id, planId);
  const remove = useDeleteGoal();
  const { toast } = useToast();

  async function changeProgress(value: GoalDto['progress']) {
    try {
      await update.mutateAsync({ progress: value });
      toast('Goal updated', 'success');
    } catch (err: any) {
      toast('Could not update goal: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  async function handleRemove() {
    if (!confirm('Remove this goal?')) return;
    try {
      await remove.mutateAsync(goal.id);
      toast('Goal removed', 'success');
    } catch (err: any) {
      toast('Could not remove goal: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <li className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-gray-900">{goal.goalText}</p>
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            GOAL_PROGRESS_PILL[goal.progress],
          )}
        >
          {GOAL_PROGRESS_LABELS[goal.progress]}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {goal.baselineFrequency ? 'Baseline: ' + goal.baselineFrequency + ' · ' : ''}
        {goal.targetFrequency ? 'Target: ' + goal.targetFrequency + ' · ' : ''}
        {goal.measurementMethod ? 'Measure: ' + goal.measurementMethod : ''}
      </p>
      {goal.lastAssessedAt && (
        <p className="mt-1 text-xs text-gray-400">
          Last assessed {formatIncidentDate(goal.lastAssessedAt)}
        </p>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={goal.progress}
            onChange={(e) => changeProgress(e.target.value as GoalDto['progress'])}
            disabled={update.isPending}
            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-xs"
          >
            {GOAL_PROGRESS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {GOAL_PROGRESS_LABELS[opt]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleRemove}
            disabled={remove.isPending}
            className="rounded border border-rose-300 bg-white px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:bg-gray-100"
          >
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

function FeedbackRow({ feedback }: { feedback: BIPFeedbackDto }) {
  const submitted = feedback.submittedAt !== null;
  return (
    <li className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-900">
          {feedback.teacherName ?? 'A teacher'}
        </span>
        {submitted ? (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
            Submitted
          </span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
            Pending
          </span>
        )}
        {feedback.overallEffectiveness && (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              FEEDBACK_EFFECTIVENESS_PILL[feedback.overallEffectiveness],
            )}
          >
            {FEEDBACK_EFFECTIVENESS_LABELS[feedback.overallEffectiveness]}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {feedback.requestedByName ? 'Requested by ' + feedback.requestedByName : ''}
        {feedback.requestedAt
          ? ' · Requested ' + new Date(feedback.requestedAt).toLocaleDateString()
          : ''}
        {feedback.submittedAt
          ? ' · Submitted ' + new Date(feedback.submittedAt).toLocaleDateString()
          : ''}
      </p>
      {feedback.classroomObservations && (
        <p className="mt-2 text-sm text-gray-700">{feedback.classroomObservations}</p>
      )}
      {feedback.recommendedAdjustments && (
        <p className="mt-1 text-xs text-gray-500">
          <span className="font-medium">Adjustments:</span> {feedback.recommendedAdjustments}
        </p>
      )}
      {feedback.strategiesObserved && feedback.strategiesObserved.length > 0 && (
        <p className="mt-1 text-xs text-gray-500">
          Observed: {feedback.strategiesObserved.join(', ')}
        </p>
      )}
    </li>
  );
}

function EditStrategiesModal({
  plan,
  onClose,
}: {
  plan: {
    id: string;
    targetBehaviors: string[];
    replacementBehaviors: string[];
    reinforcementStrategies: string[];
    reviewDate: string;
  };
  onClose: () => void;
}) {
  const update = useUpdateBehaviorPlan(plan.id);
  const { toast } = useToast();
  const [target, setTarget] = useState(plan.targetBehaviors.join('\n'));
  const [replacement, setReplacement] = useState(plan.replacementBehaviors.join('\n'));
  const [reinforcement, setReinforcement] = useState(plan.reinforcementStrategies.join('\n'));
  const [reviewDate, setReviewDate] = useState(plan.reviewDate);

  function toLines(s: string): string[] {
    return s
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const targetBehaviors = toLines(target);
    if (targetBehaviors.length === 0) {
      toast('Target behaviours cannot be empty', 'error');
      return;
    }
    try {
      await update.mutateAsync({
        targetBehaviors,
        replacementBehaviors: toLines(replacement),
        reinforcementStrategies: toLines(reinforcement),
        reviewDate,
      });
      toast('Plan updated', 'success');
      onClose();
    } catch (err: any) {
      toast('Could not save: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit behaviours &amp; strategies"
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
            form="edit-strategies-form"
            disabled={update.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="edit-strategies-form" onSubmit={submit} className="space-y-4">
        <p className="text-xs text-gray-500">One item per line. Empty lines are ignored.</p>
        <ArrayField label="Target behaviours" value={target} onChange={setTarget} />
        <ArrayField label="Replacement behaviours" value={replacement} onChange={setReplacement} />
        <ArrayField
          label="Reinforcement strategies"
          value={reinforcement}
          onChange={setReinforcement}
        />
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
      </form>
    </Modal>
  );
}

function ArrayField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-900">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
      />
    </div>
  );
}

function AddGoalModal({ planId, onClose }: { planId: string; onClose: () => void }) {
  const add = useAddGoal(planId);
  const { toast } = useToast();
  const [goalText, setGoalText] = useState('');
  const [baseline, setBaseline] = useState('');
  const [target, setTarget] = useState('');
  const [measurement, setMeasurement] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!goalText.trim()) {
      toast('Goal text is required', 'error');
      return;
    }
    try {
      await add.mutateAsync({
        goalText: goalText.trim(),
        baselineFrequency: baseline.trim() || null,
        targetFrequency: target.trim() || null,
        measurementMethod: measurement.trim() || null,
      });
      toast('Goal added', 'success');
      onClose();
    } catch (err: any) {
      toast('Could not add goal: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add goal"
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
            form="add-goal-form"
            disabled={add.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {add.isPending ? 'Saving…' : 'Add goal'}
          </button>
        </>
      }
    >
      <form id="add-goal-form" onSubmit={submit} className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">Goal text</label>
          <textarea
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            rows={2}
            maxLength={1000}
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">
              Baseline frequency <span className="text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={baseline}
              onChange={(e) => setBaseline(e.target.value)}
              maxLength={200}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">
              Target frequency <span className="text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              maxLength={200}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Measurement method <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="text"
            value={measurement}
            onChange={(e) => setMeasurement(e.target.value)}
            maxLength={500}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
      </form>
    </Modal>
  );
}

function RequestFeedbackModal({ planId, onClose }: { planId: string; onClose: () => void }) {
  const employees = useEmployees({});
  const request = useRequestFeedback(planId);
  const { toast } = useToast();
  const [teacherId, setTeacherId] = useState('');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const list = employees.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list.slice(0, 100);
    return list
      .filter((e) => {
        const name = (e.firstName + ' ' + e.lastName).toLowerCase();
        return name.includes(q) || (e.email ?? '').toLowerCase().includes(q);
      })
      .slice(0, 100);
  }, [employees.data, search]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!teacherId) {
      toast('Pick a teacher', 'error');
      return;
    }
    try {
      await request.mutateAsync({ teacherId });
      toast("Feedback requested — task created on the teacher's list", 'success');
      onClose();
    } catch (err: any) {
      toast('Could not request feedback: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Request teacher feedback"
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
            form="request-feedback-form"
            disabled={request.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {request.isPending ? 'Sending…' : 'Send request'}
          </button>
        </>
      }
    >
      <form id="request-feedback-form" onSubmit={submit} className="space-y-3">
        <p className="text-xs text-gray-500">
          The teacher will receive an IN_APP notification and a TODO task on their to-do list. The
          partial UNIQUE on (plan_id, teacher_id) WHERE submitted_at IS NULL refuses a second
          pending request — wait for the teacher to submit before opening another round.
        </p>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">Find teacher</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
        <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white">
          {employees.isLoading ? (
            <div className="flex items-center gap-2 p-3 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-sm text-gray-500">No matches.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {filtered.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setTeacherId(e.id)}
                    className={cn(
                      'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50',
                      teacherId === e.id ? 'bg-campus-50 ring-1 ring-campus-200' : '',
                    )}
                  >
                    <span className="font-medium text-gray-900">
                      {e.firstName} {e.lastName}
                    </span>
                    <span className="text-xs text-gray-500">{e.primaryPositionTitle ?? '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>
    </Modal>
  );
}
