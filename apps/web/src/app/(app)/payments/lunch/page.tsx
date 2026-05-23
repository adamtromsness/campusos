'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useMyChildren } from '@/hooks/use-children';
import { useLunchLowBalance, useTransferLunchBalance } from '@/hooks/use-payments-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { LUNCH_TRANSFER_TYPE_LABELS, formatCurrency, lunchBalanceTone } from '@/lib/billing-format';
import type { LunchAccountDto, LunchTransferType } from '@/lib/types';

export default function LunchAccountsDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const isGuardian = !!user && user.activePersona?.type === 'PARENT';
  const lowBalance = useLunchLowBalance(isAdmin);
  const children = useMyChildren();
  const [transferOpen, setTransferOpen] = useState(false);

  if (!user) return null;
  if (!isAdmin && !isGuardian) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Lunch accounts" />
        <EmptyState
          title="Not available"
          description="Lunch accounts are visible to admins and parents."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lunch accounts"
        description={
          isAdmin
            ? 'Per-student balance tracking. Cafeteria POS scans debit accounts via the LunchAccountConsumer.'
            : 'Top up your child’s lunch account and track meal charges.'
        }
        actions={
          isAdmin ? (
            <button
              type="button"
              onClick={() => setTransferOpen(true)}
              className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800"
            >
              Transfer balance
            </button>
          ) : null
        }
      />

      {isGuardian && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
            My children
          </h2>
          {children.isLoading ? (
            <LoadingSpinner />
          ) : (children.data?.length ?? 0) === 0 ? (
            <EmptyState title="No linked children" />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(children.data ?? []).map((c) => (
                <Link
                  key={c.id}
                  href={`/children/${c.id}/lunch`}
                  className="block rounded-md border border-gray-200 bg-white p-4 hover:border-campus-300 hover:shadow"
                >
                  <p className="text-sm font-semibold text-gray-900">
                    {c.firstName} {c.lastName}
                  </p>
                  <p className="text-xs text-gray-500">Grade {c.gradeLevel}</p>
                  <p className="mt-2 text-xs text-campus-700">View lunch account →</p>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {isAdmin && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
              Low balance accounts
            </h2>
            <span className="text-xs text-gray-500">
              {lowBalance.data?.length ?? 0} account(s) at or below threshold
            </span>
          </div>
          {lowBalance.isLoading ? (
            <LoadingSpinner />
          ) : (lowBalance.data?.length ?? 0) === 0 ? (
            <EmptyState
              title="All accounts above threshold"
              description="Nothing requires action."
            />
          ) : (
            <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Student</th>
                    <th className="px-3 py-2">Balance</th>
                    <th className="px-3 py-2">Threshold</th>
                    <th className="px-3 py-2">Last alert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(lowBalance.data ?? []).map((a) => (
                    <LowBalanceRow key={a.id} account={a} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {transferOpen && <TransferModal onClose={() => setTransferOpen(false)} />}
    </div>
  );
}

function LowBalanceRow({ account }: { account: LunchAccountDto }) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-3 py-2">{account.studentName ?? account.studentId}</td>
      <td className={`px-3 py-2 font-semibold ${lunchBalanceTone(account)}`}>
        {formatCurrency(account.balance)}
      </td>
      <td className="px-3 py-2 text-gray-600">{formatCurrency(account.lowBalanceThreshold)}</td>
      <td className="px-3 py-2 text-gray-500">
        {account.lastLowBalanceAlertAt
          ? new Date(account.lastLowBalanceAlertAt).toLocaleString()
          : 'Never'}
      </td>
    </tr>
  );
}

function TransferModal({ onClose }: { onClose: () => void }) {
  const transfer = useTransferLunchBalance();
  const { toast } = useToast();
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [transferType, setTransferType] = useState<LunchTransferType>('SIBLING_TRANSFER');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  async function submit() {
    try {
      await transfer.mutateAsync({
        fromAccountId,
        toAccountId: transferType === 'REFUND_TO_FAMILY' ? undefined : toAccountId,
        transferType,
        amount: Number(amount),
        reason,
      });
      toast('Transfer recorded (IMMUTABLE)', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Transfer failed', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="IMMUTABLE balance transfer"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={
              !fromAccountId ||
              (transferType !== 'REFUND_TO_FAMILY' && !toAccountId) ||
              !amount ||
              !reason ||
              transfer.isPending
            }
            onClick={submit}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Transfer (cannot undo)
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          IMMUTABLE: this transfer cannot be edited or deleted. Corrections require an offsetting
          transfer in the other direction.
        </div>
        <Field label="Transfer type">
          <select
            value={transferType}
            onChange={(e) => setTransferType(e.target.value as LunchTransferType)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            {(Object.keys(LUNCH_TRANSFER_TYPE_LABELS) as LunchTransferType[]).map((t) => (
              <option key={t} value={t}>
                {LUNCH_TRANSFER_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source account UUID">
          <input
            type="text"
            value={fromAccountId}
            onChange={(e) => setFromAccountId(e.target.value)}
            placeholder="e.g. 019eaaaa-..."
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
          />
        </Field>
        {transferType !== 'REFUND_TO_FAMILY' && (
          <Field label="Destination account UUID">
            <input
              type="text"
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
              placeholder="e.g. 019eaaaa-..."
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
            />
          </Field>
        )}
        <Field label="Amount ($)">
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Reason">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Year-end transfer to continuing sibling…"
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
