'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useInvoice, usePayInvoice } from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_PILL,
  PAYMENT_METHOD_LABELS,
  formatCurrency,
  formatDateOnly,
} from '@/lib/billing-format';
import type { PaymentMethod } from '@/lib/types';

const PARENT_PAYMENT_METHODS: PaymentMethod[] = ['CARD', 'BANK_TRANSFER'];

export default function PayInvoicePage() {
  const params = useParams<{ invoiceId: string }>();
  const invoiceId = params?.invoiceId ?? '';
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const canPay = !!user && hasAnyPermission(user, ['fin-001:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const invoice = useInvoice(invoiceId, canPay);
  const pay = usePayInvoice(invoiceId);
  const { toast } = useToast();

  const [amountStr, setAmountStr] = useState<string>('');
  const [method, setMethod] = useState<PaymentMethod>('CARD');
  const [notes, setNotes] = useState<string>('');

  // Default the amount to the full balance due once the invoice loads.
  useEffect(() => {
    if (invoice.data && amountStr === '') {
      setAmountStr(invoice.data.balanceDue.toFixed(2));
    }
  }, [invoice.data, amountStr]);

  if (!user) return null;
  if (!canPay) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Pay invoice" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }
  if (invoice.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (invoice.isError || !invoice.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Pay invoice" />
        <EmptyState title="Invoice not found" />
      </div>
    );
  }

  const inv = invoice.data;
  const isPayable =
    inv.balanceDue > 0 && inv.status !== 'DRAFT' && inv.status !== 'CANCELLED';

  if (!isPayable) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link
          href={`/billing/invoices/${inv.id}`}
          className="text-sm text-gray-500 hover:text-campus-700"
        >
          ← Invoice
        </Link>
        <PageHeader title="Pay invoice" description={inv.title} />
        <EmptyState
          title="This invoice can’t be paid"
          description={
            inv.status === 'DRAFT'
              ? 'The school hasn’t sent this invoice yet.'
              : inv.status === 'CANCELLED'
                ? 'This invoice has been cancelled.'
                : `Balance due is ${formatCurrency(inv.balanceDue)}.`
          }
        />
      </div>
    );
  }

  const amount = Number(amountStr);
  const amountValid =
    !Number.isNaN(amount) && amount > 0 && amount <= inv.balanceDue + 0.001;
  const methods = isAdmin
    ? (['CARD', 'BANK_TRANSFER', 'CASH', 'CHEQUE', 'WAIVER'] as PaymentMethod[])
    : PARENT_PAYMENT_METHODS;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!amountValid) {
      toast(`Enter an amount between $0.01 and ${formatCurrency(inv.balanceDue)}`, 'error');
      return;
    }
    try {
      await pay.mutateAsync({
        amount: Number(amount.toFixed(2)),
        paymentMethod: method,
        notes: notes.trim() || undefined,
      });
      toast(
        method === 'CARD'
          ? `Paid ${formatCurrency(amount)} by card.`
          : `Recorded ${formatCurrency(amount)} ${PAYMENT_METHOD_LABELS[method].toLowerCase()} payment.`,
        'success',
      );
      router.push(`/billing/invoices/${inv.id}`);
    } catch (err: any) {
      toast(err?.message || 'Payment failed', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/billing/invoices/${inv.id}`}
        className="text-sm text-gray-500 hover:text-campus-700"
      >
        ← Invoice
      </Link>

      <div className="mt-3 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="font-display text-2xl text-campus-700">{inv.title}</h1>
            <p className="mt-1 text-sm text-gray-500">
              {inv.familyAccountNumber} — {inv.familyAccountHolderName}
            </p>
            {inv.dueDate && (
              <p className="mt-0.5 text-xs text-gray-500">
                Due {formatDateOnly(inv.dueDate)}
              </p>
            )}
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              INVOICE_STATUS_PILL[inv.status]
            }`}
          >
            {INVOICE_STATUS_LABELS[inv.status]}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Total" value={formatCurrency(inv.totalAmount)} />
          <Stat label="Paid" value={formatCurrency(inv.amountPaid)} tone="emerald" />
          <Stat label="Balance due" value={formatCurrency(inv.balanceDue)} tone="rose" />
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="mt-6 space-y-4 rounded-card border border-gray-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-gray-900">Make a payment</h2>

        <div>
          <label
            htmlFor="amount"
            className="block text-sm font-medium text-gray-700"
          >
            Amount (USD)
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              max={inv.balanceDue.toFixed(2)}
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
            <button
              type="button"
              onClick={() => setAmountStr(inv.balanceDue.toFixed(2))}
              className="text-xs text-campus-700 hover:text-campus-900"
            >
              Pay full balance ({formatCurrency(inv.balanceDue)})
            </button>
          </div>
          {!amountValid && amountStr !== '' && (
            <p className="mt-1 text-xs text-rose-700">
              Amount must be between $0.01 and {formatCurrency(inv.balanceDue)}.
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Method</label>
          <div className="mt-2 flex flex-wrap gap-2">
            {methods.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  m === method
                    ? 'border-campus-700 bg-campus-700 text-white'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-campus-400'
                }`}
              >
                {PAYMENT_METHOD_LABELS[m]}
              </button>
            ))}
          </div>
          {!isAdmin && method === 'BANK_TRANSFER' && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              For bank transfers, the payment is recorded immediately but funds usually arrive
              in 1–3 business days. Your invoice status will reflect the payment right away.
            </p>
          )}
          {method === 'CARD' && (
            <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
              Card payments are processed in test mode. No real card is charged — the invoice
              will be marked paid immediately.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
            Notes <span className="text-xs text-gray-500">(optional)</span>
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            rows={2}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            placeholder="Reference number, scholarship code, etc."
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Link
            href={`/billing/invoices/${inv.id}`}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!amountValid || pay.isPending}
            className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {pay.isPending
              ? 'Processing…'
              : `Pay ${amountValid ? formatCurrency(amount) : ''}`.trim()}
          </button>
        </div>
      </form>
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
