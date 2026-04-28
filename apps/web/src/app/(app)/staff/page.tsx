'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { PeopleIcon } from '@/components/shell/icons';
import { useEmployees } from '@/hooks/use-hr';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

export default function StaffDirectoryPage() {
  const user = useAuthStore((s) => s.user);
  const [search, setSearch] = useState('');

  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const [includeInactive, setIncludeInactive] = useState(false);

  const employees = useEmployees(
    {
      search: search.trim().length > 0 ? search.trim() : undefined,
      includeInactive: isAdmin && includeInactive,
    },
    !!user,
  );

  if (!user) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Staff Directory"
        description="Find a colleague — name, position, or employee number."
      />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or employee number…"
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
        {isAdmin && (
          <label className="inline-flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
            />
            Include inactive
          </label>
        )}
      </div>

      <div className="mt-6">
        {employees.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : employees.isError ? (
          <EmptyState
            title="Couldn’t load the directory"
            description="Try refreshing the page. If the issue persists, contact a school admin."
          />
        ) : (employees.data ?? []).length === 0 ? (
          <EmptyState
            title="No staff match"
            description={
              search.trim().length > 0
                ? 'Try a shorter or different search term.'
                : 'No employees have been added to this school yet.'
            }
            icon={<PeopleIcon className="h-12 w-12 text-gray-300" />}
          />
        ) : (
          <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white shadow-sm">
            {(employees.data ?? []).map((emp) => (
              <li key={emp.id}>
                <Link
                  href={`/staff/${emp.id}`}
                  className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-gray-50"
                >
                  <Avatar name={emp.fullName} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900">{emp.fullName}</p>
                    <p className="truncate text-xs text-gray-500">
                      {emp.primaryPositionTitle ?? '—'}
                      {emp.employeeNumber && (
                        <span className="ml-2 text-gray-400">· {emp.employeeNumber}</span>
                      )}
                    </p>
                  </div>
                  <div className="hidden text-xs text-gray-500 sm:block">{emp.email ?? '—'}</div>
                  {emp.employmentStatus !== 'ACTIVE' && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      {emp.employmentStatus.toLowerCase().replace('_', ' ')}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
