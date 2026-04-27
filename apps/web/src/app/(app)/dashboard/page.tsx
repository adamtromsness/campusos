'use client';

import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { PageHeader } from '@/components/ui/PageHeader';
import { AdminDashboard } from '@/components/dashboard/AdminDashboard';
import { TeacherDashboard } from '@/components/dashboard/TeacherDashboard';
import { ParentDashboard } from '@/components/dashboard/ParentDashboard';
import { StudentDashboard } from '@/components/dashboard/StudentDashboard';

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  // Admin precedes Teacher: Platform Admin / School Admin (sch-001:admin) get
  // the school-wide overview rather than the empty "no classes assigned"
  // state of TeacherDashboard.
  const isAdminView = hasAnyPermission(user, ['sch-001:admin']);
  if (isAdminView) {
    return <AdminDashboard user={user} />;
  }

  const isTeacherView =
    user.personType === 'STAFF' &&
    hasAnyPermission(user, ['att-001:read', 'att-001:write', 'att-001:admin']);

  if (isTeacherView) {
    return <TeacherDashboard user={user} />;
  }

  if (user.personType === 'GUARDIAN') {
    return <ParentDashboard user={user} />;
  }

  if (user.personType === 'STUDENT') {
    return <StudentDashboard user={user} />;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`Welcome, ${user.preferredName || user.firstName || user.displayName}`}
        description={`${personaTitle(user.personType)} dashboard for this persona is coming up next.`}
      />
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
