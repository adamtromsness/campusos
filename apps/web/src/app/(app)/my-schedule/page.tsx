'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { TimetableWeekView } from '@/components/scheduling/TimetableWeekView';
import { useMyEmployee } from '@/hooks/use-hr';
import { useMyStudent } from '@/hooks/use-classroom';
import {
  useSubstitutionsForTeacher,
  useTimetableForStudent,
  useTimetableForTeacher,
} from '@/hooks/use-scheduling';
import { useAuthStore } from '@/lib/auth-store';
import { addDaysIso, todayIso } from '@/lib/scheduling-format';

export default function MySchedulePage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  if (user.personType === 'STAFF') return <TeacherScheduleView />;
  if (user.personType === 'STUDENT') return <StudentScheduleView />;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="My Schedule" description="Your weekly timetable." />
      <EmptyState
        title="No schedule available"
        description="My Schedule is available to staff and students. Parents can find their child's schedule from the My Children page."
      />
    </div>
  );
}

function TeacherScheduleView() {
  const me = useMyEmployee();
  const employeeId = me.data?.id ?? null;
  const slots = useTimetableForTeacher(employeeId);
  const fromIso = todayIso();
  const toIso = addDaysIso(fromIso, 14);
  const subs = useSubstitutionsForTeacher(employeeId, { fromDate: fromIso, toDate: toIso });

  const upcomingCovers = useMemo(() => subs.data ?? [], [subs.data]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="My Schedule"
        description="Your weekly timetable. Substitution overrides for the next two weeks are highlighted."
      />

      {me.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : !employeeId ? (
        <EmptyState
          title="No employee record"
          description="Your account isn't linked to an hr_employees row, so a teaching schedule isn't available."
        />
      ) : (
        <TimetableWeekView
          slots={slots.data ?? []}
          loading={slots.isLoading}
          error={slots.isError}
          emptyTitle="No assigned classes"
          emptyDescription="You aren't currently scheduled for any periods."
          showTeacher={false}
          showRoom={true}
          substitutions={upcomingCovers}
        />
      )}

      {employeeId && upcomingCovers.length > 0 && (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-amber-900">Upcoming substitution coverage</h3>
          <p className="mt-1 text-xs text-amber-800">
            You&apos;re covering for another teacher on these dates.
          </p>
          <ul className="mt-3 divide-y divide-amber-100 rounded-lg bg-white">
            {upcomingCovers.map((sub) => (
              <li key={sub.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">
                    {sub.effectiveDate} · {sub.periodName} · {sub.classSectionCode}{' '}
                    <span className="text-gray-500">{sub.courseName}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    Covering for {sub.absentTeacherName ?? 'a colleague'} · Room {sub.roomName}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StudentScheduleView() {
  const me = useMyStudent();
  const studentId = me.data?.id ?? null;
  const slots = useTimetableForStudent(studentId);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="My Schedule"
        description="Your weekly class timetable."
        actions={
          <Link
            href="/classes"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            My Classes
          </Link>
        }
      />

      {me.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : !studentId ? (
        <EmptyState
          title="No student record"
          description="Your account isn't linked to a student record."
        />
      ) : (
        <TimetableWeekView
          slots={slots.data ?? []}
          loading={slots.isLoading}
          error={slots.isError}
          emptyTitle="No classes scheduled"
          emptyDescription="Once you're enrolled in classes with a timetable, they'll show here."
          showTeacher={true}
          showRoom={true}
        />
      )}
    </div>
  );
}
