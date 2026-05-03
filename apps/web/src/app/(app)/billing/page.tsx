'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useFamilyAccounts } from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { FamilyAccountDto } from '@/lib/types';
import { FamilyAccountSection } from './FamilyAccountSection';

export default function ParentBillingDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const isGuardian = !!user && user.personType === 'GUARDIAN';
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const canRead = !!user && hasAnyPermission(user, ['fin-001:read', 'fin-001:write']);

  // Admins land on /billing/accounts — keep this page parent-focused.
  useEffect(() => {
    if (isAdmin) router.replace('/billing/accounts');
  }, [isAdmin, router]);

  const accounts = useFamilyAccounts(canRead && !isAdmin);

  // Group accounts by school (or by sharedBillingGroupId when present, so
  // schools running a shared billing module render as one combined section).
  const groups = useMemo(() => groupAccounts(accounts.data ?? []), [accounts.data]);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }
  if (isAdmin) return null; // about to redirect
  if (!isGuardian) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing" />
        <EmptyState
          title="Not available"
          description="The parent billing view is only for guardian accounts."
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

  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing" />
        <EmptyState
          title="No family account yet"
          description="Once a child is enrolled, your family account will appear here automatically."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Billing"
        description={
          groups.length === 1 && groups[0]!.accounts.length === 1
            ? `${groups[0]!.headline} · ${groups[0]!.accounts[0]!.accountNumber}`
            : 'Your family accounts across schools.'
        }
        actions={
          <Link
            href="/billing/ledger"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            View ledger
          </Link>
        }
      />

      <div className="space-y-8">
        {groups.map((g) => (
          <div key={g.key}>
            <h2 className="mb-3 text-base font-semibold text-gray-900">{g.headline}</h2>
            {g.accounts.map((a) => (
              <div key={a.id} className="mb-6 last:mb-0">
                <FamilyAccountSection account={a} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface AccountGroup {
  key: string;
  headline: string;
  accounts: FamilyAccountDto[];
}

function groupAccounts(accounts: FamilyAccountDto[]): AccountGroup[] {
  // sharedBillingGroupId — when two schools in a district share a single
  // billing surface, group them together with a generic combined header.
  // Otherwise group by schoolId so each school renders as its own section.
  const groups = new Map<string, AccountGroup>();
  for (const a of accounts) {
    const key = a.sharedBillingGroupId ?? a.schoolId;
    const headline = a.sharedBillingGroupId
      ? 'District billing'
      : a.schoolName
        ? a.schoolName
        : 'Your school';
    const existing = groups.get(key);
    if (existing) {
      existing.accounts.push(a);
    } else {
      groups.set(key, { key, headline, accounts: [a] });
    }
  }
  return Array.from(groups.values());
}
