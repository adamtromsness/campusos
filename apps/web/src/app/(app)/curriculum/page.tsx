'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useCurAdoptions, useCurFrameworks, useCurMaps } from '@/hooks/use-curriculum';
import {
  CUR_MAP_STATUS_LABELS,
  CUR_MAP_STATUS_PILL,
  CUR_FRAMEWORK_SOURCE_PILL,
  CUR_FRAMEWORK_SOURCE_LABELS,
} from '@/lib/curriculum-format';

export default function CurriculumHomePage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['tch-008:admin', 'sch-001:admin']);
  const isWriter = hasAnyPermission(user, ['tch-008:write']);

  const frameworks = useCurFrameworks();
  const adoptions = useCurAdoptions();
  const maps = useCurMaps();

  const adoptedCount =
    frameworks.data?.filter((f) => f.source === 'PLATFORM' && f.isActive).length ?? 0;
  const customCount = frameworks.data?.filter((f) => f.source === 'SCHOOL').length ?? 0;
  const publishedMaps = maps.data?.filter((m) => m.status === 'PUBLISHED').length ?? 0;
  const draftMaps = maps.data?.filter((m) => m.status === 'DRAFT').length ?? 0;

  // Aggregate gap counts across all maps
  let gapComplete = 0;
  let gapPartial = 0;
  let gapNotStarted = 0;
  for (const m of maps.data ?? []) {
    gapComplete += m.gapSummary.complete;
    gapPartial += m.gapSummary.partial;
    gapNotStarted += m.gapSummary.notStarted;
  }
  const gapTotal = gapComplete + gapPartial + gapNotStarted;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Curriculum"
        description="Frameworks, scope-and-sequence maps, unit planning, and delivery gaps"
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Adopted frameworks" value={adoptedCount} />
        <Stat label="Custom frameworks" value={customCount} />
        <Stat label="Published maps" value={publishedMaps} />
        <Stat label="Draft maps" value={draftMaps} />
      </div>

      {gapTotal > 0 ? (
        <section className="rounded-md border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Delivery gap summary</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <GapBox label="Complete" count={gapComplete} total={gapTotal} tone="emerald" />
            <GapBox label="Partial" count={gapPartial} total={gapTotal} tone="amber" />
            <GapBox label="Not started" count={gapNotStarted} total={gapTotal} tone="rose" />
          </div>
          <Link
            href="/curriculum/gaps"
            className="mt-3 inline-block text-sm font-medium text-campus-700 hover:underline"
          >
            View gap heatmap →
          </Link>
        </section>
      ) : null}

      <nav className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <NavTile
          href="/curriculum/frameworks"
          label="Frameworks"
          sub={`${frameworks.data?.length ?? 0} catalogues`}
        />
        <NavTile href="/curriculum/gaps" label="Delivery gaps" sub={`${gapTotal} tracked`} />
        <NavTile href="/curriculum/resources" label="Resources" sub="Teaching materials" />
        {isWriter ? (
          <NavTile href="/curriculum/my" label="My curriculum" sub="Maps for my subjects" />
        ) : null}
      </nav>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Active maps</h2>
        {(maps.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No curriculum maps yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {maps.data?.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2">
                <div>
                  <Link
                    href={`/curriculum/maps/${m.id}`}
                    className="font-medium text-campus-700 hover:underline"
                  >
                    {m.title}
                  </Link>
                  <p className="text-xs text-gray-500">
                    {m.subject} · Grade {m.gradeLevel} · {m.academicYearName}
                    {m.frameworkName ? ` · ${m.frameworkName}` : ''}
                  </p>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs ${CUR_MAP_STATUS_PILL[m.status]}`}>
                  {CUR_MAP_STATUS_LABELS[m.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(adoptions.data?.length ?? 0) > 0 ? (
        <section className="rounded-md border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Framework adoptions</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {adoptions.data?.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="font-medium">{a.platformFrameworkName}</p>
                  <p className="text-xs text-gray-500">Adopted for {a.academicYearName}</p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${CUR_FRAMEWORK_SOURCE_PILL.PLATFORM}`}
                >
                  {CUR_FRAMEWORK_SOURCE_LABELS.PLATFORM}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!isAdmin && !isWriter ? (
        <p className="text-sm text-gray-500">
          Maps published for your child / your classes will appear here.
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

function GapBox({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: 'emerald' | 'amber' | 'rose';
}) {
  const pct = total === 0 ? 0 : Math.round((count / total) * 100);
  const colours: Record<typeof tone, string> = {
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    rose: 'text-rose-700',
  };
  return (
    <div className="rounded-md border border-gray-200 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-semibold ${colours[tone]}`}>{count}</p>
      <p className="text-xs text-gray-400">{pct}%</p>
    </div>
  );
}

function NavTile({ href, label, sub }: { href: string; label: string; sub: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-gray-200 bg-white p-4 transition hover:border-campus-400 hover:bg-campus-50"
    >
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-xs text-gray-500">{sub}</p>
    </Link>
  );
}
