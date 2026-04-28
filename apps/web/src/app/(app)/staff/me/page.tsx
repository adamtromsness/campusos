'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useMyEmployee } from '@/hooks/use-hr';

export default function StaffMeRedirectPage() {
  const router = useRouter();
  const me = useMyEmployee();

  useEffect(() => {
    if (me.data) {
      router.replace(`/staff/${me.data.id}`);
    }
  }, [me.data, router]);

  if (me.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (me.isError || !me.data) {
    return (
      <EmptyState
        title="No employee record"
        description="The calling user has no hr_employees row. Only school employees can resolve /staff/me."
      />
    );
  }
  // While the redirect runs.
  return (
    <div className="py-16 text-center">
      <LoadingSpinner />
    </div>
  );
}
