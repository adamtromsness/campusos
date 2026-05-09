'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  APPRAISAL_STATUS_LABEL,
  APPRAISAL_STATUS_PILL,
  CYCLE_STATUS_LABEL,
  CYCLE_STATUS_PILL,
  CYCLE_TYPE_LABEL,
  GOAL_PROGRESS_LABEL,
  GOAL_PROGRESS_PILL,
  RATING_LABEL,
  RATING_PILL,
  formatDate,
  formatDateTime,
} from '@/lib/hr-development-format';
import {
  useAppraisal,
  useAppraisalCycles,
  useAppraisals,
  useCreateAppraisalComment,
  useCreateAppraisalGoal,
  useCreateLessonObservation,
  useLockLessonObservation,
  usePatchAppraisal,
  usePatchAppraisalGoal,
} from '@/hooks/use-hr-development';
import type {
  AppraisalDto,
  AppraisalRating,
  AppraisalStatus,
  AppraisalGoalProgress,
} from '@/lib/types';

/**
 * Appraisals admin + employee surface. Gated on hr-005:read
 * (Teacher self-view + Staff/Admin admin view). Lesson
 * observation create + lock are KEYSTONE-gated on
 * lesson_observation:write — only School Admin / Platform Admin
 * via everyFunction reach those buttons.
 */
export default function AppraisalsPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['hr-005:read', 'hr-005:write', 'sch-001:admin']);
  const isAdmin = hasAnyPermission(user, ['hr-005:write', 'hr-005:admin', 'sch-001:admin']);
  const canObserve = hasAnyPermission(user, [
    'lesson_observation:write',
    'lesson_observation:admin',
    'sch-001:admin',
  ]);

  const cycles = useAppraisalCycles();
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const effectiveCycleId =
    selectedCycleId ?? cycles.data?.find((c) => c.status === 'OPEN')?.id ?? null;
  const appraisals = useAppraisals(effectiveCycleId ? { cycleId: effectiveCycleId } : undefined);
  const [openAppraisalId, setOpenAppraisalId] = useState<string | null>(null);

  if (!canRead) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Appraisals</h1>
        <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          Appraisals are restricted to school staff with HR-005:read.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Appraisals</h1>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/hr/training">
            Training
          </Link>
          <Link className="text-sky-700 hover:underline" href="/hr/expense-claims">
            Expense claims
          </Link>
        </div>
      </div>

      <section className="rounded border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Cycles</h2>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={effectiveCycleId ?? ''}
            onChange={(e) => setSelectedCycleId(e.target.value || null)}
          >
            {(cycles.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {CYCLE_TYPE_LABEL[c.cycleType]} · {CYCLE_STATUS_LABEL[c.status]}
              </option>
            ))}
          </select>
        </div>
        {(cycles.data ?? []).map((c) =>
          c.id === effectiveCycleId ? (
            <div key={c.id} className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <div className="text-xs text-slate-500">Cycle type</div>
                <div className="font-medium">{CYCLE_TYPE_LABEL[c.cycleType]}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Status</div>
                <span className={`rounded px-2 py-0.5 text-xs ${CYCLE_STATUS_PILL[c.status]}`}>
                  {CYCLE_STATUS_LABEL[c.status]}
                </span>
              </div>
              <div>
                <div className="text-xs text-slate-500">Starts</div>
                <div>{formatDate(c.startsOn)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Ends</div>
                <div>{formatDate(c.endsOn)}</div>
              </div>
            </div>
          ) : null,
        )}
      </section>

      <section className="rounded border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold">Appraisals in this cycle</h2>
        <table className="mt-3 min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Employee</th>
              <th>Appraiser</th>
              <th>Status</th>
              <th>Rating</th>
              <th>Goals</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(appraisals.data ?? []).map((a) => (
              <tr key={a.id} className={openAppraisalId === a.id ? 'bg-sky-50' : ''}>
                <td className="py-2 font-medium">{a.employeeName ?? a.employeeId.slice(0, 8)}</td>
                <td>{a.appraiserName ?? '—'}</td>
                <td>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${APPRAISAL_STATUS_PILL[a.status]}`}
                  >
                    {APPRAISAL_STATUS_LABEL[a.status]}
                  </span>
                </td>
                <td>
                  {a.overallRating ? (
                    <span className={`rounded px-2 py-0.5 text-xs ${RATING_PILL[a.overallRating]}`}>
                      {RATING_LABEL[a.overallRating]}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="text-center">{a.goals.length}</td>
                <td className="text-right text-xs">
                  <button
                    className="text-sky-700 hover:underline"
                    onClick={() => setOpenAppraisalId((cur) => (cur === a.id ? null : a.id))}
                  >
                    {openAppraisalId === a.id ? 'Close' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
            {(appraisals.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="py-3 text-slate-500">
                  No appraisals in this cycle.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {openAppraisalId ? (
        <AppraisalDetail appraisalId={openAppraisalId} isAdmin={isAdmin} canObserve={canObserve} />
      ) : null}
    </div>
  );
}

function AppraisalDetail({
  appraisalId,
  isAdmin,
  canObserve,
}: {
  appraisalId: string;
  isAdmin: boolean;
  canObserve: boolean;
}) {
  const appraisal = useAppraisal(appraisalId);
  if (!appraisal.data) {
    return (
      <section className="rounded border border-slate-200 bg-white p-5 text-sm text-slate-600">
        Loading…
      </section>
    );
  }
  const a = appraisal.data;
  return (
    <section className="space-y-4 rounded border border-slate-200 bg-white p-5">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold">{a.employeeName ?? 'Appraisal'}</h2>
          <div className="text-xs text-slate-500">
            Cycle: {a.cycleName ?? '—'} · Appraiser: {a.appraiserName ?? '—'}
          </div>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${APPRAISAL_STATUS_PILL[a.status]}`}>
          {APPRAISAL_STATUS_LABEL[a.status]}
        </span>
      </header>
      <AppraisalStatusActions appraisal={a} isAdmin={isAdmin} />
      <ReviewPanel appraisal={a} isAdmin={isAdmin} />
      <GoalsPanel appraisal={a} isAdmin={isAdmin} />
      <ObservationsPanel appraisal={a} canObserve={canObserve} />
      <CommentsPanel appraisal={a} isAdmin={isAdmin} />
    </section>
  );
}

function AppraisalStatusActions({
  appraisal,
  isAdmin,
}: {
  appraisal: AppraisalDto;
  isAdmin: boolean;
}) {
  const { toast } = useToast();
  const patch = usePatchAppraisal(appraisal.id);
  if (!isAdmin) return null;
  if (appraisal.status === 'SIGNED_OFF') {
    return (
      <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
        Signed off on {formatDateTime(appraisal.signedOffAt)} by {appraisal.signedOffByName ?? '—'}.
        Immutable.
      </div>
    );
  }
  const transitions: Array<{ to: AppraisalStatus; label: string; tone: string; confirm?: string }> =
    [];
  if (appraisal.status === 'DRAFT') {
    transitions.push({ to: 'IN_REVIEW', label: 'Move to review', tone: 'bg-sky-600' });
  }
  if (appraisal.status === 'IN_REVIEW') {
    transitions.push({ to: 'DRAFT', label: 'Back to draft', tone: 'bg-slate-500' });
    transitions.push({
      to: 'SIGNED_OFF',
      label: 'Sign off (irreversible)',
      tone: 'bg-emerald-600',
      confirm: 'Sign off this appraisal? It becomes immutable thereafter.',
    });
  }
  return (
    <div className="flex flex-wrap gap-2">
      {transitions.map((t) => (
        <button
          key={t.to}
          className={`rounded ${t.tone} px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90`}
          onClick={async () => {
            if (t.confirm && !window.confirm(t.confirm)) return;
            try {
              await patch.mutateAsync({ status: t.to });
              toast(`Status: ${APPRAISAL_STATUS_LABEL[t.to]}`);
            } catch (e) {
              toast(`Failed: ${(e as Error).message}`, 'error');
            }
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ReviewPanel({ appraisal, isAdmin }: { appraisal: AppraisalDto; isAdmin: boolean }) {
  const { toast } = useToast();
  const patch = usePatchAppraisal(appraisal.id);
  const isSignedOff = appraisal.status === 'SIGNED_OFF';
  const [self, setSelf] = useState(appraisal.selfReview ?? '');
  const [appraiser, setAppraiser] = useState(appraisal.appraiserReview ?? '');
  const [development, setDevelopment] = useState(appraisal.developmentPlan ?? '');
  const [rating, setRating] = useState<AppraisalRating | ''>(appraisal.overallRating ?? '');
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div>
        <label className="text-sm font-semibold">Self-review</label>
        <textarea
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          rows={4}
          value={self}
          disabled={isSignedOff}
          onChange={(e) => setSelf(e.target.value)}
        />
        {!isSignedOff ? (
          <button
            className="mt-2 text-xs text-sky-700 hover:underline"
            onClick={async () => {
              try {
                await patch.mutateAsync({ selfReview: self });
                toast('Self-review saved');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Save self-review
          </button>
        ) : null}
      </div>
      {isAdmin ? (
        <div>
          <label className="text-sm font-semibold">Appraiser review</label>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            rows={4}
            value={appraiser}
            disabled={isSignedOff}
            onChange={(e) => setAppraiser(e.target.value)}
          />
          <label className="mt-2 block text-sm font-semibold">Development plan</label>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            rows={3}
            value={development}
            disabled={isSignedOff}
            onChange={(e) => setDevelopment(e.target.value)}
          />
          <label className="mt-2 block text-sm font-semibold">Overall rating</label>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={rating}
            disabled={isSignedOff}
            onChange={(e) => setRating((e.target.value as AppraisalRating) || '')}
          >
            <option value="">— select rating —</option>
            {(
              ['OUTSTANDING', 'GOOD', 'REQUIRES_IMPROVEMENT', 'INADEQUATE'] as AppraisalRating[]
            ).map((r) => (
              <option key={r} value={r}>
                {RATING_LABEL[r]}
              </option>
            ))}
          </select>
          {!isSignedOff ? (
            <button
              className="mt-2 text-xs text-sky-700 hover:underline"
              onClick={async () => {
                try {
                  await patch.mutateAsync({
                    appraiserReview: appraiser,
                    developmentPlan: development,
                    overallRating: rating || undefined,
                  });
                  toast('Appraiser fields saved');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Save appraiser fields
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GoalsPanel({ appraisal, isAdmin }: { appraisal: AppraisalDto; isAdmin: boolean }) {
  const { toast } = useToast();
  const create = useCreateAppraisalGoal(appraisal.id);
  const [goalText, setGoalText] = useState('');
  const [criteria, setCriteria] = useState('');
  const [target, setTarget] = useState('');
  const isSignedOff = appraisal.status === 'SIGNED_OFF';
  return (
    <div>
      <h3 className="text-sm font-semibold">Goals</h3>
      <ul className="mt-2 space-y-2">
        {appraisal.goals.map((g) => (
          <GoalRow
            key={g.id}
            appraisalId={appraisal.id}
            goal={g}
            canEdit={!isSignedOff}
            isAdmin={isAdmin}
          />
        ))}
        {appraisal.goals.length === 0 ? (
          <li className="text-xs text-slate-500">No goals yet.</li>
        ) : null}
      </ul>
      {!isSignedOff ? (
        <form
          className="mt-3 space-y-2 rounded bg-slate-50 p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await create.mutateAsync({
                goalText,
                successCriteria: criteria || undefined,
                targetDate: target || undefined,
              });
              setGoalText('');
              setCriteria('');
              setTarget('');
              toast('Goal added');
            } catch (err) {
              toast(`Failed: ${(err as Error).message}`, 'error');
            }
          }}
        >
          <input
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Goal text"
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            required
            minLength={2}
          />
          <input
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Success criteria (optional)"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <input
              type="date"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button
              type="submit"
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
            >
              Add goal
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function GoalRow({
  appraisalId,
  goal,
  canEdit,
  isAdmin,
}: {
  appraisalId: string;
  goal: AppraisalDto['goals'][number];
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const { toast } = useToast();
  const patch = usePatchAppraisalGoal(appraisalId, goal.id);
  return (
    <li className="rounded border border-slate-200 bg-white p-3 text-sm">
      <div className="flex items-baseline justify-between">
        <div className="font-medium">{goal.goalText}</div>
        <span className={`rounded px-2 py-0.5 text-xs ${GOAL_PROGRESS_PILL[goal.progress]}`}>
          {GOAL_PROGRESS_LABEL[goal.progress]}
        </span>
      </div>
      {goal.successCriteria ? (
        <div className="mt-1 text-xs text-slate-600">{goal.successCriteria}</div>
      ) : null}
      <div className="mt-1 text-xs text-slate-500">Target: {formatDate(goal.targetDate)}</div>
      {canEdit ? (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {(
            ['NOT_STARTED', 'IN_PROGRESS', 'ACHIEVED', 'NOT_ACHIEVED'] as AppraisalGoalProgress[]
          ).map((p) =>
            p === goal.progress ? null : (
              <button
                key={p}
                className="rounded border border-slate-300 px-2 py-0.5 text-slate-700 hover:bg-slate-100"
                onClick={async () => {
                  try {
                    await patch.mutateAsync({ progress: p });
                    toast('Progress updated');
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                Mark {GOAL_PROGRESS_LABEL[p]}
              </button>
            ),
          )}
        </div>
      ) : null}
      {!isAdmin ? null : null}
    </li>
  );
}

function ObservationsPanel({
  appraisal,
  canObserve,
}: {
  appraisal: AppraisalDto;
  canObserve: boolean;
}) {
  const { toast } = useToast();
  const create = useCreateLessonObservation();
  const [showForm, setShowForm] = useState(false);
  const [classLabel, setClassLabel] = useState('');
  const [observationDate, setObservationDate] = useState(new Date().toISOString().slice(0, 10));
  const [duration, setDuration] = useState('45');
  const [grade, setGrade] = useState<AppraisalRating | ''>('');
  const [strengths, setStrengths] = useState('');
  const [areas, setAreas] = useState('');
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Lesson observations</h3>
        {canObserve ? (
          <button
            className="text-xs text-sky-700 hover:underline"
            onClick={() => setShowForm((s) => !s)}
          >
            {showForm ? 'Close form' : 'Add observation'}
          </button>
        ) : null}
      </div>
      <ul className="mt-2 space-y-2">
        {appraisal.observations.map((o) => (
          <li key={o.id} className="rounded border border-slate-200 bg-white p-3 text-sm">
            <div className="flex items-baseline justify-between">
              <div className="font-medium">{o.observedClassLabel}</div>
              <div className="flex items-center gap-2">
                {o.overallGrade ? (
                  <span className={`rounded px-2 py-0.5 text-xs ${RATING_PILL[o.overallGrade]}`}>
                    {RATING_LABEL[o.overallGrade]}
                  </span>
                ) : null}
                {o.isLocked ? (
                  <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700">
                    Locked
                  </span>
                ) : null}
              </div>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {formatDate(o.observationDate)} · {o.observerName ?? '—'} · {o.durationMinutes ?? '—'}
              min
            </div>
            {o.strengths ? <div className="mt-2 text-xs">Strengths: {o.strengths}</div> : null}
            {o.areasForDevelopment ? (
              <div className="mt-1 text-xs">Areas for development: {o.areasForDevelopment}</div>
            ) : null}
            {canObserve && !o.isLocked ? (
              <LockObservationButton observation={o} appraisalId={appraisal.id} />
            ) : null}
          </li>
        ))}
        {appraisal.observations.length === 0 ? (
          <li className="text-xs text-slate-500">No observations yet.</li>
        ) : null}
      </ul>
      {showForm && canObserve ? (
        <form
          className="mt-3 space-y-2 rounded bg-rose-50 p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await create.mutateAsync({
                appraisalId: appraisal.id,
                observedEmployeeId: appraisal.employeeId,
                observationDate,
                observedClassLabel: classLabel,
                durationMinutes: duration ? Number(duration) : undefined,
                overallGrade: grade || undefined,
                strengths: strengths || undefined,
                areasForDevelopment: areas || undefined,
              });
              setShowForm(false);
              setClassLabel('');
              setStrengths('');
              setAreas('');
              setGrade('');
              toast('Observation added');
            } catch (err) {
              toast(`Failed: ${(err as Error).message}`, 'error');
            }
          }}
        >
          <div className="text-xs font-semibold text-rose-800">
            Sensitive — lesson_observation:write keystone gates this form.
          </div>
          <input
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Observed class label (e.g. Algebra 1 — P3)"
            value={classLabel}
            onChange={(e) => setClassLabel(e.target.value)}
            required
            minLength={2}
          />
          <div className="flex items-center gap-2">
            <input
              type="date"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={observationDate}
              onChange={(e) => setObservationDate(e.target.value)}
              required
            />
            <input
              type="number"
              min={1}
              max={480}
              className="w-24 rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="min"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
            <select
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={grade}
              onChange={(e) => setGrade((e.target.value as AppraisalRating) || '')}
            >
              <option value="">— grade —</option>
              {(
                ['OUTSTANDING', 'GOOD', 'REQUIRES_IMPROVEMENT', 'INADEQUATE'] as AppraisalRating[]
              ).map((g) => (
                <option key={g} value={g}>
                  {RATING_LABEL[g]}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            rows={2}
            placeholder="Strengths"
            value={strengths}
            onChange={(e) => setStrengths(e.target.value)}
          />
          <textarea
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            rows={2}
            placeholder="Areas for development"
            value={areas}
            onChange={(e) => setAreas(e.target.value)}
          />
          <button
            type="submit"
            className="rounded bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
          >
            Add observation
          </button>
        </form>
      ) : null}
    </div>
  );
}

function LockObservationButton({
  observation,
  appraisalId,
}: {
  observation: AppraisalDto['observations'][number];
  appraisalId: string;
}) {
  const { toast } = useToast();
  const lock = useLockLessonObservation(observation.id, appraisalId);
  return (
    <button
      className="mt-2 text-xs text-slate-600 hover:underline"
      onClick={async () => {
        if (
          !window.confirm(
            'Lock this observation? Once locked the observation is immutable and the observed employee can read it via their appraisal detail.',
          )
        )
          return;
        try {
          await lock.mutateAsync();
          toast('Observation locked');
        } catch (e) {
          toast(`Failed: ${(e as Error).message}`, 'error');
        }
      }}
    >
      Lock observation
    </button>
  );
}

function CommentsPanel({ appraisal, isAdmin }: { appraisal: AppraisalDto; isAdmin: boolean }) {
  const { toast } = useToast();
  const create = useCreateAppraisalComment(appraisal.id);
  const [text, setText] = useState('');
  const [visible, setVisible] = useState(true);
  const isSignedOff = appraisal.status === 'SIGNED_OFF';
  return (
    <div>
      <h3 className="text-sm font-semibold">Comments</h3>
      <ul className="mt-2 space-y-2">
        {appraisal.comments.map((c) => (
          <li
            key={c.id}
            className={`rounded border border-slate-200 bg-white p-2 text-sm ${
              c.isVisibleToEmployee ? '' : 'border-amber-200 bg-amber-50'
            }`}
          >
            <div className="flex items-baseline justify-between text-xs text-slate-500">
              <span>{c.authorName ?? c.authorId.slice(0, 8)}</span>
              <span>
                {formatDateTime(c.createdAt)}
                {c.isVisibleToEmployee ? '' : ' · private'}
              </span>
            </div>
            <div className="mt-1 whitespace-pre-wrap">{c.commentText}</div>
          </li>
        ))}
        {appraisal.comments.length === 0 ? (
          <li className="text-xs text-slate-500">No comments yet.</li>
        ) : null}
      </ul>
      {!isSignedOff ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await create.mutateAsync({ commentText: text, isVisibleToEmployee: visible });
              setText('');
              setVisible(true);
              toast('Comment posted');
            } catch (err) {
              toast(`Failed: ${(err as Error).message}`, 'error');
            }
          }}
        >
          <textarea
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            rows={2}
            placeholder="Comment"
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            minLength={2}
          />
          <div className="flex items-center justify-between text-xs">
            {isAdmin ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => setVisible(e.target.checked)}
                />
                <span>Visible to employee</span>
              </label>
            ) : (
              <span className="text-slate-500">Comment will be visible to the employee.</span>
            )}
            <button
              type="submit"
              className="rounded bg-sky-600 px-3 py-1.5 font-semibold text-white hover:bg-sky-700"
            >
              Post
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// Suppress an unused-import warning on `useMemo` when the page
// hot-paths don't reach it (helps the build stay quiet).
void useMemo;
