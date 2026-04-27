'use client';

import { useParams } from 'next/navigation';
import { StudentClassGradesView } from '@/components/classroom/StudentClassGradesView';

export default function ChildClassGradesPage() {
  const params = useParams<{ id: string; classId: string }>();
  const childId = params?.id ?? '';
  const classId = params?.classId ?? '';

  return (
    <StudentClassGradesView
      studentId={childId}
      classId={classId}
      backHref={`/children/${childId}/grades`}
      backLabel="Back to all classes"
    />
  );
}
