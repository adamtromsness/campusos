'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useRecruitingProfiles } from '@/hooks/use-athletics-advanced';

const INTEREST_PILL: Record<string, string> = {
  EXPLORING: 'bg-gray-100 text-gray-700',
  INTERESTED: 'bg-blue-100 text-blue-700',
  APPLIED: 'bg-amber-100 text-amber-700',
  COMMITTED: 'bg-emerald-100 text-emerald-700',
};

export default function RecruitingPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isCoach = isAdmin || hasAnyPermission(user, ['ath-001:write']);
  const isStudent = user?.activePersona?.type === 'STUDENT';
  const profilesQ = useRecruitingProfiles();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recruiting"
        description={
          isStudent
            ? 'Build your athletic recruiting profile — student-owned, you control publication'
            : 'Athletic recruiting profiles for student athletes'
        }
      />

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Profiles</h2>
        {profilesQ.isLoading ? (
          <LoadingSpinner />
        ) : profilesQ.data && profilesQ.data.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {profilesQ.data.map((p) => (
              <Link
                key={p.id}
                href={`/athletics/recruiting/${p.id}`}
                className="rounded-lg border border-gray-200 p-4 hover:border-emerald-300 hover:bg-emerald-50"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium text-gray-900">{p.studentName ?? 'Student'}</div>
                    <div className="text-xs text-gray-500">
                      {p.sport} · Class of {p.graduationYear}
                    </div>
                  </div>
                  {p.isPublished ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                      Published
                    </span>
                  ) : (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      Draft
                    </span>
                  )}
                </div>
                {p.position ? (
                  <div className="mt-2 text-xs text-gray-600">Position: {p.position}</div>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                  {p.gpa !== null ? <span>GPA {p.gpa.toFixed(2)}</span> : null}
                  {p.heightInches !== null ? (
                    <span>
                      {Math.floor(p.heightInches / 12)}&apos;{p.heightInches % 12}&quot;
                    </span>
                  ) : null}
                  {p.weightLbs !== null ? <span>{p.weightLbs} lbs</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${INTEREST_PILL.EXPLORING}`}>
                    {p.interestCount} {p.interestCount === 1 ? 'college' : 'colleges'}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No recruiting profiles yet.</p>
        )}
      </section>

      {!isStudent && !isCoach ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Only the student themself, a coach, or an admin can create or edit a recruiting profile.
          Parents see their linked children&apos;s profiles read-only.
        </div>
      ) : null}
    </div>
  );
}
