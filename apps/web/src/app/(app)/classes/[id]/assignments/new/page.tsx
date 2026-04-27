'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useClass } from '@/hooks/use-attendance';
import { useCreateAssignment } from '@/hooks/use-classroom';
import { ClassTabs } from '@/components/classroom/ClassTabs';
import { AssignmentForm } from '@/components/classroom/AssignmentForm';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

export default function NewAssignmentPage() {
  const params = useParams<{ id: string }>();
  const classId = params?.id ?? '';
  const router = useRouter();
  const { toast } = useToast();

  const classQuery = useClass(classId);
  const create = useCreateAssignment(classId);
  const [serverError, setServerError] = useState<string | null>(null);

  if (classQuery.isLoading || !classQuery.data) {
    return <PageLoader label="Loading class…" />;
  }

  const cls = classQuery.data;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/classes/${classId}/assignments`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to assignments
      </Link>

      <PageHeader
        title="New assignment"
        description={`${cls.course.name} · Period ${cls.sectionCode}`}
      />

      <ClassTabs classId={classId} active="assignments" hideGradebook />

      <AssignmentForm
        classId={classId}
        submitting={create.isPending}
        submitLabel="Create assignment"
        serverError={serverError}
        onCancel={() => router.push(`/classes/${classId}/assignments`)}
        onSubmit={async (payload) => {
          setServerError(null);
          try {
            const created = await create.mutateAsync(payload);
            toast(
              created.isPublished ? 'Assignment created and published' : 'Assignment saved as draft',
              'success',
            );
            router.push(`/classes/${classId}/assignments`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to create assignment';
            setServerError(msg);
          }
        }}
      />
    </div>
  );
}
