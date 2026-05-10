'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useStudent } from '@/hooks/use-children';
import { useLunchAccountForStudent, useDepositLunchAccount } from '@/hooks/use-payments-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  LUNCH_TX_TYPE_LABELS,
  LUNCH_TX_TYPE_PILL,
  formatCurrency,
  isLowBalance,
  lunchBalanceTone,
} from '@/lib/billing-format';

export default function ChildLunchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: studentId } = use(params);
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['fin-001:read', 'fin-001:write']);
  const child = useStudent(studentId);
  const account = useLunchAccountForStudent(studentId, canRead);
  const [depositOpen, setDepositOpen] = useState(false);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Lunch account" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }

  const childName = child.data ? `${child.data.firstName} ${child.data.lastName}` : 'Student';

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title={`${childName} — Lunch account`}
        actions={
          account.data ? (
            <button
              type="button"
              onClick={() => setDepositOpen(true)}
              className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800"
            >
              Add funds
            </button>
          ) : null
        }
      />
      <p className="-mt-3 text-sm">
        <Link href="/payments/lunch" className="text-campus-700 hover:underline">
          ← Back to lunch overview
        </Link>
      </p>

      {account.isLoading ? (
        <LoadingSpinner />
      ) : !account.data ? (
        <EmptyState
          title="No lunch account"
          description="This child doesn't have a lunch account yet. Contact the school office."
        />
      ) : (
        <div className="space-y-4">
          <BalanceCard account={account.data.account} />
          <TransactionsCard transactions={account.data.transactions} />
        </div>
      )}

      {depositOpen && account.data && (
        <DepositModal accountId={account.data.account.id} onClose={() => setDepositOpen(false)} />
      )}
    </div>
  );
}

function BalanceCard({ account }: { account: import('@/lib/types').LunchAccountDto }) {
  const low = isLowBalance(account);
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Current balance</p>
      <p className={`mt-1 text-3xl font-bold ${lunchBalanceTone(account)}`}>
        {formatCurrency(account.balance)}
      </p>
      <p className="mt-1 text-xs text-gray-600">
        Threshold: {formatCurrency(account.lowBalanceThreshold)}
        {low && (
          <span className="ml-2 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            Below threshold
          </span>
        )}
      </p>
    </div>
  );
}

function TransactionsCard({
  transactions,
}: {
  transactions: import('@/lib/types').LunchTransactionDto[];
}) {
  if (transactions.length === 0) {
    return (
      <EmptyState
        title="No transactions yet"
        description="Cafeteria meal charges and deposits will appear here."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {transactions.map((t) => (
            <tr key={t.id} className="hover:bg-gray-50">
              <td className="px-3 py-2 text-gray-600">
                {t.mealDate ?? new Date(t.createdAt).toLocaleDateString()}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${LUNCH_TX_TYPE_PILL[t.transactionType]}`}
                >
                  {LUNCH_TX_TYPE_LABELS[t.transactionType]}
                </span>
              </td>
              <td
                className={`px-3 py-2 text-right font-semibold ${
                  t.transactionType === 'MEAL_CHARGE' || t.transactionType === 'ADJUSTMENT'
                    ? 'text-rose-700'
                    : 'text-emerald-700'
                }`}
              >
                {t.transactionType === 'MEAL_CHARGE' ? '-' : '+'}
                {formatCurrency(t.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DepositModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const deposit = useDepositLunchAccount(accountId);
  const { toast } = useToast();
  const [amount, setAmount] = useState('25');
  const [notes, setNotes] = useState('');

  async function submit() {
    try {
      await deposit.mutateAsync({ amount: Number(amount), notes: notes || undefined });
      toast(`Deposited ${formatCurrency(Number(amount))}`, 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Deposit failed', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add funds to lunch account"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!amount || deposit.isPending}
            onClick={submit}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Deposit
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Amount ($)</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
