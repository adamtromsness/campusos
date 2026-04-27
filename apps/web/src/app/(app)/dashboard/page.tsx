'use client';

import { useAuthStore } from '@/lib/auth-store';
import { PageHeader } from '@/components/ui/PageHeader';

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`Welcome, ${user.preferredName || user.firstName || user.displayName}`}
        description="Cycle 1 — UI shell is up. Persona-aware dashboards land in Steps 8–10."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <InfoCard label="Role">
          <p className="text-sm font-medium text-gray-900">{personaTitle(user.personType)}</p>
          <p className="mt-1 text-xs text-gray-500">{user.email}</p>
        </InfoCard>

        <InfoCard label="Permissions cached">
          <p className="text-2xl font-semibold text-campus-700">{user.permissions.length}</p>
          <p className="mt-1 text-xs text-gray-500">Across all scopes assigned to this account</p>
        </InfoCard>
      </div>

      <div className="mt-6 rounded-card border border-gray-200 bg-white p-5 shadow-card">
        <h3 className="text-sm font-semibold text-gray-900">Coming up</h3>
        <ul className="mt-3 space-y-2 text-sm text-gray-600">
          <li>
            <span className="font-mono text-xs text-campus-600">Step 8</span> — Teacher dashboard
            (today's classes + roster)
          </li>
          <li>
            <span className="font-mono text-xs text-campus-600">Step 9</span> — Attendance taking UI
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

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-5 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <div className="mt-2">{children}</div>
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
