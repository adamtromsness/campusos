'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuthStore } from '@/lib/auth-store';
import { useFamilyTree } from '@/hooks/use-relationships';
import { FamilyTreeView } from '@/components/family/FamilyTreeView';

/**
 * Family Tree — MVP list view. Read-only projection of the current
 * user's family structure. The graphical SVG tree is deferred.
 */
export default function FamilyTreePage() {
  const personId = useAuthStore((s) => s.user?.personId ?? null);
  const { data, isLoading, isError } = useFamilyTree(personId);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Family Tree"
        description="A read-only view of your biological, legal, and step-family relationships."
        actions={
          <Link
            href="/family"
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            ← My Family
          </Link>
        }
      />

      {isLoading && <PageLoader label="Loading family tree…" />}

      {!isLoading && (isError || !data) && (
        <EmptyState
          title="Couldn't load the family tree"
          description="Please try again in a moment."
        />
      )}

      {!isLoading && data && <FamilyTreeView tree={data} />}
    </div>
  );
}
