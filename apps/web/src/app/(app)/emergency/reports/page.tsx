'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import { useNonDisciplineReports, useUpdateNonDiscipline } from '@/hooks/use-incidents';
import {
  NON_DISCIPLINE_STATUS_LABEL,
  NON_DISCIPLINE_STATUS_PILL,
  NON_DISCIPLINE_STATUSES,
  NON_DISCIPLINE_SEVERITY_PILL,
  NON_DISCIPLINE_TYPE_LABEL,
  NonDisciplineStatus,
  formatDateTime,
  formatRelative,
} from '@/lib/incidents-format';

export default function ReportsLogPage() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const canReview = hasAnyPermission(user, ['saf-003:admin']);
  const [statusFilter, setStatusFilter] = useState<NonDisciplineStatus | ''>('');
  const reports = useNonDisciplineReports({
    status: statusFilter || undefined,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Incident Reports</h1>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/emergency/report">
            Report incident
          </Link>
          <Link className="text-sky-700 hover:underline" href="/emergency">
            ← Dashboard
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">Status:</label>
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as NonDisciplineStatus | '')}
        >
          <option value="">All</option>
          {NON_DISCIPLINE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {NON_DISCIPLINE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <table className="min-w-full rounded border border-slate-200 bg-white text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th className="px-4 py-2">Type</th>
            <th>Severity</th>
            <th>Location</th>
            <th>When</th>
            <th>Reported by</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(reports.data ?? []).map((r) => (
            <ReportRow
              key={r.id}
              report={r}
              canReview={canReview}
              onError={(m) => toast(m, 'error')}
              onSuccess={(m) => toast(m)}
            />
          ))}
          {(reports.data ?? []).length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-3 text-slate-500">
                No reports.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function ReportRow({
  report,
  canReview,
  onError,
  onSuccess,
}: {
  report: ReturnType<typeof useNonDisciplineReports>['data'] extends infer T
    ? T extends Array<infer U>
      ? U
      : never
    : never;
  canReview: boolean;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  const update = useUpdateNonDiscipline(report.id);
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState(report.resolution ?? '');

  return (
    <>
      <tr>
        <td className="px-4 py-2">{NON_DISCIPLINE_TYPE_LABEL[report.incidentType]}</td>
        <td>
          <span
            className={`rounded px-2 py-0.5 text-xs ${NON_DISCIPLINE_SEVERITY_PILL[report.severity]}`}
          >
            {report.severity}
          </span>
        </td>
        <td>{report.location ?? '—'}</td>
        <td>{formatDateTime(report.incidentDate)}</td>
        <td>{report.reportedByName ?? '—'}</td>
        <td>
          <span
            className={`rounded px-2 py-0.5 text-xs ${NON_DISCIPLINE_STATUS_PILL[report.status]}`}
          >
            {NON_DISCIPLINE_STATUS_LABEL[report.status]}
          </span>
        </td>
        <td>
          <button className="text-sky-700 hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Detail'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={7} className="bg-slate-50 px-4 py-3">
            <div className="space-y-2 text-sm">
              <div>
                <span className="font-semibold">Description:</span> {report.description}
              </div>
              {report.witnesses ? (
                <div>
                  <span className="font-semibold">Witnesses:</span> {report.witnesses}
                </div>
              ) : null}
              <div className="text-xs text-slate-500">
                Reported {formatRelative(report.createdAt)} · {report.studentsInvolved.length}{' '}
                students · {report.staffInvolved.length} staff
                {report.followUpTicketId ? ` · ticket ${report.followUpTicketId.slice(0, 8)}` : ''}
              </div>

              {canReview ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
                  <label className="text-xs font-medium uppercase text-slate-600">Status:</label>
                  <select
                    className="rounded border border-slate-300 px-2 py-1 text-xs"
                    value={report.status}
                    onChange={async (e) => {
                      try {
                        await update.mutateAsync({
                          status: e.target.value as NonDisciplineStatus,
                        });
                        onSuccess('Status updated');
                      } catch (err) {
                        onError(`Update failed: ${(err as Error).message}`);
                      }
                    }}
                  >
                    {NON_DISCIPLINE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {NON_DISCIPLINE_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  <input
                    className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
                    placeholder="Resolution notes"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  />
                  <button
                    className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white"
                    disabled={update.isPending}
                    onClick={async () => {
                      try {
                        await update.mutateAsync({ resolution });
                        onSuccess('Resolution saved');
                      } catch (err) {
                        onError(`Save failed: ${(err as Error).message}`);
                      }
                    }}
                  >
                    Save resolution
                  </button>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
