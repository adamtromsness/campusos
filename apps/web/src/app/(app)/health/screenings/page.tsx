'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useCreateScreening,
  useFollowUpScreenings,
  useScreenings,
  useUpdateScreening,
} from '@/hooks/use-health';
import { useStudentsForReport } from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  SCREENING_RESULTS,
  SCREENING_RESULT_LABELS,
  SCREENING_RESULT_PILL,
  formatDate,
  studentDisplayName,
} from '@/lib/health-format';
import type { CreateScreeningPayload, ScreeningDto, ScreeningResult } from '@/lib/types';

/* /health/screenings — admin-only screening log + follow-up queue.
 * Two tabs:
 *   - All — every screening, filterable by type / result.
 *   - Follow-up — REFER results that haven't been completed yet.
 *     Hits the Step 3 partial INDEX on (school_id, follow_up_completed)
 *     WHERE follow_up_required=true AND follow_up_completed=false.
 */

type Tab = 'all' | 'follow-up';

export default function ScreeningsPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['hlt-004:read']);
  const isAdmin = !!user && hasAnyPermission(user, ['hlt-001:admin', 'sch-001:admin']);
  const [tab, setTab] = useState<Tab>('follow-up');
  const [resultFilter, setResultFilter] = useState<ScreeningResult | 'ALL'>('ALL');
  const [adding, setAdding] = useState(false);

  const all = useScreenings(
    resultFilter === 'ALL' ? {} : { result: resultFilter },
    canRead && tab === 'all',
  );
  const followUp = useFollowUpScreenings(canRead && tab === 'follow-up');

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <PageHeader title="Screenings" />
        <EmptyState
          title="Not available"
          description="The screening log is visible to nurses, counsellors, and admins only."
        />
      </div>
    );
  }

  const rows = tab === 'all' ? (all.data ?? []) : (followUp.data ?? []);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Screenings"
        description="Vision, hearing, and other school screenings. Follow-up queue surfaces students with REFER results pending action."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/health"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              ← Health
            </Link>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
            >
              Record screening
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap gap-2">
        <TabButton active={tab === 'follow-up'} onClick={() => setTab('follow-up')}>
          Follow-up queue ({followUp.data?.length ?? 0})
        </TabButton>
        <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
          All screenings
        </TabButton>
      </div>

      {tab === 'all' ? (
        <div className="flex flex-wrap gap-2">
          {(['ALL', ...SCREENING_RESULTS] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setResultFilter(r as ScreeningResult | 'ALL')}
              className={
                'rounded-md px-3 py-1 text-xs font-medium ' +
                (resultFilter === r
                  ? 'bg-campus-100 text-campus-800'
                  : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50')
              }
            >
              {r === 'ALL' ? 'All results' : SCREENING_RESULT_LABELS[r as ScreeningResult]}
            </button>
          ))}
        </div>
      ) : null}

      {(tab === 'all' ? all.isLoading : followUp.isLoading) ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title={tab === 'follow-up' ? 'No outstanding follow-ups' : 'No screenings recorded yet'}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <ScreeningRow key={s.id} screening={s} canEdit={isAdmin} />
          ))}
        </ul>
      )}

      {adding ? <ScreeningModal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md px-4 py-1.5 text-sm font-medium ' +
        (active
          ? 'bg-campus-700 text-white'
          : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50')
      }
    >
      {children}
    </button>
  );
}

function ScreeningRow({ screening, canEdit }: { screening: ScreeningDto; canEdit: boolean }) {
  const { toast } = useToast();
  const update = useUpdateScreening(screening.id);
  return (
    <li className="rounded-md border border-gray-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-gray-900">
          {screening.studentName ?? screening.studentId.slice(0, 8)}
        </p>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
          {screening.screeningType}
        </span>
        {screening.result ? (
          <span
            className={
              'rounded-full px-2 py-0.5 text-xs font-medium ' +
              SCREENING_RESULT_PILL[screening.result]
            }
          >
            {SCREENING_RESULT_LABELS[screening.result]}
          </span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
            Pending
          </span>
        )}
        {screening.followUpRequired && !screening.followUpCompleted ? (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
            Follow-up pending
          </span>
        ) : null}
        {screening.followUpCompleted ? (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
            Follow-up done
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {formatDate(screening.screeningDate)}
        {screening.screenedByName ? ' · ' + screening.screenedByName : ''}
      </p>
      {screening.referralNotes ? (
        <p className="mt-1 text-xs text-gray-700">Notes: {screening.referralNotes}</p>
      ) : null}
      {canEdit && screening.followUpRequired && !screening.followUpCompleted ? (
        <button
          type="button"
          onClick={() =>
            update.mutate(
              { followUpCompleted: true },
              {
                onSuccess: () => toast('Follow-up marked complete', 'success'),
                onError: (e) => toast((e as Error).message, 'error'),
              },
            )
          }
          disabled={update.isPending}
          className="mt-2 rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          Mark follow-up complete
        </button>
      ) : null}
    </li>
  );
}

function ScreeningModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateScreening();
  const students = useStudentsForReport();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<CreateScreeningPayload>({
    studentId: '',
    screeningType: '',
    screeningDate: new Date().toISOString().slice(0, 10),
    result: null,
    resultNotes: '',
    followUpRequired: false,
    referralNotes: '',
  });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = students.data ?? [];
    return s
      ? list.filter((st) => `${st.firstName} ${st.lastName}`.toLowerCase().includes(s))
      : list.slice(0, 25);
  }, [students.data, search]);

  return (
    <Modal open={true} title="Record a screening" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.studentId) {
            toast('Select a student', 'error');
            return;
          }
          create.mutate(
            {
              ...draft,
              screeningType: draft.screeningType.trim(),
              resultNotes: draft.resultNotes || null,
              referralNotes: draft.referralNotes || null,
            },
            {
              onSuccess: () => {
                toast('Screening recorded', 'success');
                onClose();
              },
              onError: (e) => toast((e as Error).message, 'error'),
            },
          );
        }}
      >
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Student <span className="text-rose-600">*</span>
          </label>
          <input
            type="text"
            placeholder="Search students…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <ul className="mt-2 max-h-40 overflow-y-auto rounded-md border border-gray-200">
            {filtered.map((st) => (
              <li key={st.id}>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, studentId: st.id })}
                  className={
                    'block w-full px-3 py-1.5 text-left text-sm hover:bg-campus-50 ' +
                    (draft.studentId === st.id ? 'bg-campus-100 font-semibold' : '')
                  }
                >
                  {studentDisplayName(st.firstName, st.lastName, st.id)}{' '}
                  {st.gradeLevel ? (
                    <span className="text-xs text-gray-500">· Grade {st.gradeLevel}</span>
                  ) : null}
                </button>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-gray-500">No matches.</li>
            ) : null}
          </ul>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
              Type <span className="text-rose-600">*</span>
            </label>
            <input
              required
              type="text"
              value={draft.screeningType}
              onChange={(e) => setDraft({ ...draft, screeningType: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="VISION / HEARING / SCOLIOSIS …"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
              Date <span className="text-rose-600">*</span>
            </label>
            <input
              required
              type="date"
              value={draft.screeningDate}
              onChange={(e) => setDraft({ ...draft, screeningDate: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Result
          </label>
          <select
            value={draft.result ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                result: (e.target.value || null) as ScreeningResult | null,
              })
            }
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Pending</option>
            {SCREENING_RESULTS.map((r) => (
              <option key={r} value={r}>
                {SCREENING_RESULT_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!draft.followUpRequired}
            onChange={(e) => setDraft({ ...draft, followUpRequired: e.target.checked })}
          />
          Follow-up required
        </label>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Referral notes
          </label>
          <textarea
            rows={2}
            value={draft.referralNotes ?? ''}
            onChange={(e) => setDraft({ ...draft, referralNotes: e.target.value })}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
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
            disabled={create.isPending}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
          >
            {create.isPending ? 'Saving…' : 'Record'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
