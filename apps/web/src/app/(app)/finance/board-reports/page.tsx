'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, Modal, useToast } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useBoardReports, useGenerateBoardReport, usePeriods } from '@/hooks/use-finance';
import { REPORT_TYPE_LABELS, formatDateTime } from '@/lib/finance-format';
import type { FinBoardReportDto, FinReportType } from '@/lib/types';

export default function BoardReportsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['fin-008:write']);
  const reportsQ = useBoardReports();
  const periodsQ = usePeriods('FY2025-2026');
  const reports = reportsQ.data ?? [];
  const periods = periodsQ.data ?? [];
  const [open, setOpen] = useState(false);
  const [reportType, setReportType] = useState<FinReportType>('BUDGET_VS_ACTUAL');
  const [periodId, setPeriodId] = useState<string>('');
  const [view, setView] = useState<FinBoardReportDto | null>(null);
  const generateMut = useGenerateBoardReport();
  const { toast } = useToast();

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Board reports"
        description="IMMUTABLE financial snapshots for board review. Frozen JSONB at generation time."
      />
      <div className="flex items-center justify-between">
        <Link href="/finance" className="text-sm text-campus-700 hover:underline">
          ← Back to finance
        </Link>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Generate report
          </button>
        )}
      </div>

      <div className="space-y-2">
        {reports.map((r) => (
          <div
            key={r.id}
            className="rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">
                  {REPORT_TYPE_LABELS[r.reportType]}
                </h3>
                <p className="text-xs text-gray-500">
                  {r.periodName ?? 'School-wide'} · generated {formatDateTime(r.generatedAt)} by{' '}
                  {r.generatedByName ?? 'unknown'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setView(r)}
                className="text-sm text-campus-700 hover:underline"
              >
                View snapshot
              </button>
            </div>
          </div>
        ))}
        {reports.length === 0 && (
          <p className="text-sm text-gray-500">No board reports generated yet.</p>
        )}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Generate board report"
        footer={
          <div className="flex w-full justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await generateMut.mutateAsync({
                    reportType,
                    periodId: periodId || undefined,
                  });
                  toast('Report generated — frozen snapshot.', 'success');
                  setOpen(false);
                } catch (e: unknown) {
                  toast((e as Error).message, 'error');
                }
              }}
              className="rounded bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
            >
              Generate
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-gray-500">Report type</span>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value as FinReportType)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {(Object.keys(REPORT_TYPE_LABELS) as FinReportType[]).map((t) => (
                <option key={t} value={t}>
                  {REPORT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-gray-500">Period (optional)</span>
            <select
              value={periodId}
              onChange={(e) => setPeriodId(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="">— School-wide —</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.periodName} ({p.status})
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-gray-500">
            The snapshot is frozen at generation time per ADR-010. Once generated, the report is
            IMMUTABLE — no UPDATE / DELETE methods are exposed.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!view}
        onClose={() => setView(null)}
        title={
          view ? `${REPORT_TYPE_LABELS[view.reportType]} — ${view.periodName ?? 'School-wide'}` : ''
        }
      >
        {view && (
          <pre className="max-h-96 overflow-auto rounded bg-gray-50 p-3 text-xs">
            {JSON.stringify(view.reportData, null, 2)}
          </pre>
        )}
      </Modal>
    </div>
  );
}
