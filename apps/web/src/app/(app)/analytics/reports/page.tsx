'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  useCreateReportDefinition,
  useReportDefinitions,
  useRunReport,
} from '@/hooks/use-analytics';
import { OUTPUT_FORMATS } from '@/lib/analytics-format';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

export default function ReportBuilderPage() {
  const user = useAuthStore((s) => s.user);
  const isWriter = hasAnyPermission(user, ['rpt-004:write']);
  const { toast } = useToast();
  const data = useReportDefinitions();
  const createDef = useCreateReportDefinition();
  const runReport = useRunReport();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [reportType, setReportType] = useState('ATTENDANCE');
  const [dataSource, setDataSource] = useState('rpt_daily_attendance_summary');

  const onCreate = async () => {
    try {
      await createDef.mutateAsync({
        name,
        description,
        reportType,
        templateConfig: { data_source: dataSource, columns: [], filters: {} },
      });
      toast('Report definition created', 'success');
      setOpen(false);
      setName('');
      setDescription('');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Failed', 'error');
    }
  };

  const onRun = async (id: string) => {
    try {
      const r = await runReport.mutateAsync({ id, outputFormat: 'CSV' });
      toast(
        `Run ${r.status} — ${r.rowCount ?? 0} rows`,
        r.status === 'COMPLETE' ? 'success' : 'error',
      );
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Run failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Report builder"
        description="Configurable report definitions. Run on-demand or schedule via /analytics/scheduled-reports."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
              ← Analytics
            </Link>
            {isWriter && (
              <button
                onClick={() => setOpen(true)}
                className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
              >
                New report
              </button>
            )}
          </div>
        }
      />

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No report definitions yet.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {(data.data ?? []).map((d) => (
            <div key={d.id} className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-gray-900">{d.name}</div>
                  {d.description && <div className="text-xs text-gray-500">{d.description}</div>}
                  <div className="mt-1 text-xs text-gray-500">{d.reportType}</div>
                </div>
                {d.isStateReport && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">
                    State
                  </span>
                )}
              </div>
              <pre className="mt-2 overflow-x-auto rounded-md bg-gray-50 p-2 text-xs text-gray-800">
                {JSON.stringify(d.templateConfig, null, 2)}
              </pre>
              <div className="mt-3 flex items-center gap-3 text-sm">
                {isWriter && (
                  <button
                    onClick={() => onRun(d.id)}
                    disabled={runReport.isPending}
                    className="rounded-md bg-campus-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Run now
                  </button>
                )}
                <Link
                  href={`/analytics/reports/${d.id}/runs`}
                  className="text-xs text-campus-700 hover:underline"
                >
                  Run history →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New report definition"
        footer={
          <>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onCreate}
              disabled={createDef.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Description</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Report type</div>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="ATTENDANCE">Attendance</option>
              <option value="ACADEMIC">Academic</option>
              <option value="FINANCE">Finance</option>
              <option value="COMPLIANCE">Compliance</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </label>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Data source</div>
            <select
              value={dataSource}
              onChange={(e) => setDataSource(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="rpt_daily_attendance_summary">Daily attendance</option>
              <option value="rpt_student_academic_summary">Student academic</option>
              <option value="rpt_class_performance_summary">Class performance</option>
              <option value="rpt_school_summary">School summary</option>
              <option value="rpt_district_summary">District summary</option>
              <option value="rpt_fin_aged_debtors">Aged debtors</option>
              <option value="rpt_wellbeing_trends">Wellbeing trends</option>
            </select>
          </label>
          <div className="rounded-md bg-sky-50 p-3 text-xs text-sky-800">
            Output format defaults to CSV at run time. Pick {OUTPUT_FORMATS.length} formats per run.
          </div>
        </div>
      </Modal>
    </div>
  );
}
