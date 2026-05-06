'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useCurFrameworks, useCurStandards } from '@/hooks/use-curriculum';
import { CUR_FRAMEWORK_SOURCE_LABELS, CUR_FRAMEWORK_SOURCE_PILL } from '@/lib/curriculum-format';

/**
 * Cycle 23 framework browser — DUAL-RESOLUTION list of platform-
 * adopted + school-custom + (admin only) unadopted platform
 * frameworks. GIN-backed standards search bar across both
 * catalogues.
 */
export default function FrameworksPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['tch-008:admin', 'sch-001:admin']);
  const [includeUnadopted, setIncludeUnadopted] = useState(false);
  const [q, setQ] = useState('');
  const frameworks = useCurFrameworks(includeUnadopted && isAdmin);
  const standards = useCurStandards({ q: q || undefined, enabled: q.length > 0 });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Frameworks & Standards"
        description="Browse adopted national frameworks (CCSS, NGSS) and school-custom frameworks. Search standards across both catalogues."
      />

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <input
          type="text"
          placeholder="Search standards (e.g. 'narrative', 'fractions', 'photosynthesis')"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        {q && standards.data ? (
          <div className="mt-3 max-h-96 overflow-y-auto">
            <p className="mb-2 text-xs text-gray-500">{standards.data.length} match(es)</p>
            <ul className="divide-y divide-gray-100 text-sm">
              {standards.data.map((s) => (
                <li key={s.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-gray-50 px-1 py-0.5 text-xs">{s.code}</code>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${CUR_FRAMEWORK_SOURCE_PILL[s.source]}`}
                    >
                      {CUR_FRAMEWORK_SOURCE_LABELS[s.source]}
                    </span>
                    {s.gradeBand ? (
                      <span className="text-xs text-gray-500">Grade {s.gradeBand}</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-gray-700">{s.description}</p>
                  <p className="text-xs text-gray-400">
                    {s.frameworkName}
                    {s.domain ? ` · ${s.domain}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {isAdmin ? (
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={includeUnadopted}
            onChange={(e) => setIncludeUnadopted(e.target.checked)}
          />
          Show unadopted platform frameworks (for adoption picker)
        </label>
      ) : null}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Frameworks</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {frameworks.data?.map((f) => (
            <div
              key={f.id}
              className={`rounded-md border p-4 ${
                f.isActive ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-70'
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="font-semibold">{f.name}</p>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${CUR_FRAMEWORK_SOURCE_PILL[f.source]}`}
                >
                  {CUR_FRAMEWORK_SOURCE_LABELS[f.source]}
                </span>
              </div>
              {f.body ? <p className="mt-1 text-xs text-gray-500">{f.body}</p> : null}
              {f.region || f.version ? (
                <p className="text-xs text-gray-500">
                  {[f.region, f.version].filter(Boolean).join(' · ')}
                </p>
              ) : null}
              {f.description ? <p className="mt-2 text-sm text-gray-700">{f.description}</p> : null}
              <p className="mt-2 text-xs text-gray-400">
                {f.standardCount} standard{f.standardCount === 1 ? '' : 's'}
                {!f.isActive && f.source === 'PLATFORM' ? ' · Not yet adopted' : ''}
              </p>
            </div>
          ))}
          {!frameworks.isLoading && (frameworks.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-gray-500">No frameworks yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
