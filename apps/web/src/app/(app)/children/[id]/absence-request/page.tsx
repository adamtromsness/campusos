'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useStudent, useSubmitAbsenceRequest } from '@/hooks/use-children';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import type { AbsenceReasonCategory } from '@/lib/types';

const REASONS: { value: AbsenceReasonCategory; label: string }[] = [
  { value: 'ILLNESS', label: 'Illness' },
  { value: 'MEDICAL_APPOINTMENT', label: 'Medical appointment' },
  { value: 'FAMILY_EMERGENCY', label: 'Family emergency' },
  { value: 'HOLIDAY', label: 'Holiday / travel' },
  { value: 'RELIGIOUS_OBSERVANCE', label: 'Religious observance' },
  { value: 'OTHER', label: 'Other' },
];

export default function AbsenceRequestPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const studentId = params?.id;
  const student = useStudent(studentId);
  const submit = useSubmitAbsenceRequest();

  const today = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [reason, setReason] = useState<AbsenceReasonCategory>('ILLNESS');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (student.isLoading || !student.data) return <PageLoader label="Loading…" />;

  const requestType = dateFrom <= today && dateTo <= today ? 'SAME_DAY_REPORT' : 'ADVANCE_REQUEST';
  const isPast = dateFrom < today;
  const datesValid = dateFrom <= dateTo;
  const textValid = text.trim().length > 0 && text.length <= 1000;
  const canSubmit = !isPast && datesValid && textValid && !submit.isPending;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isPast) return setError('Absence dates cannot be in the past.');
    if (!datesValid) return setError('"To" date must be on or after "from" date.');
    if (!textValid) return setError('Reason text is required (max 1000 characters).');
    try {
      const result = await submit.mutateAsync({
        studentId: studentId!,
        absenceDateFrom: dateFrom,
        absenceDateTo: dateTo,
        requestType,
        reasonCategory: reason,
        reasonText: text.trim(),
      });
      const verb = result.status === 'AUTO_APPROVED' ? 'auto-approved' : 'submitted';
      toast(`Absence request ${verb}.`, 'success');
      router.replace('/dashboard');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to submit absence request.';
      setError(msg);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href={`/children/${studentId}/attendance`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to attendance
      </Link>

      <PageHeader title="Report absence" description={`For ${student.data.fullName}`} />

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-card border border-gray-200 bg-white p-5 shadow-card"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="From" htmlFor="dateFrom">
            <input
              id="dateFrom"
              type="date"
              min={today}
              value={dateFrom}
              onChange={(e) => {
                const v = e.target.value;
                setDateFrom(v);
                if (dateTo < v) setDateTo(v);
              }}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
            />
          </Field>
          <Field label="To" htmlFor="dateTo">
            <input
              id="dateTo"
              type="date"
              min={dateFrom}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
            />
          </Field>
        </div>

        <Field label="Reason" htmlFor="reason">
          <select
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as AbsenceReasonCategory)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Explanation" htmlFor="text">
          <textarea
            id="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={1000}
            placeholder="Anything the school should know."
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
          />
          <p className="mt-1 text-xs text-gray-400">{text.length} / 1000</p>
        </Field>

        <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          {requestType === 'SAME_DAY_REPORT'
            ? 'Same-day report — auto-approved.'
            : 'Advance request — queued for school admin review.'}
        </div>

        {error && (
          <div className="rounded-lg border border-status-absent-soft bg-status-absent-soft/40 px-3 py-2 text-sm text-status-absent-text">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Link
            href="/dashboard"
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submit.isPending && (
              <LoadingSpinner size="sm" className="border-white/40 border-t-white" />
            )}
            Submit request
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
