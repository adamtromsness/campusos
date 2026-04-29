'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useFamilyAccounts,
  useFamilyAccountBalance,
  useFamilyAccountLedger,
} from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ENTRY_TYPE_LABELS,
  ENTRY_TYPE_PILL,
  formatCurrency,
  formatDateTime,
  formatSignedCurrency,
} from '@/lib/billing-format';
import type { LedgerEntryDto } from '@/lib/types';

interface LedgerRowWithRunning {
  entry: LedgerEntryDto;
  runningBalance: number;
}

export default function ParentLedgerPage() {
  const user = useAuthStore((s) => s.user);
  const isGuardian = !!user && user.personType === 'GUARDIAN';
  const canRead = !!user && hasAnyPermission(user, ['fin-001:read', 'fin-001:write']);

  const accounts = useFamilyAccounts(canRead);
  const account = (accounts.data ?? [])[0] ?? null;
  const accountId = account?.id;
  const balance = useFamilyAccountBalance(accountId, !!accountId);
  // Fetch a generous window so the running balance is meaningful for an
  // active family account. Older history pages can be added with `before=`.
  const ledger = useFamilyAccountLedger(accountId, { limit: 100 }, !!accountId);

  // Compute running balance newest-first by anchoring at the current
  // balance and walking backwards: the running balance shown on row N
  // reflects the account state immediately AFTER that entry was posted.
  const rows = useMemo<LedgerRowWithRunning[]>(() => {
    const entries = ledger.data ?? [];
    if (entries.length === 0) return [];
    const current = balance.data?.balance ?? account?.balance ?? 0;
    const out: LedgerRowWithRunning[] = [];
    let running = current;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      out.push({ entry: e, runningBalance: running });
      // Step backwards: the running balance for the next-older row is
      // current minus this row's signed amount.
      running = Number((running - Number(e.amount)).toFixed(2));
    }
    return out;
  }, [ledger.data, balance.data, account?.balance]);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Ledger" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }
  if (!isGuardian) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Ledger" />
        <EmptyState
          title="Not available"
          description="The parent ledger is only for guardian accounts. Admins should view per-family ledgers from /billing/accounts."
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
        <PageHeader title="Ledger" />
        <EmptyState title="No family account yet" />
      </div>
    );
  }

  const currentBalance = balance.data?.balance ?? account.balance;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/billing" className="text-sm text-gray-500 hover:text-campus-700">
        ← Billing
      </Link>
      <PageHeader
        title="Ledger"
        description={`${account.accountNumber} · running-balance transaction history`}
      />

      <div className="mt-2 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
              Current balance
            </p>
            <p
              className={`text-2xl font-semibold ${
                currentBalance > 0
                  ? 'text-rose-700'
                  : currentBalance < 0
                    ? 'text-emerald-700'
                    : 'text-gray-700'
              }`}
            >
              {formatCurrency(currentBalance)}
            </p>
          </div>
          <p className="text-xs text-gray-500">
            {currentBalance > 0
              ? 'Outstanding — invoices waiting on payment.'
              : currentBalance < 0
                ? 'Credit on file — applied automatically to future invoices.'
                : 'Account is settled.'}
          </p>
        </div>

        <div className="mt-6">
          {ledger.isLoading ? (
            <LoadingSpinner />
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">
              No ledger entries yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="px-2 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(({ entry, runningBalance }) => (
                  <tr key={entry.id}>
                    <td className="px-2 py-2 text-gray-600">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          ENTRY_TYPE_PILL[entry.entryType]
                        }`}
                      >
                        {ENTRY_TYPE_LABELS[entry.entryType]}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-gray-700">
                      {entry.description ?? '—'}
                    </td>
                    <td
                      className={`px-2 py-2 text-right font-semibold ${
                        Number(entry.amount) >= 0 ? 'text-rose-700' : 'text-emerald-700'
                      }`}
                    >
                      {formatSignedCurrency(entry.amount)}
                    </td>
                    <td className="px-2 py-2 text-right font-medium text-gray-900">
                      {formatCurrency(runningBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {rows.length === 100 && (
          <p className="mt-3 text-xs text-gray-500">
            Showing the most recent 100 entries.
          </p>
        )}
      </div>
    </div>
  );
}
