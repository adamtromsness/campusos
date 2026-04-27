'use client';

import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { PageHeader } from '@/components/ui/PageHeader';
import { TeacherDashboard } from '@/components/dashboard/TeacherDashboard';
import { ParentDashboard } from '@/components/dashboard/ParentDashboard';

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  const isTeacherView =
    user.personType === 'STAFF' &&
    hasAnyPermission(user, ['att-001:read', 'att-001:write', 'att-001:admin']);

  if (isTeacherView) {
    return <TeacherDashboard user={user} />;
  }

  if (user.personType === 'GUARDIAN') {
    return <ParentDashboard user={user} />;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`Welcome, ${user.preferredName || user.firstName || user.displayName}`}
        description={`${personaTitle(user.personType)} dashboard for this persona is coming up next.`}
      />
      <div className="rounded-card border border-gray-200 bg-white p-5 shadow-card">
        <h3 className="text-sm font-semibold text-gray-900">Coming up</h3>
        <ul className="mt-3 space-y-2 text-sm text-gray-600">
          <li>
            <span className="font-mono text-xs text-campus-600">Step 9</span> — Attendance taking UI
            for teachers
          </li>
          <li>
            <span className="font-mono text-xs text-campus-600">Step 10</span> — Parent dashboard +
            absence requests
          </li>
          <li>
            <span className="font-mono text-xs text-campus-600">Step 11</span> — End-to-end vertical
            slice test
          </li>
        </ul>
      </div>
    </div>
  );
}

function personaTitle(personType: string | null): string {
  switch (personType) {
    case 'STAFF':
      return 'Staff';
    case 'GUARDIAN':
      return 'Parent / Guardian';
    case 'STUDENT':
      return 'Student';
    case 'VOLUNTEER':
      return 'Volunteer';
    case 'SUBSTITUTE':
      return 'Substitute';
    default:
      return 'Member';
  }
}
