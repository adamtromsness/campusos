'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useStateReportTemplates } from '@/hooks/use-analytics';

export default function StateReportsPage() {
  const data = useStateReportTemplates();

  return (
    <div>
      <PageHeader
        title="State compliance reports"
        description="Platform-seeded state DOE templates. Generate per school + submit per the state portal."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No state report templates available.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {(data.data ?? []).map((t) => {
            const cfg = (t.templateConfig ?? {}) as Record<string, unknown>;
            const title = (cfg.title as string) ?? `${t.stateCode} ${t.reportType}`;
            const url = (cfg.submission_url as string) ?? null;
            return (
              <div
                key={t.id}
                className="rounded-card border border-gray-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-base font-semibold text-gray-900">{title}</div>
                    <div className="mt-1 text-xs text-gray-500">
                      {t.stateCode} · {t.reportType} · {t.schemaVersion}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${t.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}
                  >
                    {t.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <pre className="mt-3 overflow-x-auto rounded-md bg-gray-50 p-2 text-xs text-gray-800">
                  {JSON.stringify(cfg, null, 2)}
                </pre>
                {url && (
                  <div className="mt-2 text-xs">
                    Submission portal:{' '}
                    <a
                      className="text-campus-700 hover:underline"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {url}
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
