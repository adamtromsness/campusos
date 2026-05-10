'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useCancelWithdrawal,
  useCompleteWithdrawal,
  useCreateWithdrawal,
  usePlaceReenrolHold,
  useUpdateExitTask,
  useWithdrawal,
  useWithdrawals,
} from '@/hooks/use-enrolment-advanced';
import {
  TASK_CATEGORY_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUS_PILL,
  WITHDRAWAL_REASON_LABEL,
  WITHDRAWAL_REASONS,
  WITHDRAWAL_STATUS_LABEL,
  WITHDRAWAL_STATUS_PILL,
  formatDate,
  studentName,
} from '@/lib/enrolment-advanced-format';
import type {
  ExitTaskResponseDto,
  ExitTaskStatus,
  WithdrawalReason,
  WithdrawalStatus,
} from '@/lib/types';

export default function WithdrawalManagerPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['stu-004:read', 'stu-004:write', 'stu-004:admin']);
  const isAdmin = hasAnyPermission(user, ['stu-004:admin', 'sch-001:admin']);
  const canWrite = hasAnyPermission(user, ['stu-004:write', 'stu-004:admin', 'sch-001:admin']);
  const [statusFilter, setStatusFilter] = useState<WithdrawalStatus | ''>('');
  const list = useWithdrawals(statusFilter || undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const grouped = useMemo(() => {
    const data = list.data ?? [];
    return {
      requested: data.filter((w) => w.status === 'REQUESTED'),
      inProgress: data.filter((w) => w.status === 'IN_PROGRESS'),
      completed: data.filter((w) => w.status === 'COMPLETED'),
      cancelled: data.filter((w) => w.status === 'CANCELLED'),
    };
  }, [list.data]);

  if (!canRead) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Withdrawals</h1>
        <p className="mt-2 text-slate-600">Withdrawal management is restricted.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Withdrawals</h1>
          <p className="text-sm text-slate-500">
            Manage withdrawal requests with multi-department exit task checklists.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/enrolment/reenrolment">
            Re-enrolment dashboard
          </Link>
          <Link className="text-sky-700 hover:underline" href="/enrolment/mid-year">
            Mid-year admissions
          </Link>
          {isAdmin ? (
            <Link className="text-sky-700 hover:underline" href="/enrolment/withdrawals/templates">
              Exit task template
            </Link>
          ) : null}
          {canWrite ? (
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowCreate(true)}
            >
              Initiate withdrawal
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2">
        {(['', 'REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const).map((s) => (
          <button
            key={s || 'all'}
            type="button"
            className={`rounded px-3 py-1.5 text-xs ${
              statusFilter === s
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
            onClick={() => setStatusFilter(s as WithdrawalStatus | '')}
          >
            {s ? WITHDRAWAL_STATUS_LABEL[s] : 'All'}
          </button>
        ))}
      </div>

      <table className="min-w-full text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th className="py-2">Student</th>
            <th>Reason</th>
            <th>Requested</th>
            <th>Status</th>
            <th>Tasks</th>
            <th>Hold</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(list.data ?? []).map((w) => (
            <tr
              key={w.id}
              className="cursor-pointer hover:bg-slate-50"
              onClick={() => setOpenId(w.id)}
            >
              <td className="py-2 font-medium">
                {studentName(w.studentFirstName, w.studentLastName)}
              </td>
              <td className="text-slate-600">
                {WITHDRAWAL_REASON_LABEL[w.withdrawalReasonCategory]}
              </td>
              <td>{formatDate(w.requestedAt)}</td>
              <td>
                <span className={`rounded px-2 py-0.5 text-xs ${WITHDRAWAL_STATUS_PILL[w.status]}`}>
                  {WITHDRAWAL_STATUS_LABEL[w.status]}
                </span>
              </td>
              <td>
                {w.exitTaskSummary.completed +
                  w.exitTaskSummary.waived +
                  w.exitTaskSummary.notApplicable}
                /{w.exitTaskSummary.total}
              </td>
              <td>
                {w.reEnrollmentHoldPlaced ? (
                  <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">
                    Hold
                  </span>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
              <td className="text-right text-xs text-sky-700">View →</td>
            </tr>
          ))}
          {list.data && list.data.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-4 text-slate-500">
                No withdrawals match the filter.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <div className="text-xs text-slate-400">
        Counts: REQUESTED {grouped.requested.length} · IN_PROGRESS {grouped.inProgress.length} ·
        COMPLETED {grouped.completed.length} · CANCELLED {grouped.cancelled.length}
      </div>

      {openId ? (
        <WithdrawalDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          isAdmin={isAdmin}
          canWrite={canWrite}
        />
      ) : null}
      {showCreate ? <CreateWithdrawalModal onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

function WithdrawalDetailModal({
  id,
  onClose,
  isAdmin,
  canWrite,
}: {
  id: string;
  onClose: () => void;
  isAdmin: boolean;
  canWrite: boolean;
}) {
  const detail = useWithdrawal(id);
  const complete = useCompleteWithdrawal(id);
  const cancel = useCancelWithdrawal(id);
  const placeHold = usePlaceReenrolHold(id);
  const { toast } = useToast();
  const w = detail.data;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl space-y-4 rounded-lg bg-white p-6 shadow-lg">
        <div className="flex items-baseline justify-between">
          <h3 className="text-lg font-semibold">
            {w ? studentName(w.studentFirstName, w.studentLastName) : 'Loading…'}
          </h3>
          <button className="text-sm text-slate-500" onClick={onClose}>
            Close
          </button>
        </div>
        {w ? (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Reason</dt>
                <dd>{WITHDRAWAL_REASON_LABEL[w.withdrawalReasonCategory]}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Status</dt>
                <dd>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${WITHDRAWAL_STATUS_PILL[w.status]}`}
                  >
                    {WITHDRAWAL_STATUS_LABEL[w.status]}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Last attendance</dt>
                <dd>{formatDate(w.lastAttendanceDate)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Initiated by</dt>
                <dd>
                  {w.initiatedBy} ({w.requestedByName ?? '—'})
                </dd>
              </div>
              {w.destinationSchoolName ? (
                <div className="col-span-2">
                  <dt className="text-xs text-slate-500">Destination</dt>
                  <dd>
                    {w.destinationSchoolName}
                    {w.destinationSchoolCountry ? ` · ${w.destinationSchoolCountry}` : ''}
                  </dd>
                </div>
              ) : null}
              {w.withdrawalReasonDetail ? (
                <div className="col-span-2">
                  <dt className="text-xs text-slate-500">Detail</dt>
                  <dd className="whitespace-pre-wrap">{w.withdrawalReasonDetail}</dd>
                </div>
              ) : null}
            </div>

            <section>
              <h4 className="text-sm font-semibold">Exit tasks</h4>
              <table className="mt-2 min-w-full text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr className="text-left">
                    <th className="py-1">Task</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Completed by</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {w.exitTasks.map((t) => (
                    <ExitTaskRow
                      key={t.id}
                      task={t}
                      withdrawalId={w.id}
                      withdrawalStatus={w.status}
                      canWrite={canWrite}
                    />
                  ))}
                </tbody>
              </table>
            </section>

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              {isAdmin && w.status !== 'COMPLETED' && w.status !== 'CANCELLED' ? (
                <button
                  className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
                  disabled={w.exitTaskSummary.pending > 0}
                  title={
                    w.exitTaskSummary.pending > 0
                      ? `${w.exitTaskSummary.pending} task(s) still PENDING`
                      : ''
                  }
                  onClick={async () => {
                    if (
                      !window.confirm(
                        'Complete this withdrawal? Student enrollment_status will flip to WITHDRAWN. This is irreversible.',
                      )
                    )
                      return;
                    try {
                      await complete.mutateAsync({});
                      toast('Withdrawal completed');
                    } catch (e) {
                      toast(`Failed: ${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  Complete withdrawal
                </button>
              ) : null}
              {canWrite && w.status !== 'COMPLETED' && w.status !== 'CANCELLED' ? (
                <button
                  className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                  onClick={async () => {
                    const reason = window.prompt('Cancellation reason (required)?');
                    if (!reason || reason.trim() === '') return;
                    try {
                      await cancel.mutateAsync({ reason });
                      toast('Withdrawal cancelled');
                    } catch (e) {
                      toast(`Failed: ${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  Cancel withdrawal
                </button>
              ) : null}
              {isAdmin ? (
                <button
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
                  onClick={async () => {
                    const setHold = !w.reEnrollmentHoldPlaced;
                    const reason = setHold
                      ? window.prompt('Reason for placing the re-enrolment hold (required)?')
                      : null;
                    if (setHold && (!reason || reason.trim() === '')) return;
                    try {
                      await placeHold.mutateAsync({ hold: setHold, reason: reason ?? undefined });
                      toast(setHold ? 'Hold placed' : 'Hold lifted');
                    } catch (e) {
                      toast(`Failed: ${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  {w.reEnrollmentHoldPlaced ? 'Lift hold' : 'Place re-enrolment hold'}
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <div className="py-6 text-center text-slate-500">Loading…</div>
        )}
      </div>
    </div>
  );
}

function ExitTaskRow({
  task,
  withdrawalId,
  withdrawalStatus,
  canWrite,
}: {
  task: ExitTaskResponseDto;
  withdrawalId: string;
  withdrawalStatus: WithdrawalStatus;
  canWrite: boolean;
}) {
  const update = useUpdateExitTask(task.id, withdrawalId);
  const { toast } = useToast();
  const closed = withdrawalStatus === 'COMPLETED' || withdrawalStatus === 'CANCELLED';
  return (
    <tr>
      <td className="py-1 font-medium">{task.taskName}</td>
      <td>{TASK_CATEGORY_LABEL[task.taskCategory]}</td>
      <td>
        <span className={`rounded px-2 py-0.5 text-xs ${TASK_STATUS_PILL[task.status]}`}>
          {TASK_STATUS_LABEL[task.status]}
        </span>
      </td>
      <td className="text-xs text-slate-500">
        {task.completedByName ?? '—'}
        {task.completedAt ? <div>{formatDate(task.completedAt)}</div> : null}
      </td>
      <td className="text-right text-xs">
        {canWrite && !closed ? (
          <select
            className="rounded border border-slate-300 px-1 py-0.5 text-xs"
            value={task.status}
            onChange={async (e) => {
              const status = e.target.value as ExitTaskStatus;
              try {
                await update.mutateAsync({ status });
                toast('Task ' + TASK_STATUS_LABEL[status]);
              } catch (err) {
                toast(`Failed: ${(err as Error).message}`, 'error');
              }
            }}
          >
            {(['PENDING', 'COMPLETED', 'WAIVED', 'NOT_APPLICABLE'] as ExitTaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        ) : null}
      </td>
    </tr>
  );
}

function CreateWithdrawalModal({ onClose }: { onClose: () => void }) {
  const create = useCreateWithdrawal();
  const { toast } = useToast();
  const [studentId, setStudentId] = useState('');
  const [initiatedBy, setInitiatedBy] = useState<'FAMILY' | 'SCHOOL'>('FAMILY');
  const [reason, setReason] = useState<WithdrawalReason>('FAMILY_RELOCATION');
  const [reasonDetail, setReasonDetail] = useState('');
  const [lastAttendance, setLastAttendance] = useState(new Date().toISOString().slice(0, 10));
  const [destSchool, setDestSchool] = useState('');
  const [destCountry, setDestCountry] = useState('');
  const [recordsRelease, setRecordsRelease] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({
        studentId,
        initiatedBy,
        withdrawalReasonCategory: reason,
        withdrawalReasonDetail: reasonDetail || undefined,
        lastAttendanceDate: lastAttendance,
        destinationSchoolName: destSchool || undefined,
        destinationSchoolCountry: destCountry || undefined,
        recordsReleaseConsented: recordsRelease,
      });
      toast('Withdrawal initiated — exit tasks created');
      onClose();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-6 shadow-lg"
        onSubmit={submit}
      >
        <h3 className="text-lg font-semibold">Initiate withdrawal</h3>
        <label className="block text-sm">
          <span className="block font-medium">Student UUID</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
          />
          <span className="text-xs text-slate-500">Find the student via Students directory.</span>
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Initiated by</span>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={initiatedBy}
            onChange={(e) => setInitiatedBy(e.target.value as 'FAMILY' | 'SCHOOL')}
          >
            <option value="FAMILY">Family</option>
            <option value="SCHOOL">School</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Reason</span>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={reason}
            onChange={(e) => setReason(e.target.value as WithdrawalReason)}
          >
            {WITHDRAWAL_REASONS.map((r) => (
              <option key={r} value={r}>
                {WITHDRAWAL_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Detail (optional)</span>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            rows={3}
            value={reasonDetail}
            onChange={(e) => setReasonDetail(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Last attendance date</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={lastAttendance}
            onChange={(e) => setLastAttendance(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Destination school (optional)</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={destSchool}
            onChange={(e) => setDestSchool(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Destination country (optional)</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={destCountry}
            onChange={(e) => setDestCountry(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={recordsRelease}
            onChange={(e) => setRecordsRelease(e.target.checked)}
          />
          Family consents to records release
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="text-sm text-slate-600" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Initiate
          </button>
        </div>
      </form>
    </div>
  );
}
