'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useFamilyAccounts,
  useFamilyAccountBalance,
  useInvoices,
  usePayments,
} from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
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
import type { InvoiceDto } from '@/lib/types';

export default function ParentBillingDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const isGuardian = !!user && user.personType === 'GUARDIAN';
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const canRead = !!user && hasAnyPermission(user, ['fin-001:read', 'fin-001:write']);

  // Admins land on /billing/accounts — keep this page parent-focused.
  useEffect(() => {
    if (isAdmin) router.replace('/billing/accounts');
  }, [isAdmin, router]);

  const accounts = useFamilyAccounts(canRead && !isAdmin);
  const account = (accounts.data ?? [])[0] ?? null;
  const accountId = account?.id;
  const balance = useFamilyAccountBalance(accountId, !!accountId);
  const invoices = useInvoices({ familyAccountId: accountId }, !!accountId);
  const payments = usePayments({ familyAccountId: accountId }, !!accountId);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }
  if (isAdmin) return null; // about to redirect
  if (!isGuardian) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing" />
        <EmptyState
          title="Not available"
          description="The parent billing view is only for guardian accounts."
        />
      </div>
    );
  }

  if (accounts.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing" />
        <EmptyState
          title="No family account yet"
          description="Once a child is enrolled, your family account will appear here automatically."
        />
      </div>
    );
  }

  const currentBalance = balance.data?.balance ?? account.balance;
  const balanceTone =
    currentBalance > 0 ? 'rose' : currentBalance < 0 ? 'emerald' : 'normal';
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
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Billing"
        description={`${account.accountNumber} · ${account.accountHolderName}`}
        actions={
          <Link
            href="/billing/ledger"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            View ledger
          </Link>
        }
      />

      <section className="mt-4 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Current balance"
            value={formatCurrency(currentBalance)}
            tone={balanceTone}
          />
          <Stat
            label="Outstanding invoices"
            value={String(outstanding.length)}
            tone={outstanding.length > 0 ? 'rose' : 'normal'}
          />
          <Stat
            label="Children on account"
            value={String(account.students.length)}
          />
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

      <section className="mt-6 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Outstanding invoices
        </h2>
        <div className="mt-3">
          {invoices.isLoading ? (
            <LoadingSpinner />
          ) : outstanding.length === 0 ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              You’re all paid up — no invoices need your attention.
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

      <section className="mt-6 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
            Recent payments
          </h2>
          <Link
            href="/billing/payments"
            className="text-sm text-campus-700 hover:text-campus-900"
          >
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
          <p className="mt-0.5 text-xs text-gray-500">
            Due {formatDateOnly(invoice.dueDate)}
          </p>
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
          <p className="font-semibold text-emerald-700">
            {formatCurrency(invoice.amountPaid)}
          </p>
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
