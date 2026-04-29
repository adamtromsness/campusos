'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCancelInvoice, useInvoice, usePayments, useSendInvoice } from '@/hooks/use-billing';
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

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const isWriter = !!user && hasAnyPermission(user, ['fin-001:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const invoice = useInvoice(id, !!user);
  const payments = usePayments({ invoiceId: id }, !!user);
  const send = useSendInvoice(id);
  const cancel = useCancelInvoice(id);
  const { toast } = useToast();

  if (!user) return null;
  if (!isWriter) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Invoice" description="Billing access required." />
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
        <PageHeader title="Invoice" />
        <EmptyState title="Invoice not found" />
      </div>
    );
  }

  const inv = invoice.data;
  const canSend = inv.status === 'DRAFT';
  const canCancel = inv.status !== 'PAID' && inv.status !== 'CANCELLED';
  const canPay = inv.balanceDue > 0 && inv.status !== 'DRAFT' && inv.status !== 'CANCELLED';

  async function onSend() {
    try {
      await send.mutateAsync();
      toast('Invoice sent', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not send invoice', 'error');
    }
  }

  async function onCancel() {
    if (!window.confirm('Cancel this invoice?')) return;
    try {
      await cancel.mutateAsync();
      toast('Invoice cancelled', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not cancel invoice', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/billing/invoices" className="text-sm text-gray-500 hover:text-campus-700">
        ← Invoices
      </Link>
      <div className="mt-3 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="font-display text-2xl text-campus-700">{inv.title}</h1>
            <p className="mt-1 text-sm text-gray-500">
              <Link
                href={`/billing/accounts/${inv.familyAccountId}`}
                className="hover:text-campus-700"
              >
                {inv.familyAccountNumber} — {inv.familyAccountHolderName}
              </Link>
            </p>
            {inv.description && <p className="mt-3 text-sm text-gray-600">{inv.description}</p>}
          </div>
          <div className="flex flex-col items-end gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                INVOICE_STATUS_PILL[inv.status]
              }`}
            >
              {INVOICE_STATUS_LABELS[inv.status]}
            </span>
            <div className="flex items-center gap-2">
              {canPay && (
                <Link
                  href={`/billing/pay/${inv.id}`}
                  className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
                >
                  Pay now →
                </Link>
              )}
              {isAdmin && canSend && (
                <button
                  type="button"
                  onClick={onSend}
                  disabled={send.isPending}
                  className="rounded-lg border border-campus-300 bg-white px-3 py-1.5 text-sm font-medium text-campus-700 transition-colors hover:bg-campus-50 disabled:opacity-50"
                >
                  {send.isPending ? 'Sending…' : 'Send invoice'}
                </button>
              )}
              {isAdmin && canCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={cancel.isPending}
                  className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={formatCurrency(inv.totalAmount)} />
          <Stat label="Paid" value={formatCurrency(inv.amountPaid)} tone="emerald" />
          <Stat label="Balance due" value={formatCurrency(inv.balanceDue)} tone="rose" />
          <Stat label="Due date" value={formatDateOnly(inv.dueDate)} />
        </div>

        {inv.sentAt && (
          <p className="mt-3 text-xs text-gray-500">Sent {formatDateTime(inv.sentAt)}</p>
        )}

        <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-gray-700">
          Line items
        </h2>
        <table className="mt-2 w-full text-sm">
          <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2 text-right">Qty</th>
              <th className="px-2 py-2 text-right">Unit price</th>
              <th className="px-2 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {inv.lineItems.map((li) => (
              <tr key={li.id}>
                <td className="px-2 py-2">
                  <p className="font-medium text-gray-900">{li.description}</p>
                  {li.feeScheduleName && (
                    <p className="text-xs text-gray-500">via {li.feeScheduleName}</p>
                  )}
                </td>
                <td className="px-2 py-2 text-right text-gray-600">{li.quantity}</td>
                <td className="px-2 py-2 text-right text-gray-600">
                  {formatCurrency(li.unitPrice)}
                </td>
                <td className="px-2 py-2 text-right font-semibold text-gray-900">
                  {formatCurrency(li.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-6 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Payment history
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
                  <th className="px-2 py-2">Method</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(payments.data ?? []).map((p) => (
                  <tr key={p.id}>
                    <td className="px-2 py-2 text-gray-600">{formatDateTime(p.paidAt)}</td>
                    <td className="px-2 py-2 text-gray-600">
                      {PAYMENT_METHOD_LABELS[p.paymentMethod]}
                    </td>
                    <td className="px-2 py-2 font-semibold text-gray-900">
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
    <div className={`rounded-lg px-3 py-2 ${cls}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}
