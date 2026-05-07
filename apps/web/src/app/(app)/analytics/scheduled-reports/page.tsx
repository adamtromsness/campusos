'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  useCreateScheduledReport,
  useReportDefinitions,
  useRunScheduledNow,
  useScheduledReports,
} from '@/hooks/use-analytics';
import {
  DELIVERY_CHANNELS,
  OUTPUT_FORMATS,
  RUN_STATUS_PILL,
  describeCron,
  formatRelativeAgo,
} from '@/lib/analytics-format';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

export default function ScheduledReportsPage() {
  const user = useAuthStore((s) => s.user);
  const isWriter = hasAnyPermission(user, ['rpt-004:write']);
  const { toast } = useToast();
  const data = useScheduledReports();
  const definitions = useReportDefinitions();
  const create = useCreateScheduledReport();
  const runNow = useRunScheduledNow();

  const [open, setOpen] = useState(false);
  const [reportName, setReportName] = useState('');
  const [definitionId, setDefinitionId] = useState('');
  const [scheduleCron, setScheduleCron] = useState('0 8 * * MON');
  const [timezone, setTimezone] = useState('America/Chicago');
  const [outputFormat, setOutputFormat] = useState<'CSV' | 'PDF' | 'XLSX'>('CSV');
  const [deliveryChannel, setDeliveryChannel] = useState<'EMAIL' | 'IN_APP' | 'BOTH'>('EMAIL');

  const onCreate = async () => {
    if (!reportName || !definitionId) {
      toast('Pick a name and a report', 'error');
      return;
    }
    const def = (definitions.data ?? []).find((d) => d.id === definitionId);
    try {
      await create.mutateAsync({
        reportName,
        templateName: def?.name ?? reportName,
        reportParams: { definition_id: definitionId },
        scheduleCron,
        timezone,
        deliveryChannel,
        outputFormat,
        recipientIds: user?.id ? [user.id] : [],
      });
      toast('Schedule created', 'success');
      setOpen(false);
      setReportName('');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Failed', 'error');
    }
  };

  const onRunNow = async (id: string) => {
    try {
      const r = await runNow.mutateAsync(id);
      toast(
        `Run ${r.lastRunStatus} — next ${r.nextRunAt?.slice(0, 10) ?? 'tbd'}`,
        r.lastRunStatus === 'SUCCESS' ? 'success' : 'error',
      );
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Scheduled reports"
        description="Cron-driven recurring delivery via the ScheduledReportWorker."
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
                New schedule
              </button>
            )}
          </div>
        }
      />

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No scheduled reports yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Report</Th>
                <Th>Schedule</Th>
                <Th>Channel</Th>
                <Th>Format</Th>
                <Th>Last run</Th>
                <Th>Next run</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data.data ?? []).map((s) => (
                <tr
                  key={s.id}
                  className={s.isActive ? 'hover:bg-gray-50' : 'bg-gray-50 opacity-70'}
                >
                  <Td>
                    <div className="font-medium text-gray-900">{s.reportName}</div>
                    <div className="text-xs text-gray-500">{s.templateName}</div>
                  </Td>
                  <Td>
                    <div className="text-sm">{describeCron(s.scheduleCron)}</div>
                    <div className="text-xs text-gray-500">{s.timezone}</div>
                  </Td>
                  <Td>{s.deliveryChannel}</Td>
                  <Td>{s.outputFormat}</Td>
                  <Td className="text-xs text-gray-500">{formatRelativeAgo(s.lastRunAt)}</Td>
                  <Td className="text-xs text-gray-500">
                    {s.nextRunAt ? s.nextRunAt.slice(0, 16).replace('T', ' ') : '—'}
                  </Td>
                  <Td>
                    {s.lastRunStatus ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.lastRunStatus === 'SUCCESS' ? RUN_STATUS_PILL.COMPLETE : RUN_STATUS_PILL.FAILED}`}
                      >
                        {s.lastRunStatus}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </Td>
                  <Td>
                    {isWriter && (
                      <button
                        onClick={() => onRunNow(s.id)}
                        disabled={runNow.isPending}
                        className="text-xs text-campus-700 hover:underline disabled:opacity-50"
                      >
                        Run now
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New scheduled report"
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
              disabled={create.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Schedule name</div>
            <input
              value={reportName}
              onChange={(e) => setReportName(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Source report definition</div>
            <select
              value={definitionId}
              onChange={(e) => setDefinitionId(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">— pick —</option>
              {(definitions.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">Cron (5 fields)</div>
              <input
                value={scheduleCron}
                onChange={(e) => setScheduleCron(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
              />
              <div className="mt-1 text-xs text-gray-500">{describeCron(scheduleCron)}</div>
            </label>
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">Timezone</div>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">Channel</div>
              <select
                value={deliveryChannel}
                onChange={(e) => setDeliveryChannel(e.target.value as 'EMAIL' | 'IN_APP' | 'BOTH')}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {DELIVERY_CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">Output format</div>
              <select
                value={outputFormat}
                onChange={(e) => setOutputFormat(e.target.value as 'CSV' | 'PDF' | 'XLSX')}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {OUTPUT_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </Modal>
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
