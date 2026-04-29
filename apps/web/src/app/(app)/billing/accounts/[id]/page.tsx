'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useFamilyAccount,
  useFamilyAccountBalance,
  useFamilyAccountLedger,
  useInvoices,
  usePayments,
} from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ENTRY_TYPE_LABELS,
  ENTRY_TYPE_PILL,
  FAMILY_ACCOUNT_STATUS_LABELS,
  FAMILY_ACCOUNT_STATUS_PILL,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_PILL,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_PILL,
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  formatSignedCurrency,
} from '@/lib/billing-format';

export default function FamilyAccountDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const isWriter = !!user && hasAnyPermission(user, ['fin-001:write']);
  const account = useFamilyAccount(id, !!user);
  const balance = useFamilyAccountBalance(id, !!user);
  const ledger = useFamilyAccountLedger(id, { limit: 50 }, !!user);
  const invoices = useInvoices({ familyAccountId: id }, !!user);
  const payments = usePayments({ familyAccountId: id }, !!user);

  if (!user) return null;
  if (!isWriter) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Family Account" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }
  if (account.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (account.isError || !account.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Family Account" />
        <EmptyState title="Account not found" />
      </div>
    );
  }

  const a = account.data;

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/billing/accounts" className="text-sm text-gray-500 hover:text-campus-700">
        ← Accounts
      </Link>

      <div className="mt-3 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="font-display text-2xl text-campus-700">
              {a.accountNumber}
            </h1>
            <p className="mt-1 text-sm font-medium text-gray-900">{a.accountHolderName}</p>
            {a.accountHolderEmail && (
              <p className="text-xs text-gray-500">{a.accountHolderEmail}</p>
            )}
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              FAMILY_ACCOUNT_STATUS_PILL[a.status]
            }`}
          >
            {FAMILY_ACCOUNT_STATUS_LABELS[a.status]}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat
            label="Current balance"
            value={formatCurrency(balance.data?.balance ?? a.balance)}
            tone={
              (balance.data?.balance ?? a.balance) > 0
                ? 'rose'
                : (balance.data?.balance ?? a.balance) < 0
                  ? 'emerald'
                  : 'normal'
            }
          />
          <Stat label="Students" value={String(a.students.length)} />
          <Stat label="Auth policy" value={a.paymentAuthorisationPolicy.replace(/_/g, ' ')} />
        </div>

        <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-gray-700">
          Linked students
        </h2>
        {a.students.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No students linked yet.</p>
        ) : (
          <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {a.students.map((s) => (
              <li
                key={s.studentId}
                className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
              >
                <p className="font-medium text-gray-900">
                  {s.firstName} {s.lastName}
                </p>
                <p className="text-xs text-gray-500">
                  Student #{s.studentNumber} · Grade {s.gradeLevel}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="mt-6 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Invoices
        </h2>
        <div className="mt-3">
          {invoices.isLoading ? (
            <LoadingSpinner />
          ) : (invoices.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">No invoices.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2 py-2">Invoice</th>
                  <th className="px-2 py-2 text-right">Total</th>
                  <th className="px-2 py-2 text-right">Balance</th>
                  <th className="px-2 py-2">Due</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(invoices.data ?? []).map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-2 py-2">
                      <Link
                        href={`/billing/invoices/${inv.id}`}
                        className="font-medium text-campus-700 hover:text-campus-900"
                      >
                        {inv.title}
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-right font-semibold text-gray-900">
                      {formatCurrency(inv.totalAmount)}
                    </td>
                    <td className="px-2 py-2 text-right text-rose-700">
                      {formatCurrency(inv.balanceDue)}
                    </td>
                    <td className="px-2 py-2 text-gray-600">{formatDateOnly(inv.dueDate)}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          INVOICE_STATUS_PILL[inv.status]
                        }`}
                      >
                        {INVOICE_STATUS_LABELS[inv.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="mt-6 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Payments
        </h2>
        <div className="mt-3">
          {payments.isLoading ? (
            <LoadingSpinner />
          ) : (payments.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">No payments yet.</p>
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
                {(payments.data ?? []).map((p) => (
                  <tr key={p.id}>
                    <td className="px-2 py-2 text-gray-600">{formatDateTime(p.paidAt)}</td>
                    <td className="px-2 py-2 text-gray-600">
                      <Link
                        href={`/billing/invoices/${p.invoiceId}`}
                        className="hover:text-campus-700"
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

      <section className="mt-6 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Ledger
        </h2>
        <div className="mt-3">
          {ledger.isLoading ? (
            <LoadingSpinner />
          ) : (ledger.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">No ledger entries yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(ledger.data ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="px-2 py-2 text-gray-600">{formatDateTime(e.createdAt)}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          ENTRY_TYPE_PILL[e.entryType]
                        }`}
                      >
                        {ENTRY_TYPE_LABELS[e.entryType]}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-gray-600">{e.description ?? '—'}</td>
                    <td
                      className={`px-2 py-2 text-right font-semibold ${
                        e.amount >= 0 ? 'text-rose-700' : 'text-emerald-700'
                      }`}
                    >
                      {formatSignedCurrency(e.amount)}
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
