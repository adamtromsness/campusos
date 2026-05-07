'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useDlqStats, useTenants } from '@/hooks/use-platform-admin';

/**
 * Cycle 31 Step 9 — Platform Admin landing.
 *
 * Cross-tenant ops hub for Platform Admin only. Surfaces a 4-card
 * stat panel + chip nav to the four detail surfaces.
 */
export default function PlatformAdminPage() {
  const user = useAuthStore((s) => s.user);
  const isPlatformAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);

  const dlqStats = useDlqStats();
  const tenants = useTenants();

  if (!user) return null;
  if (!isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Platform" />
        <EmptyState
          title="Platform Admin only"
          description="This dashboard surfaces cross-tenant state. Only the Platform Admin role has access."
        />
      </div>
    );
  }

  const tenantList = tenants.data ?? [];
  const frozen = tenantList.filter((t) => t.isFrozen).length;
  const totalDlq = dlqStats.data?.totalUnresolved ?? 0;
  const dlqOver15Min = dlqStats.data?.olderThan15Min ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Platform"
        description="Cross-tenant operational view. Tenants, dead-letter queue, partitions, and migration history."
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tenants" value={tenantList.length} loading={tenants.isLoading} />
        <StatCard
          label="Frozen tenants"
          value={frozen}
          tone={frozen > 0 ? 'amber' : 'neutral'}
          loading={tenants.isLoading}
        />
        <StatCard
          label="DLQ pending"
          value={totalDlq}
          tone={totalDlq > 0 ? 'amber' : 'neutral'}
          loading={dlqStats.isLoading}
        />
        <StatCard
          label="DLQ > 15 min"
          value={dlqOver15Min}
          tone={dlqOver15Min > 0 ? 'rose' : 'neutral'}
          loading={dlqStats.isLoading}
        />
      </section>

      <nav className="flex flex-wrap gap-2">
        <NavChip href="/admin/platform/tenants" label="Tenants" />
        <NavChip href="/admin/platform/dlq" label="Dead-letter queue" />
        <NavChip href="/admin/platform/partitions" label="Partitions" />
        <NavChip href="/admin/platform/migrations" label="Migrations" />
      </nav>

      {dlqStats.data && dlqStats.data.byConsumerGroup.length > 0 && (
        <section className="rounded-card border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-amber-900">DLQ by consumer group</h2>
          <ul className="space-y-1 text-sm text-amber-900">
            {dlqStats.data.byConsumerGroup.map((g) => (
              <li key={g.consumerGroup} className="flex justify-between">
                <span className="font-mono">{g.consumerGroup}</span>
                <span className="font-semibold">{g.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tenants.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading tenant list…
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = 'neutral',
  loading,
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'amber' | 'rose';
  loading?: boolean;
}) {
  const valueClass =
    tone === 'rose' ? 'text-rose-600' : tone === 'amber' ? 'text-amber-700' : 'text-gray-900';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueClass}`}>
        {loading ? '…' : value.toLocaleString()}
      </p>
    </div>
  );
}

function NavChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:border-campus-300 hover:bg-campus-50"
    >
      {label} →
    </Link>
  );
}
