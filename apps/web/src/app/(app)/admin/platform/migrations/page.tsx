'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useMigrationHistory } from '@/hooks/use-platform-admin';

/**
 * Cycle 31 Step 9 — Migration history.
 *
 * Reads platform _prisma_migrations newest-first. Tenant migrations are
 * SQL-driven via provision-tenant.ts and are tracked in source —
 * the dashboard surfaces a hint pointing to
 * packages/database/prisma/tenant/migrations/ rather than fabricate
 * synthetic state.
 */
export default function MigrationsPage() {
  const user = useAuthStore((s) => s.user);
  const isPlatformAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const [scope, setScope] = useState<'platform' | 'tenant' | 'all'>('platform');

  const migrations = useMigrationHistory({
    scope: scope === 'all' ? undefined : scope,
    limit: 200,
  });

  if (!user) return null;
  if (!isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Migrations" />
        <EmptyState title="Platform Admin only" />
      </div>
    );
  }

  const list = migrations.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Migration history"
        description="Newest-first. Platform migrations come from _prisma_migrations; tenant migrations are tracked in source."
      />

      <div className="flex gap-2">
        {(['platform', 'tenant', 'all'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm font-medium',
              scope === s
                ? 'border-campus-600 bg-campus-600 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
            )}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {migrations.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState title="No migration history" />
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Scope</th>
                <th className="px-3 py-2 text-left">Migration</th>
                <th className="px-3 py-2 text-right">Applied at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((m, i) => (
                <tr key={`${m.scope}-${m.migrationName}-${i}`} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                        m.scope === 'platform'
                          ? 'bg-sky-100 text-sky-800'
                          : 'bg-violet-100 text-violet-800',
                      )}
                    >
                      {m.scope}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-900">{m.migrationName}</td>
                  <td className="px-3 py-2 text-right text-xs text-gray-700">
                    {new Date(m.appliedAt).toLocaleString()}
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
