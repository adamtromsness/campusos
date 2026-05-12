'use client';

import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useSubjectChoiceDemand,
  useSubjectChoiceWindows,
  useSubjectChoices,
} from '@/hooks/use-scheduling-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

export default function SubjectChoicesPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin =
    !!user &&
    (hasAnyPermission(user, ['sch-002:admin']) || hasAnyPermission(user, ['sch-001:admin']));
  const isStaff = !!user && (isAdmin || user.personType === 'STAFF');

  const choices = useSubjectChoices({}, !!user);
  const windows = useSubjectChoiceWindows(!!user);

  const activeWindow = useMemo(() => {
    const now = Date.now();
    return (windows.data ?? []).find(
      (w) =>
        w.isActive && new Date(w.opensAt).getTime() <= now && new Date(w.closesAt).getTime() >= now,
    );
  }, [windows.data]);

  const academicYearForDemand = activeWindow?.academicYearId ?? null;
  const demand = useSubjectChoiceDemand(academicYearForDemand, isStaff);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Subject Choices"
        description="Students submit course preferences for the upcoming year. Admin sees the demand summary to size sections."
      />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
          Active window
        </h2>
        {windows.isLoading ? (
          <LoadingSpinner />
        ) : activeWindow ? (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm">
            <div className="font-medium text-emerald-900">
              {activeWindow.name ?? 'Course selection window'} — open until{' '}
              {new Date(activeWindow.closesAt).toLocaleDateString()}
            </div>
            <div className="mt-1 text-emerald-800">
              {activeWindow.targetGradeLevels && activeWindow.targetGradeLevels.length > 0
                ? `Grades ${activeWindow.targetGradeLevels.join(', ')}`
                : 'Open to every grade'}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-300 bg-gray-50 p-4 text-sm text-gray-600">
            No active subject choice window — submissions are currently closed.
          </div>
        )}
      </section>

      {isStaff && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
            Demand matrix
          </h2>
          {!academicYearForDemand ? (
            <EmptyState
              title="No academic year to summarise"
              description="Open a subject choice window for an academic year to see the demand matrix."
            />
          ) : demand.isLoading ? (
            <LoadingSpinner />
          ) : (demand.data ?? []).length === 0 ? (
            <EmptyState
              title="No submissions yet"
              description="Students haven't submitted any choices in this window."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-700">Course</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-700">Students</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-700">Required</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-700">Ranked first</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {(demand.data ?? []).map((row) => (
                    <tr key={row.courseId}>
                      <td className="px-4 py-2 font-medium text-gray-900">{row.courseName}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{row.totalStudents}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{row.requiredCount}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{row.rankedFirstCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
          {isStaff ? 'All submissions' : 'My submissions'}
        </h2>
        {choices.isLoading ? (
          <LoadingSpinner />
        ) : (choices.data ?? []).length === 0 ? (
          <EmptyState
            title="No submissions"
            description={
              isStaff
                ? 'No students have submitted choices yet.'
                : 'You have no submissions on file.'
            }
          />
        ) : (
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
            {(choices.data ?? []).map((c) => (
              <li key={c.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <div className="font-medium text-gray-900">
                    {c.courseName ?? c.courseId}{' '}
                    {c.isRequired && (
                      <span className="ml-2 rounded bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800">
                        Required
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {c.preferenceRank ? `Rank #${c.preferenceRank}` : 'Unranked'} —{' '}
                    {c.submittedAt
                      ? `submitted ${new Date(c.submittedAt).toLocaleDateString()}`
                      : 'draft'}
                  </div>
                </div>
                <span className="text-xs text-gray-400">{c.studentId.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
