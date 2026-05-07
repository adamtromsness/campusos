'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { useReportDefinition, useReportRuns } from '@/hooks/use-analytics';
import { RUN_STATUS_LABEL, RUN_STATUS_PILL, formatRelativeAgo } from '@/lib/analytics-format';

export default function ReportRunsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;
  const def = useReportDefinition(id);
  const runs = useReportRuns(id);

  return (
    <div>
      <PageHeader
        title={def.data?.name ?? 'Report runs'}
        description="On-demand + scheduled run history."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/analytics/reports" className="text-sm text-campus-600 hover:underline">
              ← Reports
            </Link>
          </div>
        }
      />

      {runs.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (runs.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No runs yet. Click &quot;Run now&quot; on the report list.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Status</Th>
                <Th>Format</Th>
                <Th className="text-right">Rows</Th>
                <Th>Started</Th>
                <Th>Completed</Th>
                <Th>Run by</Th>
                <Th>Output</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(runs.data ?? []).map((r) => (
                <tr key={r.id}>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RUN_STATUS_PILL[r.status]}`}
                    >
                      {RUN_STATUS_LABEL[r.status]}
                    </span>
                  </Td>
                  <Td>{r.outputFormat}</Td>
                  <Td className="text-right">{r.rowCount ?? '—'}</Td>
                  <Td className="text-xs text-gray-500">{formatRelativeAgo(r.startedAt)}</Td>
                  <Td className="text-xs text-gray-500">
                    {r.generatedAt ? formatRelativeAgo(r.generatedAt) : '—'}
                  </Td>
                  <Td>{r.runByName ?? '—'}</Td>
                  <Td className="font-mono text-xs text-gray-600">
                    {r.outputS3Key ? r.outputS3Key.slice(0, 50) + '…' : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
