'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useFamilyAccounts, useIssueRefund, usePayments } from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_PILL,
  REFUND_CATEGORIES,
  REFUND_CATEGORY_LABELS,
  formatCurrency,
  formatDateTime,
} from '@/lib/billing-format';
import type {
  PaymentDto,
  PaymentMethod,
  PaymentStatus,
  RefundCategory,
} from '@/lib/types';

export default function BillingPaymentsPage() {
  const user = useAuthStore((s) => s.user);
  const isWriter = !!user && hasAnyPermission(user, ['fin-001:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const accounts = useFamilyAccounts(!!user);
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | 'ALL'>('ALL');
  const [methodFilter, setMethodFilter] = useState<PaymentMethod | 'ALL'>('ALL');
  const [accountFilter, setAccountFilter] = useState<string>('');
  const [refundTarget, setRefundTarget] = useState<PaymentDto | null>(null);

  const payments = usePayments(
    {
      familyAccountId: accountFilter || undefined,
      status: statusFilter === 'ALL' ? undefined : statusFilter,
    },
    !!user,
  );

  if (!user) return null;
  if (!isWriter) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing — Payments" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }

  const rows = (payments.data ?? []).filter(
    (p) => methodFilter === 'ALL' || p.paymentMethod === methodFilter,
  );

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Payments"
        description="Recorded payments across families, with refund actions for completed rows."
      />

      <BillingTabs active="payments" />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <FilterChip
          label="All"
          active={statusFilter === 'ALL'}
          onClick={() => setStatusFilter('ALL')}
        />
        {PAYMENT_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={PAYMENT_STATUS_LABELS[s]}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          />
        ))}
        <select
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value as PaymentMethod | 'ALL')}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          <option value="ALL">All methods</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="ml-auto rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          <option value="">All families</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.accountNumber} — {a.accountHolderName}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {payments.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16">
            <EmptyState title="No payments match" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Paid at</th>
                <th className="px-4 py-2">Family</th>
                <th className="px-4 py-2">Invoice</th>
                <th className="px-4 py-2">Method</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-600">{formatDateTime(p.paidAt ?? p.createdAt)}</td>
                  <td className="px-4 py-2 text-gray-600">
                    <Link
                      href={`/billing/accounts/${p.familyAccountId}`}
                      className="hover:text-campus-700"
                    >
                      {p.familyAccountNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/billing/invoices/${p.invoiceId}`}
                      className="font-medium text-campus-700 hover:text-campus-900"
                    >
                      {p.invoiceTitle}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {PAYMENT_METHOD_LABELS[p.paymentMethod]}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-900">
                    {formatCurrency(p.amount)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        PAYMENT_STATUS_PILL[p.status]
                      }`}
                    >
                      {PAYMENT_STATUS_LABELS[p.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {isAdmin && p.status === 'COMPLETED' && (
                      <button
                        type="button"
                        onClick={() => setRefundTarget(p)}
                        className="text-xs font-medium text-rose-700 hover:text-rose-900"
                      >
                        Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {refundTarget && (
        <RefundModal payment={refundTarget} onClose={() => setRefundTarget(null)} />
      )}
    </div>
  );
}

function BillingTabs({ active }: { active: 'accounts' | 'invoices' | 'payments' | 'fees' }) {
  const items: { key: typeof active; label: string; href: string }[] = [
    { key: 'accounts', label: 'Accounts', href: '/billing/accounts' },
    { key: 'invoices', label: 'Invoices', href: '/billing/invoices' },
    { key: 'payments', label: 'Payments', href: '/billing/payments' },
    { key: 'fees', label: 'Fees', href: '/billing/fees' },
  ];
  return (
    <nav className="mt-2 flex gap-3 text-sm">
      {items.map((it, i) => (
        <span key={it.key} className="flex items-center gap-3">
          {it.key === active ? (
            <span className="font-medium text-campus-700">{it.label}</span>
          ) : (
            <Link href={it.href} className="text-gray-500 hover:text-campus-700">
              {it.label}
            </Link>
          )}
          {i < items.length - 1 && <span className="text-gray-300">·</span>}
        </span>
      ))}
    </nav>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-campus-700 text-white'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      }`}
    >
      {label}
    </button>
  );
}

function RefundModal({ payment, onClose }: { payment: PaymentDto; onClose: () => void }) {
  const { toast } = useToast();
  const refund = useIssueRefund(payment.id);
  const [amount, setAmount] = useState(String(payment.amount));
  const [refundCategory, setRefundCategory] = useState<RefundCategory>('OVERPAYMENT');
  const [reason, setReason] = useState('');

  async function onSubmit() {
    const amt = Number(amount);
    if (Number.isNaN(amt) || amt <= 0) {
      toast('Amount must be > 0', 'error');
      return;
    }
    if (amt > payment.amount) {
      toast(`Cannot exceed payment amount of ${formatCurrency(payment.amount)}`, 'error');
      return;
    }
    if (!reason.trim()) {
      toast('Reason is required', 'error');
      return;
    }
    try {
      await refund.mutateAsync({
        amount: amt,
        refundCategory,
        reason: reason.trim(),
      });
      toast('Refund issued', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not issue refund', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Issue refund"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={refund.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={refund.isPending}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
          >
            {refund.isPending ? 'Issuing…' : 'Issue refund'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-gray-50 p-3 text-sm">
          <p>
            <span className="text-gray-500">Payment:</span>{' '}
            <span className="font-medium text-gray-900">{payment.invoiceTitle}</span>
          </p>
          <p>
            <span className="text-gray-500">Family:</span>{' '}
            <span className="font-medium text-gray-900">{payment.familyAccountNumber}</span>
          </p>
          <p>
            <span className="text-gray-500">Amount:</span>{' '}
            <span className="font-medium text-gray-900">
              {formatCurrency(payment.amount)} ({PAYMENT_METHOD_LABELS[payment.paymentMethod]})
            </span>
          </p>
        </div>
        <Field label="Refund amount (USD)" required>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min={0.01}
            max={payment.amount}
            step="0.01"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Default is the full payment amount; partial refunds leave the payment as Completed.
          </p>
        </Field>
        <Field label="Category" required>
          <select
            value={refundCategory}
            onChange={(e) => setRefundCategory(e.target.value as RefundCategory)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            {REFUND_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {REFUND_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason" required>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Required justification — appears on the refund record."
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
