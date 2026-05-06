'use client';

import {
  useApplicationOnboarding,
  useCompleteOnboardingTask,
  useWaiveOnboardingTask,
} from '@/hooks/use-enrollment';
import { useToast } from '@/components/ui/Toast';

interface Props {
  applicationId: string;
  canEdit: boolean;
  isAdmin: boolean;
}

const STATUS_PILL: Record<string, string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  WAIVED: 'bg-amber-100 text-amber-700',
  OVERDUE: 'bg-rose-100 text-rose-700',
};

const CATEGORY_PILL: Record<string, string> = {
  ADMINISTRATIVE: 'bg-violet-100 text-violet-700',
  HEALTH: 'bg-rose-100 text-rose-700',
  IT: 'bg-sky-100 text-sky-700',
  FACILITIES: 'bg-amber-100 text-amber-700',
  TRANSPORT: 'bg-emerald-100 text-emerald-700',
  COMMUNICATIONS: 'bg-indigo-100 text-indigo-700',
  FINANCE: 'bg-orange-100 text-orange-700',
};

export function OnboardingPanel({ applicationId, canEdit, isAdmin }: Props) {
  const progressQ = useApplicationOnboarding(applicationId);
  const progressId = progressQ.data?.id ?? null;
  const complete = useCompleteOnboardingTask(progressId);
  const waive = useWaiveOnboardingTask(progressId);
  const { toast } = useToast();

  if (progressQ.isLoading) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
        Loading onboarding progress…
      </section>
    );
  }

  if (!progressQ.data) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
        No onboarding progress yet. The progress row is generated automatically when the parent
        accepts the offer.
      </section>
    );
  }

  const progress = progressQ.data;
  const tasks = progress.taskCompletions ?? [];
  const pct =
    progress.tasksTotal > 0 ? Math.round((progress.tasksCompleted / progress.tasksTotal) * 100) : 0;

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Onboarding</h2>
            <p className="text-xs text-gray-500">
              {progress.checklistName ?? 'Checklist'} · target start {progress.targetStartDate}
            </p>
          </div>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              progress.overallStatus === 'COMPLETE'
                ? 'bg-emerald-100 text-emerald-700'
                : progress.overallStatus === 'OVERDUE'
                  ? 'bg-rose-100 text-rose-700'
                  : 'bg-violet-100 text-violet-700'
            }`}
          >
            {progress.overallStatus.replace('_', ' ')}
          </span>
        </div>
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
            <span>
              {progress.tasksCompleted} of {progress.tasksTotal} tasks
            </span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full ${
                progress.overallStatus === 'COMPLETE' ? 'bg-emerald-500' : 'bg-campus-600'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </header>
      <ul className="divide-y divide-gray-100">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div className="flex items-center gap-3">
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  CATEGORY_PILL[t.taskCategory ?? ''] ?? 'bg-gray-100 text-gray-700'
                }`}
              >
                {t.taskCategory ?? '—'}
              </span>
              <div>
                <p className="font-medium text-gray-900">{t.taskName ?? '—'}</p>
                {t.responsibleRole ? (
                  <p className="text-xs text-gray-500">Owner: {t.responsibleRole}</p>
                ) : null}
                {t.completedAt ? (
                  <p className="text-xs text-gray-500">
                    Completed by {t.completedByName ?? '—'} ·{' '}
                    {new Date(t.completedAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  STATUS_PILL[t.status] ?? 'bg-gray-100 text-gray-700'
                }`}
              >
                {t.status}
              </span>
              {canEdit && t.status === 'PENDING' ? (
                <>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const result = await complete.mutateAsync({ taskCompletionId: t.id });
                        toast(
                          result.onboarded
                            ? 'Final mandatory task completed — onboarding marked COMPLETE'
                            : 'Task completed',
                          'success',
                        );
                      } catch (err) {
                        toast((err as { message?: string })?.message ?? 'Failed', 'error');
                      }
                    }}
                    disabled={complete.isPending}
                    className="rounded bg-campus-600 px-2 py-1 text-xs font-medium text-white hover:bg-campus-700 disabled:opacity-50"
                  >
                    Mark complete
                  </button>
                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await waive.mutateAsync({ taskCompletionId: t.id });
                          toast('Task waived', 'success');
                        } catch (err) {
                          toast((err as { message?: string })?.message ?? 'Failed', 'error');
                        }
                      }}
                      disabled={waive.isPending}
                      className="rounded border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                    >
                      Waive
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
