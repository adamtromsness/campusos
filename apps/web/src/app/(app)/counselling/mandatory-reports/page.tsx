'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useFileMandatoryReport,
  useMandatoryReports,
  useUpdateMandatoryReport,
} from '@/hooks/use-counselling';
import { useStudentsForReport } from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  REPORT_STATUS_LABELS,
  REPORT_STATUS_PILL,
  REPORT_STATUSES,
  REPORT_TYPE_LABELS,
  REPORT_TYPE_PILL,
  REPORT_TYPES,
  formatDateOnly,
  studentDisplay,
} from '@/lib/counselling-format';
import type { MandatoryReportDto, ReportStatus, ReportType } from '@/lib/types';

export default function MandatoryReportsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['cou-006:admin']);
  const canFile = hasAnyPermission(user, ['cou-006:write']);
  const [statusChip, setStatusChip] = useState<ReportStatus | 'ALL'>('ALL');
  const [filing, setFiling] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const reportsQ = useMandatoryReports({});
  const filtered = useMemo(() => {
    let list = reportsQ.data ?? [];
    if (statusChip !== 'ALL') list = list.filter((r) => r.status === statusChip);
    return [...list].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  }, [reportsQ.data, statusChip]);

  return (
    <div>
      <PageHeader
        title="Mandatory reporting"
        description={
          isAdmin
            ? 'CPS-filing log across the school. Core fields are immutable once filed.'
            : 'Reports you have filed.'
        }
      />

      <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
        <strong>Reminder:</strong> every employee is a mandated reporter. Files are kept
        permanently. Once filed, the description / report type / authority / report date /
        supporting docs are <strong>immutable</strong> — only the case status and CPS response can
        be updated.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChip onClick={() => setStatusChip('ALL')} active={statusChip === 'ALL'}>
          All
        </FilterChip>
        {REPORT_STATUSES.map((s) => (
          <FilterChip key={s} onClick={() => setStatusChip(s)} active={statusChip === s}>
            {REPORT_STATUS_LABELS[s]}
          </FilterChip>
        ))}
        <div className="ml-auto">
          {canFile ? (
            <button
              type="button"
              onClick={() => setFiling(true)}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
            >
              File a report
            </button>
          ) : null}
        </div>
      </div>

      {reportsQ.isLoading ? (
        <LoadingSpinner />
      ) : filtered.length === 0 ? (
        <EmptyState title="No reports" description="Nothing to show for the selected filter." />
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <li
              key={r.id}
              className="cursor-pointer rounded-lg border border-gray-200 bg-white p-3 hover:border-rose-300"
              onClick={() => setOpenId(r.id)}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-medium text-gray-900">
                  {studentDisplay(r.studentFirstName, r.studentLastName)}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      REPORT_TYPE_PILL[r.reportType],
                    )}
                  >
                    {REPORT_TYPE_LABELS[r.reportType]}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      REPORT_STATUS_PILL[r.status],
                    )}
                  >
                    {REPORT_STATUS_LABELS[r.status]}
                  </span>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span>Reported to {r.reportedToAuthority}</span>
                <span>· {formatDateOnly(r.reportDate)}</span>
                {r.reporterName ? <span>· Reporter {r.reporterName}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {filing ? <FileReportModal onClose={() => setFiling(false)} /> : null}
      {openId ? (
        <ReportDetailModal id={openId} isAdmin={isAdmin} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  );
}

function FilterChip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium',
        active
          ? 'border-rose-300 bg-rose-100 text-rose-900'
          : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

function FileReportModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const file = useFileMandatoryReport();
  const studentsQ = useStudentsForReport();
  const [studentId, setStudentId] = useState('');
  const [reportType, setReportType] = useState<ReportType>('SUSPECTED_NEGLECT');
  const [authority, setAuthority] = useState('');
  const [description, setDescription] = useState('');
  return (
    <Modal
      open={true}
      onClose={onClose}
      title="File a mandatory report"
      size="lg"
      footer={
        <div className="flex justify-end gap-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!studentId || !authority.trim() || !description.trim() || file.isPending}
            onClick={async () => {
              try {
                await file.mutateAsync({
                  studentId,
                  reportType,
                  reportedToAuthority: authority.trim(),
                  reportDate: new Date().toISOString(),
                  description: description.trim(),
                });
                toast('Report filed', 'success');
                onClose();
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Failed to file', 'error');
              }
            }}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {file.isPending ? 'Filing…' : 'File report'}
          </button>
        </div>
      }
    >
      <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        Once filed, the description / report type / authority / report date are immutable. Only case
        status and CPS response can be updated as the case evolves.
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-700">Student</label>
          <select
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
          >
            <option value="">— Select student —</option>
            {(studentsQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {studentDisplay(s.firstName, s.lastName)}
                {s.gradeLevel ? ' (Grade ' + s.gradeLevel + ')' : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Report type</label>
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
          >
            {REPORT_TYPES.map((t) => (
              <option key={t} value={t}>
                {REPORT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Reported to authority</label>
          <input
            type="text"
            value={authority}
            onChange={(e) => setAuthority(e.target.value)}
            placeholder="Springfield CPS"
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
            maxLength={200}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detailed factual account of observation."
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
            rows={6}
            maxLength={8000}
          />
        </div>
      </div>
    </Modal>
  );
}

function ReportDetailModal({
  id,
  isAdmin,
  onClose,
}: {
  id: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const reportsQ = useMandatoryReports({});
  const report = (reportsQ.data ?? []).find((r) => r.id === id);
  if (!report) {
    return (
      <Modal open={true} onClose={onClose} title="Report">
        <LoadingSpinner />
      </Modal>
    );
  }
  return (
    <Modal open={true} onClose={onClose} title="Mandatory report" size="lg">
      <ReportDetailBody report={report} isAdmin={isAdmin} onClose={onClose} />
    </Modal>
  );
}

function ReportDetailBody({
  report,
  isAdmin,
  onClose,
}: {
  report: MandatoryReportDto;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateMandatoryReport(report.id);
  const [status, setStatus] = useState<ReportStatus>(report.status);
  const [cps, setCps] = useState(report.cpsResponse ?? '');

  const ImmutableField = ({ label, value }: { label: string; value: string }) => (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold uppercase text-gray-500">{label}</span>
        <span className="rounded-full bg-gray-100 px-1.5 py-0 text-[10px] text-gray-600">
          🔒 immutable
        </span>
      </div>
      <div className="mt-1 text-sm text-gray-800">{value}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            REPORT_TYPE_PILL[report.reportType],
          )}
        >
          {REPORT_TYPE_LABELS[report.reportType]}
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            REPORT_STATUS_PILL[report.status],
          )}
        >
          {REPORT_STATUS_LABELS[report.status]}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <ImmutableField
          label="Student"
          value={studentDisplay(report.studentFirstName, report.studentLastName)}
        />
        <ImmutableField label="Reporter" value={report.reporterName ?? 'Unknown'} />
        <ImmutableField label="Reported to" value={report.reportedToAuthority} />
        <ImmutableField label="Report date" value={formatDateOnly(report.reportDate)} />
      </div>

      <div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold uppercase text-gray-500">Description</span>
          <span className="rounded-full bg-gray-100 px-1.5 py-0 text-[10px] text-gray-600">
            🔒 immutable
          </span>
        </div>
        <div className="mt-1 whitespace-pre-wrap rounded border border-gray-100 bg-gray-50 p-3 text-sm text-gray-800">
          {report.description}
        </div>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
        <h3 className="text-sm font-semibold text-amber-900">Case progression (mutable)</h3>
        <div className="mt-3 space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-700">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ReportStatus)}
              disabled={!isAdmin}
              className="mt-1 w-full rounded border border-gray-300 p-2 text-sm disabled:bg-gray-50"
            >
              {REPORT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {REPORT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">CPS response</label>
            <textarea
              value={cps}
              onChange={(e) => setCps(e.target.value)}
              disabled={!isAdmin}
              className="mt-1 w-full rounded border border-gray-300 p-2 text-sm disabled:bg-gray-50"
              rows={3}
              maxLength={8000}
              placeholder={
                isAdmin ? 'CPS caseworker response, status updates, etc.' : 'Admin-only field.'
              }
            />
          </div>
          {!isAdmin ? (
            <div className="text-xs text-gray-500">
              Only the lead counsellor / school admin (cou-006:admin) can update status + CPS
              response.
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={update.isPending}
                onClick={async () => {
                  try {
                    await update.mutateAsync({
                      status,
                      cpsResponse: cps.trim() ? cps.trim() : null,
                    });
                    toast('Report updated', 'success');
                    onClose();
                  } catch (e) {
                    toast(e instanceof Error ? e.message : 'Failed', 'error');
                  }
                }}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {update.isPending ? 'Saving…' : 'Save status + CPS response'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
