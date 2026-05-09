'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  PAY_PERIOD_STATUS_LABEL,
  PAY_PERIOD_STATUS_PILL,
  PayPeriodDto,
  formatCurrency,
  useApprovePayPeriod,
  useCreatePayPeriod,
  useMarkPaid,
  usePayPeriods,
  useProcessPayPeriod,
} from '@/hooks/use-payroll';

/**
 * Payroll dashboard. Admin-only writes (hr-003:admin); read surface is
 * hr-003:read which every employee holds — but the period table only
 * makes sense for admin operators, so non-admins see a redirect to
 * /hr/payroll/payslips.
 */
export default function PayrollDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['hr-003:admin', 'sch-001:admin']);
  const { toast } = useToast();
  const periods = usePayPeriods();
  const create = useCreatePayPeriod();
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [payDate, setPayDate] = useState('');

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          The payroll dashboard is restricted to school administrators.
          <div className="mt-3">
            <Link className="text-sky-700 hover:underline" href="/hr/payroll/payslips">
              View my payslips →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/hr/payroll/payslips">
            My payslips
          </Link>
          <button
            className="rounded bg-sky-600 px-3 py-1.5 font-semibold text-white hover:bg-sky-700"
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? 'Cancel' : 'New pay period'}
          </button>
        </div>
      </div>

      {showCreate ? (
        <section className="rounded border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-base font-semibold">Open new pay period</h2>
          <div className="grid gap-2 md:grid-cols-4">
            <input
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              placeholder="Period label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <input
              type="date"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <input
              type="date"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <input
              type="date"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
            />
            <div className="md:col-span-4 flex justify-end">
              <button
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-300"
                disabled={!label.trim() || !startDate || !endDate || !payDate || create.isPending}
                onClick={async () => {
                  try {
                    await create.mutateAsync({
                      periodLabel: label.trim(),
                      startDate,
                      endDate,
                      payDate,
                    });
                    toast('Pay period opened');
                    setShowCreate(false);
                    setLabel('');
                    setStartDate('');
                    setEndDate('');
                    setPayDate('');
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                Open
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-base font-semibold">Pay periods</h2>
        <table className="min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Period</th>
              <th>Pay date</th>
              <th>Status</th>
              <th>Records</th>
              <th>Gross</th>
              <th>Deductions</th>
              <th>Net</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(periods.data ?? []).map((p) => (
              <PayPeriodRow key={p.id} period={p} />
            ))}
            {(periods.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={8} className="py-2 text-slate-500">
                  No pay periods yet. Open one above.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function PayPeriodRow({ period }: { period: PayPeriodDto }) {
  const { toast } = useToast();
  const proc = useProcessPayPeriod(period.id);
  const approve = useApprovePayPeriod(period.id);
  const mark = useMarkPaid(period.id);
  return (
    <tr className="align-top">
      <td className="py-2 font-medium">{period.periodLabel}</td>
      <td>{period.payDate}</td>
      <td>
        <span className={`rounded px-2 py-0.5 text-xs ${PAY_PERIOD_STATUS_PILL[period.status]}`}>
          {PAY_PERIOD_STATUS_LABEL[period.status]}
        </span>
      </td>
      <td>{period.recordCount}</td>
      <td>{formatCurrency(period.totalGross)}</td>
      <td>{formatCurrency(period.totalDeductions)}</td>
      <td className="font-semibold">{formatCurrency(period.totalNet)}</td>
      <td className="space-x-2 text-xs text-right">
        {period.status === 'OPEN' || period.status === 'PROCESSING' ? (
          <button
            className="text-sky-700 hover:underline"
            onClick={async () => {
              try {
                const r = await proc.mutateAsync();
                toast(`Processed ${r.processed} records (${r.skipped} skipped)`);
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Process
          </button>
        ) : null}
        {period.status === 'PROCESSING' ? (
          <button
            className="text-amber-700 hover:underline"
            onClick={async () => {
              try {
                await approve.mutateAsync();
                toast('Period approved');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Approve
          </button>
        ) : null}
        {period.status === 'PROCESSING' ? (
          <button
            className="text-emerald-700 hover:underline"
            onClick={async () => {
              if (
                !window.confirm(
                  'Mark this period PAID? hr.payroll.processed will fire for the GLConsumer.',
                )
              )
                return;
              try {
                await mark.mutateAsync();
                toast('Period marked PAID — GL consumer will post journal entries.');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Mark paid
          </button>
        ) : null}
      </td>
    </tr>
  );
}
