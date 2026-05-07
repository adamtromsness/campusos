'use client';

import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useTenants } from '@/hooks/use-platform-admin';

/**
 * Cycle 31 Step 9 — Tenants page.
 *
 * Single-screen view of every active tenant. Surfaces base-table-count
 * drift (the canonical Wave 7 close-out figure is 383; rows that drift
 * have either been hand-migrated or had a tenant migration fail) and
 * pending DLQ pressure per tenant.
 */
export default function TenantsPage() {
  const user = useAuthStore((s) => s.user);
  const isPlatformAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const tenants = useTenants();

  if (!user) return null;
  if (!isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Tenants" />
        <EmptyState title="Platform Admin only" />
      </div>
    );
  }

  const list = tenants.data ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Tenants"
        description="Per-school operational summary. Base-table-count drift indicates a tenant migration mismatch."
      />

      {tenants.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No tenants registered"
          description="Run pnpm seed and the platform tenant routing job."
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Subdomain</th>
                <th className="px-4 py-2 text-left">School</th>
                <th className="px-4 py-2 text-left">Schema</th>
                <th className="px-4 py-2 text-right">Base tables</th>
                <th className="px-4 py-2 text-right">DLQ pending</th>
                <th className="px-4 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((t) => (
                <tr key={t.schoolId} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-gray-900">{t.subdomain}</td>
                  <td className="px-4 py-2 text-gray-900">{t.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600">{t.schemaName}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                    {t.baseTableCount ?? '—'}
                  </td>
                  <td
                    className={`px-4 py-2 text-right tabular-nums ${
                      t.pendingDlqCount > 0 ? 'text-amber-700 font-semibold' : 'text-gray-500'
                    }`}
                  >
                    {t.pendingDlqCount}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {t.isFrozen ? (
                      <span className="inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800">
                        FROZEN
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                        Active
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
