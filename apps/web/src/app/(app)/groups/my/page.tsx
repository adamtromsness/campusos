'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useMyGroups } from '@/hooks/use-groups';
import { useAuthStore } from '@/lib/auth-store';
import {
  POLICY_LABEL,
  POLICY_PILL,
  ROLE_LABEL,
  ROLE_PILL,
  SCOPE_LABEL,
  SCOPE_PILL,
} from '@/lib/groups-format';

export default function MyGroupsPage() {
  const user = useAuthStore((s) => s.user);
  const groupsQ = useMyGroups(!!user);
  if (!user) return null;
  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/groups" className="mb-2 inline-block text-sm text-gray-500 hover:underline">
        ← Back to groups
      </Link>
      <PageHeader title="My groups" description="Communities you're a part of." />
      {groupsQ.isLoading ? (
        <LoadingSpinner />
      ) : groupsQ.data && groupsQ.data.length > 0 ? (
        <ul className="grid gap-3">
          {groupsQ.data.map((g) => (
            <li key={g.id}>
              <Link
                href={`/groups/${g.id}`}
                className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-campus-300 hover:bg-campus-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">{g.name}</h3>
                    {g.description ? (
                      <p className="text-sm text-gray-600">{g.description}</p>
                    ) : null}
                    {g.scopeLabel ? (
                      <p className="mt-1 text-xs text-gray-500">{g.scopeLabel}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${SCOPE_PILL[g.scopeType]}`}
                    >
                      {SCOPE_LABEL[g.scopeType]}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${POLICY_PILL[g.joinPolicy]}`}
                    >
                      {POLICY_LABEL[g.joinPolicy]}
                    </span>
                    {g.myMembership ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_PILL[g.myMembership.role]}`}
                      >
                        {ROLE_LABEL[g.myMembership.role]}
                      </span>
                    ) : null}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Not a member of any groups yet" />
      )}
    </div>
  );
}
