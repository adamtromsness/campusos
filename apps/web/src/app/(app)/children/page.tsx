'use client';

import Link from 'next/link';
import { useAuthStore } from '@/lib/auth-store';
import { useMyChildren } from '@/hooks/use-children';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Avatar } from '@/components/ui/Avatar';
import type { StudentDto } from '@/lib/types';

export default function ChildrenPage() {
  const user = useAuthStore((s) => s.user);
  const children = useMyChildren();
  if (!user) return null;

  if (user.personType !== 'GUARDIAN') {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="My Children" />
        <EmptyState
          title="Not available"
          description="My Children is only available for guardian accounts."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="My Children" description="Your linked students." />
      {children.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading your children…
        </div>
      ) : children.isError ? (
        <EmptyState
          title="Couldn't load your children"
          description="The API returned an error. Try refreshing the page."
        />
      ) : (children.data ?? []).length === 0 ? (
        <EmptyState
          title="No children linked to this account"
          description="If this is unexpected, contact the school office to confirm your guardian record."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(children.data ?? []).map((c) => (
            <ChildCard key={c.id} child={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChildCard({ child }: { child: StudentDto }) {
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex items-center gap-3 px-5 py-4">
        <Avatar name={child.fullName} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-gray-900">{child.fullName}</h3>
          <p className="text-sm text-gray-500">
            {child.gradeLevel ? `Grade ${child.gradeLevel}` : 'Grade —'}
            {child.studentNumber ? ` · #${child.studentNumber}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm">
        <Link
          href={`/children/${child.id}/attendance`}
          className="flex-1 rounded-lg bg-campus-700 px-3 py-2 text-center font-medium text-white shadow-card hover:bg-campus-600"
        >
          Attendance
        </Link>
        <Link
          href={`/children/${child.id}/grades`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          Grades
        </Link>
        <Link
          href={`/children/${child.id}/schedule`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          Schedule
        </Link>
        <Link
          href={`/children/${child.id}/absence-request`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          Report absence
        </Link>
      </div>
    </div>
  );
}
