'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useClass } from '@/hooks/use-attendance';
import { useAssignment, useUpdateAssignment } from '@/hooks/use-classroom';
import { ClassTabs } from '@/components/classroom/ClassTabs';
import { AssignmentForm } from '@/components/classroom/AssignmentForm';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

export default function EditAssignmentPage() {
  const params = useParams<{ id: string; assignmentId: string }>();
  const classId = params?.id ?? '';
  const assignmentId = params?.assignmentId ?? '';
  const router = useRouter();
  const { toast } = useToast();

  const classQuery = useClass(classId);
  const assignmentQuery = useAssignment(assignmentId);
  const update = useUpdateAssignment(assignmentId, classId);
  const [serverError, setServerError] = useState<string | null>(null);

  if (classQuery.isLoading || assignmentQuery.isLoading || !classQuery.data) {
    return <PageLoader label="Loading assignment…" />;
  }

  const cls = classQuery.data;
  const assignment = assignmentQuery.data ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/classes/${classId}/assignments`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to assignments
      </Link>

      <PageHeader
        title={assignment?.title ?? 'Edit assignment'}
        description={`${cls.course.name} · Period ${cls.sectionCode}`}
      />

      <ClassTabs classId={classId} active="assignments" />

      {assignment ? (
        <AssignmentForm
          classId={classId}
          initial={assignment}
          submitting={update.isPending}
          submitLabel="Save changes"
          serverError={serverError}
          onCancel={() => router.push(`/classes/${classId}/assignments`)}
          onSubmit={async (payload) => {
            setServerError(null);
            try {
              const updated = await update.mutateAsync(payload);
              toast(
                updated.isPublished ? 'Assignment updated and published' : 'Assignment updated',
                'success',
              );
              router.push(`/classes/${classId}/assignments`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Failed to save changes';
              setServerError(msg);
            }
          }}
        />
      ) : (
        <div className="rounded-card border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 shadow-card">
          Assignment not found.
        </div>
      )}
    </div>
  );
}
