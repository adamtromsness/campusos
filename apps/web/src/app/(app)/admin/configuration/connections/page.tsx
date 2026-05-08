'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useConnectionsSummary } from '@/hooks/use-configuration';

/**
 * Step 5 — Connections view.
 *
 * Four cross-structure tables: school↔facility / position↔school /
 * person↔position / class↔room. The Sankey "big picture" visual is
 * a polish item — for the demo phase we ship the four tables which
 * cover the operator's day-to-day "find the gaps" workflow.
 *
 * Per docs/campusos-school-configuration-admin.html step 05.
 * Read-only — connections are mutated through the structure-specific
 * pages (Step 2 facilities, Step 3 academic, Step 4 positions).
 */

export default function ConnectionsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const summary = useConnectionsSummary(isAdmin);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Connections" />
        <EmptyState
          title="Admin access required"
          description="Connections is gated on the SYS-001:admin permission."
        />
      </div>
    );
  }

  const data = summary.data;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <PageHeader title="Connections" />
        <p className="-mt-1 text-sm text-gray-600">
          <Link href="/admin/configuration" className="text-campus-700 hover:underline">
            ← Configuration
          </Link>
          {' · '}How facilities, positions, people, and classes connect.
        </p>
      </div>

      {summary.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading connections…
        </div>
      )}
      {summary.isError && <p className="text-sm text-rose-600">Failed to load connections.</p>}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Buildings" value={data.totals.buildings} />
            <Stat
              label="Positions"
              sub={`${data.totals.filledPositions} filled · ${data.totals.vacantPositions} vacant`}
              value={data.totals.positions}
            />
            <Stat
              label="Classes"
              sub={`${data.totals.classesWithRoom} scheduled · ${data.totals.classesWithoutRoom} without room`}
              value={data.totals.classes}
            />
            <Stat label="Linked classes ↔ rooms" value={data.totals.classesWithRoom} />
          </section>

          <Section title="School ↔ Facility">
            {data.buildingSchool.length === 0 ? (
              <EmptyTableNote>No active buildings linked to a school.</EmptyTableNote>
            ) : (
              <Table headers={['Building', 'School', 'Spaces']}>
                {data.buildingSchool.map((row) => (
                  <tr key={row.buildingId} className="border-b border-gray-100">
                    <td className="px-4 py-2 font-medium text-gray-900">{row.buildingName}</td>
                    <td className="px-4 py-2 text-gray-700">{row.schoolName}</td>
                    <td className="px-4 py-2 tabular-nums text-gray-700">{row.spaceCount}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section title="Position ↔ School">
            {data.positionSchool.length === 0 ? (
              <EmptyTableNote>No active positions configured.</EmptyTableNote>
            ) : (
              <Table headers={['Position', 'Department', 'School', 'Filled by']}>
                {data.positionSchool.map((row) => (
                  <tr key={row.positionId} className="border-b border-gray-100">
                    <td className="px-4 py-2 font-medium text-gray-900">{row.positionTitle}</td>
                    <td className="px-4 py-2 text-gray-700">{row.departmentName ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-700">{row.schoolName}</td>
                    <td className="px-4 py-2 text-gray-700">{row.filledByName ?? <Vacant />}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section title="Person ↔ Position">
            {data.personPosition.length === 0 ? (
              <EmptyTableNote>No positions configured.</EmptyTableNote>
            ) : (
              <Table headers={['Position', 'Department', 'Filled by', 'Start date', 'Status']}>
                {data.personPosition.map((row) => (
                  <tr key={row.positionId} className="border-b border-gray-100">
                    <td className="px-4 py-2 font-medium text-gray-900">{row.positionTitle}</td>
                    <td className="px-4 py-2 text-gray-700">{row.departmentName ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-700">{row.personName ?? <Vacant />}</td>
                    <td className="px-4 py-2 text-gray-700">{row.startDate ?? '—'}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          row.isVacant
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {row.isVacant ? 'Vacant' : 'Filled'}
                      </span>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section title="Class ↔ Room">
            {data.classRoom.length === 0 ? (
              <EmptyTableNote>No classes scheduled.</EmptyTableNote>
            ) : (
              <Table headers={['Class', 'Grade', 'Teacher(s)', 'Room', 'Building']}>
                {data.classRoom.map((row) => (
                  <tr
                    key={row.classId}
                    className={`border-b border-gray-100 ${row.isUnassigned ? 'bg-amber-50' : ''}`}
                  >
                    <td className="px-4 py-2 font-medium text-gray-900">{row.className}</td>
                    <td className="px-4 py-2 text-gray-700">{row.gradeLevel ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-700">
                      {row.teacherNames.length > 0 ? row.teacherNames.join(', ') : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {row.scheduledRoomName ?? row.roomText ?? (
                        <span className="text-amber-700">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-700">{row.scheduledBuildingName ?? '—'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-gray-200 bg-white shadow-card">
      <h2 className="border-b border-gray-200 px-6 py-3 text-sm font-semibold uppercase tracking-wide text-gray-700">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50">
        <tr>
          {headers.map((h) => (
            <th key={h} className="px-4 py-2 text-left font-semibold text-gray-700">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function EmptyTableNote({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-3 text-sm italic text-gray-500">{children}</p>;
}

function Vacant() {
  return (
    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
      Vacant
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
      <p className="text-xs uppercase tracking-wide text-gray-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-campus-700">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}
