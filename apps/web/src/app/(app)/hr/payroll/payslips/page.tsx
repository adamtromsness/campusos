'use client';

import Link from 'next/link';
import { PayrollRecordDto, formatCurrency, useMyPayslips } from '@/hooks/use-payroll';

/**
 * Employee self-service payslip viewer. The /hr/payroll/me/payslips
 * endpoint always binds to actor.employeeId server-side, so even an
 * admin viewing this page sees their own payslips only.
 */
export default function PayslipsPage() {
  const payslips = useMyPayslips();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">My Payslips</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/hr/payroll">
          ← Payroll
        </Link>
      </div>
      {(payslips.data ?? []).length === 0 ? (
        <div className="rounded border border-slate-200 bg-white p-5 text-sm text-slate-600">
          No payslips yet. They appear here once the school marks a pay period as paid.
        </div>
      ) : (
        <div className="space-y-4">
          {(payslips.data ?? []).map((p) => (
            <PayslipCard key={p.id} record={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function PayslipCard({ record }: { record: PayrollRecordDto }) {
  return (
    <section className="rounded border border-slate-200 bg-white p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">{record.payPeriodLabel}</h2>
          <div className="text-xs text-slate-500">Pay date {record.payDate}</div>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            record.status === 'PAID'
              ? 'bg-emerald-100 text-emerald-800'
              : record.status === 'APPROVED'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-700'
          }`}
        >
          {record.status}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div className="rounded bg-slate-50 p-3">
          <div className="text-xs uppercase text-slate-500">Gross</div>
          <div className="text-lg font-bold">{formatCurrency(record.grossPay)}</div>
        </div>
        <div className="rounded bg-rose-50 p-3">
          <div className="text-xs uppercase text-rose-700">Deductions</div>
          <div className="text-lg font-bold text-rose-700">
            -{formatCurrency(record.totalDeductions)}
          </div>
        </div>
        <div className="rounded bg-emerald-50 p-3">
          <div className="text-xs uppercase text-emerald-800">Net</div>
          <div className="text-lg font-bold text-emerald-800">{formatCurrency(record.netPay)}</div>
        </div>
      </div>
      {record.deductions.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase text-slate-500">Deduction breakdown</h3>
          <ul className="mt-1 text-sm">
            {record.deductions.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between border-b border-slate-100 py-1"
              >
                <span>
                  {d.deductionType.replace(/_/g, ' ')}
                  {d.isPretax ? (
                    <span className="ml-2 text-xs text-slate-500">(pre-tax)</span>
                  ) : null}
                </span>
                <span className="font-mono">-{formatCurrency(d.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
