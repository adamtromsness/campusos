'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useMidYearAdmissions,
  useSubmitMidYearAdmission,
  useUpdateMidYearAdmission,
} from '@/hooks/use-enrolment-advanced';
import {
  MID_YEAR_REASONS,
  MID_YEAR_REASON_LABEL,
  MID_YEAR_STATUS_LABEL,
  MID_YEAR_STATUS_PILL,
  formatDate,
} from '@/lib/enrolment-advanced-format';
import type { MidYearAdmissionResponseDto, MidYearReason } from '@/lib/types';

export default function MidYearAdmissionPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['stu-004:read', 'stu-004:write', 'stu-004:admin']);
  const isAdmin = hasAnyPermission(user, ['stu-004:admin', 'sch-001:admin']);
  const canWrite = hasAnyPermission(user, ['stu-004:write', 'stu-004:admin', 'sch-001:admin']);
  const list = useMidYearAdmissions();
  const [showSubmit, setShowSubmit] = useState(false);

  if (!canRead) return <div className="p-6">Mid-year admissions are restricted.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Mid-year admissions</h1>
          <p className="text-sm text-slate-500">
            Out-of-cycle admission requests with capacity check + Cycle 16 application linking.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/enrolment/withdrawals">
            Withdrawals
          </Link>
          {canWrite ? (
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowSubmit(true)}
            >
              New request
            </button>
          ) : null}
        </div>
      </div>

      <table className="min-w-full text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th className="py-2">Student</th>
            <th>Grade</th>
            <th>Start date</th>
            <th>Reason</th>
            <th>Capacity</th>
            <th>Status</th>
            <th>Linked app</th>
            {isAdmin ? <th></th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(list.data ?? []).map((m) => (
            <MidYearRow key={m.id} row={m} isAdmin={isAdmin} />
          ))}
          {list.data && list.data.length === 0 ? (
            <tr>
              <td colSpan={8} className="py-4 text-slate-500">
                No mid-year requests yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {showSubmit ? <SubmitMidYearModal onClose={() => setShowSubmit(false)} /> : null}
    </div>
  );
}

function MidYearRow({ row, isAdmin }: { row: MidYearAdmissionResponseDto; isAdmin: boolean }) {
  const update = useUpdateMidYearAdmission(row.id);
  const { toast } = useToast();
  return (
    <tr>
      <td className="py-2 font-medium">
        {row.studentFirstName} {row.studentLastName}
      </td>
      <td>{row.applyingForGradeLevel}</td>
      <td>{formatDate(row.requestedStartDate)}</td>
      <td className="text-slate-600">{MID_YEAR_REASON_LABEL[row.admissionReason]}</td>
      <td>
        {row.capacityAvailable === null ? (
          <span className="text-slate-400">—</span>
        ) : row.capacityAvailable ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
            Available
          </span>
        ) : (
          <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">Full</span>
        )}
      </td>
      <td>
        <span className={`rounded px-2 py-0.5 text-xs ${MID_YEAR_STATUS_PILL[row.status]}`}>
          {MID_YEAR_STATUS_LABEL[row.status]}
        </span>
      </td>
      <td className="text-xs text-slate-500">
        {row.linkedApplicationId ? row.linkedApplicationId.slice(0, 8) : '—'}
      </td>
      {isAdmin ? (
        <td className="space-x-2 text-right text-xs">
          <button
            className="text-sky-700 hover:underline"
            onClick={async () => {
              try {
                await update.mutateAsync({ capacityAvailable: true, status: 'CAPACITY_CHECKED' });
                toast('Marked capacity available');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Mark available
          </button>
          <button
            className="text-rose-700 hover:underline"
            onClick={async () => {
              try {
                await update.mutateAsync({ capacityAvailable: false, status: 'CAPACITY_CHECKED' });
                toast('Marked full');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Mark full
          </button>
          <button
            className="text-violet-700 hover:underline"
            onClick={async () => {
              const appId = window.prompt('Link to application UUID?');
              if (!appId) return;
              try {
                await update.mutateAsync({
                  linkedApplicationId: appId,
                  status: 'OFFER_MADE',
                });
                toast('Linked');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Link application
          </button>
        </td>
      ) : null}
    </tr>
  );
}

function SubmitMidYearModal({ onClose }: { onClose: () => void }) {
  const submit = useSubmitMidYearAdmission();
  const { toast } = useToast();
  const [studentFirstName, setStudentFirstName] = useState('');
  const [studentLastName, setStudentLastName] = useState('');
  const [studentDateOfBirth, setStudentDateOfBirth] = useState('2014-01-01');
  const [applyingForGradeLevel, setApplyingForGradeLevel] = useState('5');
  const [requestedStartDate, setRequestedStartDate] = useState(
    new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  );
  const [admissionReason, setAdmissionReason] = useState<MidYearReason>('FAMILY_RELOCATION');
  const [previousSchoolName, setPreviousSchoolName] = useState('');
  const [notes, setNotes] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await submit.mutateAsync({
        studentFirstName,
        studentLastName,
        studentDateOfBirth,
        applyingForGradeLevel,
        requestedStartDate,
        admissionReason,
        previousSchoolName: previousSchoolName || undefined,
        notes: notes || undefined,
      });
      toast('Mid-year request submitted');
      onClose();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-6 shadow-lg"
        onSubmit={onSubmit}
      >
        <h3 className="text-lg font-semibold">Mid-year admission request</h3>
        <div className="flex gap-2">
          <label className="flex-1 text-sm">
            <span className="block font-medium">First name</span>
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              value={studentFirstName}
              onChange={(e) => setStudentFirstName(e.target.value)}
              required
            />
          </label>
          <label className="flex-1 text-sm">
            <span className="block font-medium">Last name</span>
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              value={studentLastName}
              onChange={(e) => setStudentLastName(e.target.value)}
              required
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="block font-medium">Date of birth</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={studentDateOfBirth}
            onChange={(e) => setStudentDateOfBirth(e.target.value)}
            required
          />
        </label>
        <div className="flex gap-2">
          <label className="flex-1 text-sm">
            <span className="block font-medium">Grade</span>
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              value={applyingForGradeLevel}
              onChange={(e) => setApplyingForGradeLevel(e.target.value)}
              required
            />
          </label>
          <label className="flex-1 text-sm">
            <span className="block font-medium">Start date</span>
            <input
              type="date"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              value={requestedStartDate}
              onChange={(e) => setRequestedStartDate(e.target.value)}
              required
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="block font-medium">Reason</span>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={admissionReason}
            onChange={(e) => setAdmissionReason(e.target.value as MidYearReason)}
          >
            {MID_YEAR_REASONS.map((r) => (
              <option key={r} value={r}>
                {MID_YEAR_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Previous school (optional)</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={previousSchoolName}
            onChange={(e) => setPreviousSchoolName(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Notes</span>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="text-sm text-slate-600" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Submit
          </button>
        </div>
      </form>
    </div>
  );
}
