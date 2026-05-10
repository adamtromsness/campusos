'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useReenrolConfirmations,
  useReenrolSummary,
  useSubmitReenrol,
} from '@/hooks/use-enrolment-advanced';
import { useAcademicYears } from '@/hooks/use-enrollment';
import { formatDate, studentName } from '@/lib/enrolment-advanced-format';

export default function ReenrolmentPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['stu-004:read', 'stu-004:write', 'stu-004:admin']);
  const isAdmin = hasAnyPermission(user, ['stu-004:admin', 'sch-001:admin']);
  const canWrite = hasAnyPermission(user, ['stu-004:write', 'stu-004:admin', 'sch-001:admin']);
  const isGuardian = user?.personType === 'GUARDIAN';

  const academicYears = useAcademicYears();
  const [yearId, setYearId] = useState<string>('');
  const list = useReenrolConfirmations({ academicYearId: yearId || undefined, mine: !isAdmin });
  const summary = useReenrolSummary(isAdmin && yearId ? yearId : null);
  const [showSubmit, setShowSubmit] = useState(false);

  if (!canRead) {
    return <div className="p-6">Re-enrolment is restricted.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Re-enrolment</h1>
          <p className="text-sm text-slate-500">
            {isAdmin
              ? 'Per-grade continuing vs departing counts and the queue of family confirmations.'
              : 'Confirm your child is returning next year — or let us know they won&apos;t be.'}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/enrolment/withdrawals">
            Withdrawals
          </Link>
          {canWrite && isGuardian ? (
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowSubmit(true)}
            >
              Confirm next year
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <label className="font-medium">Academic year:</label>
        <select
          className="rounded border border-slate-300 px-2 py-1.5"
          value={yearId}
          onChange={(e) => setYearId(e.target.value)}
        >
          <option value="">— select —</option>
          {(academicYears.data ?? []).map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
            </option>
          ))}
        </select>
      </div>

      {isAdmin && summary.data ? (
        <section className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-base font-semibold">
            Summary — {summary.data.academicYearName ?? '—'}
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Total students" value={summary.data.totalStudents} />
            <Stat label="Continuing" value={summary.data.continuing} tone="emerald" />
            <Stat label="Departing" value={summary.data.departing} tone="rose" />
            <Stat label="Outstanding" value={summary.data.outstanding} tone="amber" />
          </div>
          <table className="mt-4 min-w-full text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr className="text-left">
                <th className="py-2">Grade</th>
                <th>Continuing</th>
                <th>Departing</th>
                <th>Outstanding</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.data.perGrade.map((g) => (
                <tr key={g.gradeLevel}>
                  <td className="py-1 font-medium">Grade {g.gradeLevel}</td>
                  <td>{g.continuing}</td>
                  <td>{g.departing}</td>
                  <td>{g.outstanding}</td>
                  <td>{g.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-base font-semibold">
          {isAdmin ? 'Confirmations' : 'Your confirmations'}
        </h2>
        <table className="mt-3 min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Student</th>
              <th>Year</th>
              <th>Continuing?</th>
              <th>Submitted</th>
              <th>Linked withdrawal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(list.data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="py-2 font-medium">
                  {studentName(r.studentFirstName, r.studentLastName)}
                </td>
                <td>{r.academicYearName ?? '—'}</td>
                <td>
                  {r.confirmedContinuing ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
                      Yes
                    </span>
                  ) : (
                    <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">
                      Departing
                    </span>
                  )}
                </td>
                <td>{formatDate(r.submittedAt)}</td>
                <td className="text-xs text-slate-500">
                  {r.linkedWithdrawalId ? (
                    <Link
                      href="/enrolment/withdrawals"
                      className="font-mono text-sky-700 hover:underline"
                    >
                      {r.linkedWithdrawalId.slice(0, 8)}…
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {list.data && list.data.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 text-slate-500">
                  No confirmations yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {showSubmit ? <SubmitConfirmationModal onClose={() => setShowSubmit(false)} /> : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'emerald' | 'rose' | 'amber';
}) {
  const cls =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'rose'
        ? 'text-rose-700'
        : tone === 'amber'
          ? 'text-amber-700'
          : 'text-slate-900';
  return (
    <div>
      <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs uppercase text-slate-500">{label}</div>
    </div>
  );
}

function SubmitConfirmationModal({ onClose }: { onClose: () => void }) {
  const submit = useSubmitReenrol();
  const academicYears = useAcademicYears();
  const { toast } = useToast();
  const [studentId, setStudentId] = useState('');
  const [academicYearId, setAcademicYearId] = useState('');
  const [continuing, setContinuing] = useState(true);
  const [reason, setReason] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await submit.mutateAsync({
        studentId,
        academicYearId,
        confirmedContinuing: continuing,
        withdrawalReason: continuing ? undefined : reason,
      });
      toast(
        continuing
          ? 'Confirmation submitted — see you next year!'
          : 'Confirmation submitted — withdrawal initiated. The school will follow up.',
      );
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
        <h3 className="text-lg font-semibold">Confirm next year</h3>
        <label className="block text-sm">
          <span className="block font-medium">Child UUID</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Academic year</span>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={academicYearId}
            onChange={(e) => setAcademicYearId(e.target.value)}
            required
          >
            <option value="">— select —</option>
            {(academicYears.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-2 rounded border border-slate-200 p-3 text-sm">
          <legend className="px-1 text-xs font-semibold text-slate-600">
            Will your child continue at this school?
          </legend>
          <label className="flex items-center gap-2">
            <input type="radio" checked={continuing} onChange={() => setContinuing(true)} />
            Yes — confirm enrolment
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!continuing} onChange={() => setContinuing(false)} />
            No — initiate withdrawal
          </label>
        </fieldset>
        {!continuing ? (
          <label className="block text-sm">
            <span className="block font-medium">Reason for not continuing</span>
            <textarea
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </label>
        ) : null}
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
