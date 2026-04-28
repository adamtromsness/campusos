'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useLeaveTypes,
  useMyLeaveBalances,
  useSubmitLeaveRequest,
  useMyEmployee,
} from '@/hooks/use-hr';
import { useAuthStore } from '@/lib/auth-store';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function diffDays(start: string, end: string): number {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1;
}

export default function NewLeaveRequestPage() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const me = useMyEmployee(!!user);
  const types = useLeaveTypes(!!user);
  const balances = useMyLeaveBalances(!!user);
  const submit = useSubmitLeaveRequest();
  const { toast } = useToast();

  const [leaveTypeId, setLeaveTypeId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(todayIso());
  const [endDate, setEndDate] = useState<string>(todayIso());
  const [daysRequested, setDaysRequested] = useState<number>(1);
  const [reason, setReason] = useState<string>('');

  // Default to the first active leave type once the list lands.
  useEffect(() => {
    if (!leaveTypeId && (types.data ?? []).length > 0) {
      setLeaveTypeId(types.data![0]!.id);
    }
  }, [leaveTypeId, types.data]);

  // Auto-calc days when the date range changes (round to whole days; the
  // user can override with a half via the input).
  useEffect(() => {
    setDaysRequested((prev) => {
      const next = Math.max(0.5, diffDays(startDate, endDate));
      return prev === diffDays(startDate, endDate) || prev === 0 ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  const balanceForType = useMemo(() => {
    if (!leaveTypeId) return null;
    return (balances.data ?? []).find((b) => b.leaveTypeId === leaveTypeId) ?? null;
  }, [balances.data, leaveTypeId]);

  if (!user) return null;

  if (me.isError || (!me.isLoading && !me.data)) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Request leave" />
        <p className="mt-4 text-sm text-gray-500">
          Leave is only available to staff with an employee record.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-block text-sm text-campus-700 hover:underline"
        >
          ← Back to home
        </Link>
      </div>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!leaveTypeId) {
      toast('Please choose a leave type.', 'error');
      return;
    }
    if (Date.parse(endDate) < Date.parse(startDate)) {
      toast('End date must be on or after start date.', 'error');
      return;
    }
    if (daysRequested <= 0) {
      toast('daysRequested must be greater than zero.', 'error');
      return;
    }
    try {
      await submit.mutateAsync({
        leaveTypeId,
        startDate,
        endDate,
        daysRequested,
        reason: reason.trim() || undefined,
      });
      toast('Leave request submitted', 'success');
      router.push('/leave');
    } catch (err: any) {
      toast(err?.message || 'Could not submit — please try again', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-2">
        <Link
          href="/leave"
          className="text-sm text-gray-500 transition-colors hover:text-campus-700"
        >
          ← My Leave
        </Link>
      </div>
      <PageHeader
        title="Request leave"
        description="Submit a new leave request for admin review."
      />

      <form
        onSubmit={onSubmit}
        className="mt-6 space-y-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
      >
        <div>
          <label className="block text-sm font-medium text-gray-700">Leave type</label>
          {types.isLoading ? (
            <div className="mt-2 py-2">
              <LoadingSpinner />
            </div>
          ) : (
            <select
              value={leaveTypeId}
              onChange={(e) => setLeaveTypeId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              required
            >
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isPaid ? '' : ' (unpaid)'}
                </option>
              ))}
            </select>
          )}
          {balanceForType && (
            <p className="mt-2 text-xs text-gray-500">
              Available {balanceForType.available} · accrued {balanceForType.accrued} · used{' '}
              {balanceForType.used} · pending {balanceForType.pending}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700">Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">End date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Days requested
            <span className="ml-2 text-xs font-normal text-gray-500">
              (supports halves — e.g. 0.5)
            </span>
          </label>
          <input
            type="number"
            value={daysRequested}
            onChange={(e) => setDaysRequested(Number.parseFloat(e.target.value))}
            step="0.5"
            min="0.5"
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            required
          />
          {balanceForType && daysRequested > balanceForType.available && (
            <p className="mt-1 text-xs text-amber-700">
              You only have {balanceForType.available} day
              {balanceForType.available === 1 ? '' : 's'} available. The request will go through but
              the admin may reject it.
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Optional — helps the admin review the request."
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          <Link
            href="/leave"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submit.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {submit.isPending ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </form>
    </div>
  );
}
