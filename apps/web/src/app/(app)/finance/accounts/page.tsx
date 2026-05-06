'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useAccounts } from '@/hooks/use-finance';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_PILL, formatCurrency } from '@/lib/finance-format';
import type { FinAccountDto } from '@/lib/types';

export default function ChartOfAccountsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['fin-005:write']);
  const [includeInactive, setIncludeInactive] = useState(false);
  const accountsQ = useAccounts(includeInactive);
  const accounts = accountsQ.data ?? [];

  // Group by type for the hierarchical view
  const grouped = useMemo(() => {
    const m = new Map<string, FinAccountDto[]>();
    for (const a of accounts) {
      if (!m.has(a.accountType)) m.set(a.accountType, []);
      m.get(a.accountType)!.push(a);
    }
    return m;
  }, [accounts]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Chart of accounts"
        description="Hierarchical accounting structure with running balances."
      />
      <div className="flex items-center justify-between">
        <Link href="/finance" className="text-sm text-campus-700 hover:underline">
          ← Back to finance
        </Link>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const).map((t) => {
        const list = grouped.get(t) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={t} className="rounded-lg border border-gray-200 bg-white">
            <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <span
                className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${ACCOUNT_TYPE_PILL[t]}`}
              >
                {ACCOUNT_TYPE_LABELS[t]}
              </span>
              <span className="text-xs text-gray-500">{list.length} accounts</span>
            </header>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left">Code</th>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Fund</th>
                  <th className="px-4 py-2 text-left">Normal</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2 text-left">Flags</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id} className="border-t border-gray-100">
                    <td className="px-4 py-2 font-mono">{a.accountCode}</td>
                    <td className="px-4 py-2">
                      {a.parentAccountCode && <span className="text-xs text-gray-400">↳ </span>}
                      {a.accountName}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">{a.fundCode ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">{a.normalBalance}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {formatCurrency(a.runningBalance)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {a.isSystem && <span className="text-rose-700">SYS</span>}
                      {!a.isActive && <span className="ml-1 text-gray-400">INACTIVE</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {isAdmin && (
        <p className="text-xs text-gray-500">
          New accounts and edits land via <code>POST /api/v1/finance/accounts</code>. System
          accounts (Cash, AR, AP) refuse deactivation.
        </p>
      )}
    </div>
  );
}
