'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useFamilyAccounts } from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  FAMILY_ACCOUNT_STATUS_LABELS,
  FAMILY_ACCOUNT_STATUS_PILL,
  formatCurrency,
} from '@/lib/billing-format';

export default function BillingAccountsPage() {
  const user = useAuthStore((s) => s.user);
  const isWriter = !!user && hasAnyPermission(user, ['fin-001:write']);
  const accounts = useFamilyAccounts(!!user);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = accounts.data ?? [];
    if (!q) return rows;
    return rows.filter((a) => {
      if (a.accountNumber.toLowerCase().includes(q)) return true;
      if (a.accountHolderName.toLowerCase().includes(q)) return true;
      if (a.accountHolderEmail && a.accountHolderEmail.toLowerCase().includes(q)) return true;
      if (a.students.some((s) => `${s.firstName} ${s.lastName}`.toLowerCase().includes(q))) {
        return true;
      }
      return false;
    });
  }, [accounts.data, search]);

  const totals = useMemo(() => {
    let outstanding = 0;
    let active = 0;
    for (const a of accounts.data ?? []) {
      if (a.status === 'ACTIVE') active += 1;
      if (a.balance > 0) outstanding += a.balance;
    }
    return { outstanding, active };
  }, [accounts.data]);

  if (!user) return null;
  if (!isWriter) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing — Accounts" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Family Accounts"
        description="Per-family billing accounts with current balance and linked students."
      />

      <BillingTabs active="accounts" />

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Active accounts" value={String(totals.active)} />
        <Stat
          label="Outstanding balance"
          value={formatCurrency(totals.outstanding)}
          tone={totals.outstanding > 0 ? 'rose' : 'emerald'}
        />
        <Stat label="Total accounts" value={String((accounts.data ?? []).length)} />
      </div>

      <div className="mt-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by account number, parent name, email, or student…"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {accounts.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16">
            <EmptyState title="No matching accounts" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Account #</th>
                <th className="px-4 py-2">Account holder</th>
                <th className="px-4 py-2">Students</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">
                    <Link
                      href={`/billing/accounts/${a.id}`}
                      className="text-campus-700 hover:text-campus-900"
                    >
                      {a.accountNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <p className="font-medium text-gray-900">{a.accountHolderName}</p>
                    {a.accountHolderEmail && (
                      <p className="text-xs text-gray-500">{a.accountHolderEmail}</p>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {a.students.length === 0
                      ? '—'
                      : a.students
                          .map((s) => `${s.firstName} ${s.lastName} (${s.gradeLevel})`)
                          .join(', ')}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        FAMILY_ACCOUNT_STATUS_PILL[a.status]
                      }`}
                    >
                      {FAMILY_ACCOUNT_STATUS_LABELS[a.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`font-semibold ${
                        a.balance > 0
                          ? 'text-rose-700'
                          : a.balance < 0
                            ? 'text-emerald-700'
                            : 'text-gray-700'
                      }`}
                    >
                      {formatCurrency(a.balance)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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
