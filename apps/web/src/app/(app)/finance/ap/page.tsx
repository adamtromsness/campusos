'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, Modal, useToast } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useAPVouchers, usePayAPVoucher, useTransitionAPVoucher } from '@/hooks/use-finance';
import { AP_STATUS_LABELS, AP_STATUS_PILL, formatCurrency, formatDate } from '@/lib/finance-format';
import type { FinAPStatus, FinAPVoucherDto, FinPaymentMethod } from '@/lib/types';

const STATUS_FILTERS: Array<FinAPStatus | 'ALL'> = [
  'ALL',
  'PENDING',
  'APPROVED',
  'PAID',
  'ON_HOLD',
  'VOIDED',
];

export default function APPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['fin-007:admin']);
  const [filter, setFilter] = useState<FinAPStatus | 'ALL'>('ALL');
  const vouchersQ = useAPVouchers(filter === 'ALL' ? undefined : { status: filter });
  const vouchers = vouchersQ.data ?? [];
  const transitionMut = useTransitionAPVoucher();
  const payMut = usePayAPVoucher();
  const { toast } = useToast();
  const [paying, setPaying] = useState<FinAPVoucherDto | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<FinPaymentMethod>('CHECK');
  const [paymentReference, setPaymentReference] = useState('');

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Accounts payable"
        description="Supplier vouchers and payments. Pay = auto GL post."
      />
      <Link href="/finance" className="text-sm text-campus-700 hover:underline">
        ← Back to finance
      </Link>

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${filter === s ? 'bg-campus-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            {s === 'ALL' ? 'All' : AP_STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Voucher</th>
              <th className="px-4 py-2 text-left">Supplier</th>
              <th className="px-4 py-2 text-left">Invoice</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2 text-right">Paid</th>
              <th className="px-4 py-2 text-right">Balance</th>
              <th className="px-4 py-2 text-left">Due</th>
              <th className="px-4 py-2 text-left">Status</th>
              {isAdmin && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {vouchers.map((v) => {
              const overdue = v.balanceDue > 0 && new Date(v.dueDate) < new Date();
              return (
                <tr key={v.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-xs">{v.voucherNumber}</td>
                  <td className="px-4 py-2">{v.supplierName}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{v.invoiceNumber ?? '—'}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatCurrency(v.totalAmount)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{formatCurrency(v.amountPaid)}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    <span className={overdue ? 'text-rose-700' : ''}>
                      {formatCurrency(v.balanceDue)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <span className={overdue ? 'text-rose-700' : 'text-gray-600'}>
                      {formatDate(v.dueDate)}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${AP_STATUS_PILL[v.status]}`}
                    >
                      {AP_STATUS_LABELS[v.status]}
                    </span>
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        {v.status === 'PENDING' && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await transitionMut.mutateAsync({ id: v.id, action: 'APPROVE' });
                                toast(`${v.voucherNumber} approved.`, 'success');
                              } catch (e: unknown) {
                                toast((e as Error).message, 'error');
                              }
                            }}
                            className="rounded bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-200"
                          >
                            Approve
                          </button>
                        )}
                        {v.status === 'APPROVED' && (
                          <button
                            type="button"
                            onClick={() => setPaying(v)}
                            className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-200"
                          >
                            Pay
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {vouchers.length === 0 && (
              <tr>
                <td
                  colSpan={isAdmin ? 9 : 8}
                  className="px-4 py-8 text-center text-sm text-gray-500"
                >
                  No vouchers match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!paying}
        onClose={() => {
          setPaying(null);
          setPaymentReference('');
        }}
        title={paying ? `Pay ${paying.voucherNumber}` : ''}
        footer={
          paying && (
            <div className="flex w-full justify-end gap-2">
              <button
                type="button"
                onClick={() => setPaying(null)}
                className="rounded bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await payMut.mutateAsync({
                      id: paying.id,
                      paymentMethod,
                      amount: paying.balanceDue,
                      paymentReference: paymentReference || undefined,
                    });
                    toast(`${paying.voucherNumber} paid — GL batch posted.`, 'success');
                    setPaying(null);
                    setPaymentReference('');
                  } catch (e: unknown) {
                    toast((e as Error).message, 'error');
                  }
                }}
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Pay {formatCurrency(paying.balanceDue)}
              </button>
            </div>
          )
        }
      >
        {paying && (
          <div className="space-y-3 text-sm">
            <p>
              Paying {formatCurrency(paying.balanceDue)} to {paying.supplierName}.
            </p>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-gray-500">Method</span>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as FinPaymentMethod)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              >
                <option value="CHECK">Check</option>
                <option value="ACH">ACH</option>
                <option value="WIRE">Wire</option>
                <option value="CREDIT_CARD">Credit Card</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-gray-500">
                Reference (optional)
              </span>
              <input
                type="text"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="e.g. CHK-1042"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <p className="text-xs text-gray-500">
              Paying creates an <code>fin_ap_payments</code> row AND posts a balanced GL batch
              (DEBIT GL account / CREDIT Cash) inside one tenant transaction. The voucher status
              flips to PAID atomically.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
