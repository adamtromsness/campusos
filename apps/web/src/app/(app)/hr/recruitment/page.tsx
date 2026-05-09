'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  APPLICATION_STATUS_LABEL,
  APPLICATION_STATUS_PILL,
  ApplicationDto,
  ApplicationStatus,
  EmploymentType,
  JobPostingDto,
  POSTING_STATUS_LABEL,
  POSTING_STATUS_PILL,
  PostingStatus,
  formatCurrencyRange,
  useApplicationsForPosting,
  useJobPostings,
  usePatchJobPosting,
} from '@/hooks/use-recruitment';

/**
 * Recruitment admin pipeline. Admin-only writes (hr-002:write); read
 * surface is hr-002:read which Staff + Admin hold from the P2-4b
 * IAM seed. Non-admin actors fall back to a redirect message.
 */
export default function RecruitmentPipelinePage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, [
    'hr-002:read',
    'hr-002:write',
    'hr-002:admin',
    'sch-001:admin',
  ]);
  const canWrite = hasAnyPermission(user, ['hr-002:write', 'hr-002:admin', 'sch-001:admin']);

  const [statusFilter, setStatusFilter] = useState<PostingStatus | ''>('');
  const postings = useJobPostings(statusFilter ? { status: statusFilter } : undefined);
  const [selectedPostingId, setSelectedPostingId] = useState<string | null>(null);

  if (!canRead) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Recruitment</h1>
        <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          The recruitment pipeline is restricted to school administrators and HR staff.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Recruitment</h1>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/hr/recruitment/offers">
            Offers
          </Link>
          <Link className="text-sky-700 hover:underline" href="/hr/recruitment/jobs/new">
            New posting
          </Link>
        </div>
      </div>

      <section className="rounded border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Job postings</h2>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter((e.target.value as PostingStatus) || '')}
          >
            <option value="">All statuses</option>
            {(['DRAFT', 'LIVE', 'CLOSED', 'CANCELLED'] as PostingStatus[]).map((s) => (
              <option key={s} value={s}>
                {POSTING_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <table className="mt-3 min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Title</th>
              <th>Department</th>
              <th>Type</th>
              <th>Salary</th>
              <th>Status</th>
              <th>Applications</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(postings.data ?? []).map((p) => (
              <PostingRow
                key={p.id}
                posting={p}
                canWrite={canWrite}
                expanded={selectedPostingId === p.id}
                onToggle={() => setSelectedPostingId((cur) => (cur === p.id ? null : p.id))}
              />
            ))}
            {(postings.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} className="py-2 text-slate-500">
                  No postings found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {selectedPostingId ? <ApplicationsBoard postingId={selectedPostingId} /> : null}
    </div>
  );
}

function PostingRow({
  posting,
  canWrite,
  expanded,
  onToggle,
}: {
  posting: JobPostingDto;
  canWrite: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { toast } = useToast();
  const patch = usePatchJobPosting(posting.id);
  return (
    <tr className={`align-top ${expanded ? 'bg-sky-50' : ''}`}>
      <td className="py-2 font-medium">{posting.positionTitle}</td>
      <td>{posting.department ?? '—'}</td>
      <td>{employmentTypeLabel(posting.employmentType)}</td>
      <td>{formatCurrencyRange(posting.salaryRangeLow, posting.salaryRangeHigh)}</td>
      <td>
        <span className={`rounded px-2 py-0.5 text-xs ${POSTING_STATUS_PILL[posting.status]}`}>
          {POSTING_STATUS_LABEL[posting.status]}
        </span>
      </td>
      <td className="text-center">{posting.applicationCount}</td>
      <td className="space-x-2 text-right text-xs">
        <button className="text-sky-700 hover:underline" onClick={onToggle}>
          {expanded ? 'Hide' : 'View'} applicants
        </button>
        {canWrite && posting.status === 'DRAFT' ? (
          <button
            className="text-emerald-700 hover:underline"
            onClick={async () => {
              if (
                !window.confirm(
                  'Publish this posting? It will appear on the public job board and emit hr.job.posted.',
                )
              )
                return;
              try {
                await patch.mutateAsync({ status: 'LIVE' });
                toast('Posting published');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Publish
          </button>
        ) : null}
        {canWrite && posting.status === 'LIVE' ? (
          <button
            className="text-rose-700 hover:underline"
            onClick={async () => {
              if (
                !window.confirm(
                  'Close this posting? Applications stay visible but no new ones can be submitted.',
                )
              )
                return;
              try {
                await patch.mutateAsync({ status: 'CLOSED' });
                toast('Posting closed');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Close
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function ApplicationsBoard({ postingId }: { postingId: string }) {
  const apps = useApplicationsForPosting(postingId);
  const grouped = useMemo(() => {
    const m = new Map<ApplicationStatus, ApplicationDto[]>();
    for (const a of apps.data ?? []) {
      if (!m.has(a.status)) m.set(a.status, []);
      m.get(a.status)!.push(a);
    }
    return m;
  }, [apps.data]);
  const columns: ApplicationStatus[] = [
    'SUBMITTED',
    'UNDER_REVIEW',
    'INTERVIEW_SCHEDULED',
    'INTERVIEW_COMPLETED',
    'OFFER_EXTENDED',
    'OFFER_ACCEPTED',
    'NOT_SELECTED',
  ];
  return (
    <section className="rounded border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold">Applicants</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-3 lg:grid-cols-4">
        {columns.map((col) => {
          const items = grouped.get(col) ?? [];
          return (
            <div key={col} className="rounded bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase text-slate-600">
                  {APPLICATION_STATUS_LABEL[col]}
                </span>
                <span className="rounded bg-white px-1.5 text-xs">{items.length}</span>
              </div>
              <ul className="space-y-2">
                {items.map((a) => (
                  <li
                    key={a.id}
                    className={`rounded border border-slate-200 bg-white p-2 text-xs ${APPLICATION_STATUS_PILL[a.status]}`}
                  >
                    <div className="font-medium text-slate-800">
                      {a.applicantName ?? a.personId.slice(0, 8)}
                    </div>
                    {a.applicantEmail ? (
                      <div className="text-slate-500">{a.applicantEmail}</div>
                    ) : null}
                  </li>
                ))}
                {items.length === 0 ? <li className="text-xs text-slate-400">—</li> : null}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function employmentTypeLabel(t: EmploymentType): string {
  return t
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
