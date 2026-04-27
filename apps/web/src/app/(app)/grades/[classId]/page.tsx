'use client';

import { useParams } from 'next/navigation';
import { useMyStudent } from '@/hooks/use-classroom';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { StudentClassGradesView } from '@/components/classroom/StudentClassGradesView';
import { useAuthStore } from '@/lib/auth-store';

export default function StudentClassGradesPage() {
  const user = useAuthStore((s) => s.user);
  const params = useParams<{ classId: string }>();
  const classId = params?.classId ?? '';
  const me = useMyStudent();

  if (!user) return null;
  if (user.personType !== 'STUDENT') {
    return (
      <EmptyState
        title="Not available"
        description="The student grades view is only available to students."
      />
    );
  }
  if (me.isLoading) return <PageLoader />;

  return (
    <StudentClassGradesView
      studentId={me.data?.id}
      classId={classId}
      backHref="/grades"
      backLabel="Back to all classes"
    />
  );
}
