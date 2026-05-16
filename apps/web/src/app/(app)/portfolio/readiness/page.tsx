'use client';

import { useState } from 'react';
import { PageHeader, EmptyState, LoadingSpinner } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';
import { useMyStudent } from '@/hooks/use-classroom';
import {
  useStudentReadiness,
  useReadinessDashboard,
  useUpdateMilestoneStatus,
} from '@/hooks/use-portfolio-advanced';
import type { MilestoneStatusInlineDto, PathwayAssignmentDto } from '@/lib/types';

/**
 * P2-27 Step 7 — Readiness tracker.
 * - Student / parent: own pathway checklist with milestone status pills.
 * - Counsellor / admin: school-wide readiness dashboard sorted by progress.
 */
export default function ReadinessPage() {
  const { user } = useAuthStore();
  const personType = user?.personType;
  const isStaff = personType === 'STAFF';
  const isStudent = personType === 'STUDENT';

  if (isStaff) {
    return <CounsellorReadinessDashboard />;
  }
  if (isStudent) {
    return <StudentReadinessView />;
  }
  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader
        title="Post-secondary readiness"
        description="Counsellors and admins can assign pathway tracking from this surface."
      />
      <EmptyState
        title="No active pathway"
        description="Your counsellor will assign you to a readiness pathway when you're ready to start planning."
      />
    </div>
  );
}

function StudentReadinessView() {
  const myStudent = useMyStudent();
  const studentId = myStudent.data?.id ?? null;
  const readiness = useStudentReadiness(studentId);
  const update = useUpdateMilestoneStatus();
  const [busyMilestoneId, setBusyMilestoneId] = useState<string | null>(null);

  if (readiness.isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <LoadingSpinner />
      </div>
    );
  }
  if (!readiness.data || readiness.data.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageHeader
          title="Post-secondary readiness"
          description="Track your progress against the pathway your counsellor has chosen for you."
        />
        <EmptyState
          title="No active pathway yet"
          description="Your counsellor will assign a pathway after your planning meeting."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Post-secondary readiness"
        description="Track milestones for your chosen pathway. Tap a milestone to mark it in-progress or complete."
      />
      {readiness.data.map((a) => (
        <PathwayCard
          key={a.id}
          assignment={a}
          onMilestoneClick={async (m, next) => {
            setBusyMilestoneId(m.milestoneId);
            try {
              await update.mutateAsync({
                assignmentId: a.id,
                payload: { milestoneId: m.milestoneId, status: next },
              });
            } finally {
              setBusyMilestoneId(null);
            }
          }}
          busyMilestoneId={busyMilestoneId}
        />
      ))}
    </div>
  );
}

function PathwayCard({
  assignment,
  onMilestoneClick,
  busyMilestoneId,
}: {
  assignment: PathwayAssignmentDto;
  onMilestoneClick: (m: MilestoneStatusInlineDto, next: 'IN_PROGRESS' | 'COMPLETED') => void;
  busyMilestoneId: string | null;
}) {
  const completed = assignment.milestoneStatuses.filter((m) => m.status === 'COMPLETED').length;
  const total = assignment.milestoneStatuses.length;
  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{assignment.pathwayName}</h2>
          <p className="text-sm text-gray-500">
            {assignment.pathwayType?.replace('_', ' ')} · Assigned by{' '}
            {assignment.assignedByName ?? 'Counsellor'}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-campus-700">
            {assignment.overallProgress.toFixed(0)}%
          </div>
          <div className="text-xs text-gray-500">
            {completed}/{total} milestones
          </div>
        </div>
      </header>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-2 rounded-full bg-campus-600"
          style={{ width: `${assignment.overallProgress}%` }}
        />
      </div>
      <ul className="divide-y divide-gray-100">
        {assignment.milestoneStatuses
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((m) => (
            <li key={m.milestoneId} className="flex items-center justify-between py-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <StatusPill status={m.status} />
                  <span className="text-sm font-medium text-gray-900">{m.milestoneName}</span>
                  <span className="text-xs text-gray-400">{m.category}</span>
                </div>
                {m.notes && <p className="mt-1 text-xs text-gray-500">{m.notes}</p>}
              </div>
              <div className="flex gap-2">
                {m.status !== 'IN_PROGRESS' && m.status !== 'COMPLETED' && (
                  <button
                    type="button"
                    disabled={busyMilestoneId === m.milestoneId}
                    onClick={() => onMilestoneClick(m, 'IN_PROGRESS')}
                    className="rounded-md border border-amber-300 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50"
                  >
                    Start
                  </button>
                )}
                {m.status !== 'COMPLETED' && (
                  <button
                    type="button"
                    disabled={busyMilestoneId === m.milestoneId}
                    onClick={() => onMilestoneClick(m, 'COMPLETED')}
                    className="rounded-md border border-emerald-300 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50"
                  >
                    Mark done
                  </button>
                )}
              </div>
            </li>
          ))}
      </ul>
    </section>
  );
}

function StatusPill({ status }: { status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' }) {
  const map = {
    NOT_STARTED: 'bg-gray-100 text-gray-600',
    IN_PROGRESS: 'bg-amber-100 text-amber-700',
    COMPLETED: 'bg-emerald-100 text-emerald-700',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${map[status]}`}
    >
      {status === 'NOT_STARTED' ? '○' : status === 'IN_PROGRESS' ? '⋯' : '✓'}
    </span>
  );
}

function CounsellorReadinessDashboard() {
  const [atRiskOnly, setAtRiskOnly] = useState(false);
  const dash = useReadinessDashboard(atRiskOnly);
  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title="Readiness dashboard"
        description="School-wide post-secondary readiness — sorted by progress ascending. At-risk students are flagged."
      />
      <div className="mb-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={atRiskOnly}
            onChange={(e) => setAtRiskOnly(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-rose-600 focus:ring-rose-500"
          />
          At-risk only (&lt; 50%)
        </label>
      </div>
      {dash.isLoading ? (
        <LoadingSpinner />
      ) : !dash.data || dash.data.length === 0 ? (
        <EmptyState title="No active pathway assignments" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Student
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Grade
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Pathway
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Progress
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Milestones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {dash.data.map((r) => (
                <tr
                  key={`${r.studentId}-${r.pathwayId}`}
                  className={r.isAtRisk ? 'bg-rose-50' : ''}
                >
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {r.studentName ?? '(unknown)'}
                    {r.isAtRisk && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                        At-risk
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{r.gradeLevel ?? '—'}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{r.pathwayName}</td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-2 rounded-full ${
                            r.isAtRisk ? 'bg-rose-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${r.overallProgress}%` }}
                        />
                      </div>
                      <span className="text-xs font-medium text-gray-700">
                        {r.overallProgress.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {r.completedMilestones} / {r.totalMilestones}
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
