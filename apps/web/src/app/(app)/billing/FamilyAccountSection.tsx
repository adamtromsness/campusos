'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFamilyAccountBalance, useInvoices, usePayments } from '@/hooks/use-billing';
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_PILL,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_PILL,
  formatCurrency,
  formatDateOnly,
  formatDateTime,
} from '@/lib/billing-format';
import type { FamilyAccountDto, InvoiceDto } from '@/lib/types';

export function FamilyAccountSection({ account }: { account: FamilyAccountDto }) {
  const balance = useFamilyAccountBalance(account.id);
  const invoices = useInvoices({ familyAccountId: account.id });
  const payments = usePayments({ familyAccountId: account.id });

  const currentBalance = balance.data?.balance ?? account.balance;
  const balanceTone = currentBalance > 0 ? 'rose' : currentBalance < 0 ? 'emerald' : 'normal';
  const allInvoices = invoices.data ?? [];
  const outstanding = allInvoices
    .filter((inv) => inv.balanceDue > 0 && inv.status !== 'CANCELLED')
    .sort((a, b) => {
      const ad = a.dueDate ?? '9999-12-31';
      const bd = b.dueDate ?? '9999-12-31';
      return ad.localeCompare(bd);
    });
  const recentPayments = (payments.data ?? []).slice(0, 5);

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-baseline justify-between gap-2">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            {account.accountNumber} · {account.accountHolderName}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Current balance" value={formatCurrency(currentBalance)} tone={balanceTone} />
          <Stat
            label="Outstanding invoices"
            value={String(outstanding.length)}
            tone={outstanding.length > 0 ? 'rose' : 'normal'}
          />
          <Stat label="Children on account" value={String(account.students.length)} />
        </div>
        {account.students.length > 0 && (
          <p className="mt-4 text-xs text-gray-500">
            For{' '}
            {account.students
              .map((s) => `${s.firstName} ${s.lastName} (Grade ${s.gradeLevel})`)
              .join(', ')}
          </p>
        )}
      </section>

      <section className="rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Outstanding invoices
        </h3>
        <div className="mt-3">
          {invoices.isLoading ? (
            <LoadingSpinner />
          ) : outstanding.length === 0 ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              You&rsquo;re all paid up — no invoices need your attention.
            </p>
          ) : (
            <ul className="space-y-3">
              {outstanding.map((inv) => (
                <OutstandingInvoiceRow key={inv.id} invoice={inv} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
            Recent payments
          </h3>
          <Link href="/billing/payments" className="text-sm text-campus-700 hover:text-campus-900">
            See all →
          </Link>
        </div>
        <div className="mt-3">
          {payments.isLoading ? (
            <LoadingSpinner />
          ) : recentPayments.length === 0 ? (
            <p className="py-4 text-sm text-gray-500">No payments yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2 py-2">Paid at</th>
                  <th className="px-2 py-2">Invoice</th>
                  <th className="px-2 py-2">Method</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recentPayments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-2 py-2 text-gray-600">{formatDateTime(p.paidAt)}</td>
                    <td className="px-2 py-2">
                      <Link
                        href={`/billing/invoices/${p.invoiceId}`}
                        className="text-campus-700 hover:text-campus-900"
                      >
                        {p.invoiceTitle}
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-gray-600">
                      {PAYMENT_METHOD_LABELS[p.paymentMethod]}
                    </td>
                    <td className="px-2 py-2 text-right font-semibold text-gray-900">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          PAYMENT_STATUS_PILL[p.status]
                        }`}
                      >
                        {PAYMENT_STATUS_LABELS[p.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function OutstandingInvoiceRow({ invoice }: { invoice: InvoiceDto }) {
  const canPay = invoice.status !== 'DRAFT' && invoice.status !== 'CANCELLED';
  return (
    <li className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link
            href={`/billing/invoices/${invoice.id}`}
            className="text-base font-semibold text-gray-900 hover:text-campus-700"
          >
            {invoice.title}
          </Link>
          <p className="mt-0.5 text-xs text-gray-500">Due {formatDateOnly(invoice.dueDate)}</p>
        </div>
        <span
          className={`inline-flex flex-shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            INVOICE_STATUS_PILL[invoice.status]
          }`}
        >
          {INVOICE_STATUS_LABELS[invoice.status]}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-gray-500">Total</p>
          <p className="font-semibold text-gray-900">{formatCurrency(invoice.totalAmount)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-gray-500">Paid</p>
          <p className="font-semibold text-emerald-700">{formatCurrency(invoice.amountPaid)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-gray-500">Balance due</p>
          <p className="font-semibold text-rose-700">{formatCurrency(invoice.balanceDue)}</p>
        </div>
      </div>

      {canPay && (
        <div className="mt-3 flex justify-end">
          <Link
            href={`/billing/pay/${invoice.id}`}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            Pay now →
          </Link>
        </div>
      )}
    </li>
  );
}

function Stat({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'emerald' | 'rose';
}) {
  const cls =
    tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-900'
      : tone === 'rose'
        ? 'bg-rose-50 text-rose-900'
        : 'bg-gray-50 text-gray-700';
  return (
    <div className={`rounded-lg px-4 py-3 ${cls}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
