'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { TimetableWeekView } from '@/components/scheduling/TimetableWeekView';
import { useStudent } from '@/hooks/use-children';
import { useTimetableForStudent } from '@/hooks/use-scheduling';
import { useAuthStore } from '@/lib/auth-store';

export default function ChildSchedulePage() {
  const params = useParams<{ id: string }>();
  const studentId = params?.id ?? '';
  const user = useAuthStore((s) => s.user);

  const student = useStudent(studentId || undefined);
  const slots = useTimetableForStudent(studentId || null);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={student.data?.fullName ?? 'Schedule'}
        description={
          student.data
            ? `Weekly class timetable${student.data.gradeLevel ? ` · Grade ${student.data.gradeLevel}` : ''}`
            : 'Weekly class timetable'
        }
        actions={
          <Link
            href="/children"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            My Children
          </Link>
        }
      />

      {student.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : student.isError || !student.data ? (
        <EmptyState
          title="Couldn't load this child"
          description="If this is unexpected, contact the school office to confirm your guardian record."
        />
      ) : (
        <TimetableWeekView
          slots={slots.data ?? []}
          loading={slots.isLoading}
          error={slots.isError}
          emptyTitle="No schedule yet"
          emptyDescription="Once classes are scheduled, they'll appear here."
          showTeacher={true}
          showRoom={true}
        />
      )}
    </div>
  );
}
