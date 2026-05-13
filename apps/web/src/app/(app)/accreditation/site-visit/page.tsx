'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAccSiteVisitReadiness,
  useAccSiteVisits,
  useCreateAccSiteVisit,
  useUpdateAccSiteVisit,
} from '@/hooks/use-accreditation';
import {
  ACC_SITE_VISIT_STATUS_LABEL,
  ACC_SITE_VISIT_STATUS_PILL,
  formatDateOnly,
  readinessToneBar,
  readinessToneText,
} from '@/lib/accreditation-format';
import type { AccSiteVisitPrepDto, AccSiteVisitStatus } from '@/lib/types';

export default function SiteVisitPrepPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const visitsQ = useAccSiteVisits();
  const [createOpen, setCreateOpen] = useState(false);
  const [opened, setOpened] = useState<AccSiteVisitPrepDto | null>(null);

  if (!showStaffSurfaces) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Site Visit Prep" />
        <EmptyState
          title="Not available"
          description="Site visit data is restricted to staff and administrators."
        />
      </div>
    );
  }

  const rows = visitsQ.data ?? [];
  const upcoming = rows.filter((v) => v.status !== 'VISIT_COMPLETE');
  const past = rows.filter((v) => v.status === 'VISIT_COMPLETE');

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Site Visit Prep"
        description="Track upcoming site visits, readiness scores, and the per-standard gap list."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/accreditation"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Dashboard
        </Link>
        <button
          type="button"
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
          onClick={() => setCreateOpen(true)}
        >
          Schedule visit
        </button>
      </div>

      {/* Upcoming visits */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-900">Upcoming</h2>
        {upcoming.length === 0 ? (
          <EmptyState
            title="No upcoming visits"
            description="Schedule a visit to start tracking readiness."
          />
        ) : (
          <ul className="space-y-3">
            {upcoming.map((v) => (
              <VisitCard key={v.id} visit={v} onOpen={() => setOpened(v)} />
            ))}
          </ul>
        )}
      </section>

      {/* Past visits */}
      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-gray-900">Past</h2>
          <ul className="space-y-3">
            {past.map((v) => (
              <VisitCard key={v.id} visit={v} onOpen={() => setOpened(v)} />
            ))}
          </ul>
        </section>
      )}

      <CreateVisitModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {opened && (
        <VisitDetailModal visit={opened} open={!!opened} onClose={() => setOpened(null)} />
      )}
    </div>
  );
}

function VisitCard({ visit, onOpen }: { visit: AccSiteVisitPrepDto; onOpen: () => void }) {
  return (
    <li className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-gray-900">
              {formatDateOnly(visit.visitDate)}
            </span>
            <span
              className={
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                ACC_SITE_VISIT_STATUS_PILL[visit.status]
              }
            >
              {ACC_SITE_VISIT_STATUS_LABEL[visit.status]}
            </span>
          </div>
          <div className="mt-1 text-sm text-gray-600">{visit.accreditorOrg}</div>
          {visit.leadContactName && (
            <div className="mt-0.5 text-xs text-gray-500">
              Lead: {visit.leadContactName}
              {visit.leadContactEmail ? ` (${visit.leadContactEmail})` : ''}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className={'text-2xl font-semibold ' + readinessToneText(visit.readinessScore)}>
            {visit.readinessScore === null ? '—' : `${visit.readinessScore}%`}
          </div>
          <div className="text-xs text-gray-500">Readiness</div>
        </div>
      </div>
      {visit.readinessScore !== null && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className={'h-full ' + readinessToneBar(visit.readinessScore)}
            style={{ width: `${visit.readinessScore}%` }}
          />
        </div>
      )}
      <div className="mt-3 text-right">
        <button
          type="button"
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
          onClick={onOpen}
        >
          Open details →
        </button>
      </div>
    </li>
  );
}

function CreateVisitModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateAccSiteVisit();
  const [visitDate, setVisitDate] = useState('');
  const [accreditorOrg, setAccreditorOrg] = useState('');
  const [leadContactName, setLeadContactName] = useState('');
  const [leadContactEmail, setLeadContactEmail] = useState('');
  const [notes, setNotes] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!visitDate || !accreditorOrg.trim()) {
      toast('Visit date and accreditor are required', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        visitDate,
        accreditorOrg: accreditorOrg.trim(),
        leadContactName: leadContactName.trim() || undefined,
        leadContactEmail: leadContactEmail.trim() || undefined,
        notes: notes || undefined,
      });
      toast('Site visit scheduled', 'success');
      setVisitDate('');
      setAccreditorOrg('');
      setLeadContactName('');
      setLeadContactEmail('');
      setNotes('');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule site visit"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="visit-form"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white"
            disabled={create.isPending}
          >
            Schedule
          </button>
        </div>
      }
    >
      <form id="visit-form" onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Visit date</span>
          <input
            type="date"
            value={visitDate}
            onChange={(e) => setVisitDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            required
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Accreditor organisation</span>
          <input
            type="text"
            value={accreditorOrg}
            onChange={(e) => setAccreditorOrg(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="AdvancED Southern Region"
            maxLength={200}
            required
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Lead contact</span>
            <input
              type="text"
              value={leadContactName}
              onChange={(e) => setLeadContactName(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              maxLength={200}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Lead email</span>
            <input
              type="email"
              value={leadContactEmail}
              onChange={(e) => setLeadContactEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              maxLength={200}
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={3}
            maxLength={4000}
          />
        </label>
      </form>
    </Modal>
  );
}

function VisitDetailModal({
  visit,
  open,
  onClose,
}: {
  visit: AccSiteVisitPrepDto;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const readinessQ = useAccSiteVisitReadiness(visit.id);
  const update = useUpdateAccSiteVisit();

  async function setStatus(status: AccSiteVisitStatus) {
    try {
      await update.mutateAsync({ id: visit.id, body: { status } });
      toast(`Status → ${ACC_SITE_VISIT_STATUS_LABEL[status]}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  const score = readinessQ.data?.readinessScore ?? visit.readinessScore;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Site visit — ${formatDateOnly(visit.visitDate)}`}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
              ACC_SITE_VISIT_STATUS_PILL[visit.status]
            }
          >
            {ACC_SITE_VISIT_STATUS_LABEL[visit.status]}
          </span>
          <div className="flex flex-wrap gap-2">
            {visit.status === 'PREPARING' && (
              <button
                type="button"
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white"
                onClick={() => setStatus('READY')}
              >
                Mark ready
              </button>
            )}
            {visit.status === 'READY' && (
              <button
                type="button"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                onClick={() => setStatus('PREPARING')}
              >
                Reopen prep
              </button>
            )}
            {visit.status !== 'VISIT_COMPLETE' && (
              <button
                type="button"
                className="rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white"
                onClick={() => setStatus('VISIT_COMPLETE')}
              >
                Visit complete
              </button>
            )}
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Accreditor
          </div>
          <div className="mt-1 text-gray-700">{visit.accreditorOrg}</div>
          {visit.leadContactName && (
            <div className="text-xs text-gray-500">
              {visit.leadContactName}
              {visit.leadContactEmail ? ` · ${visit.leadContactEmail}` : ''}
            </div>
          )}
        </div>

        {score !== null && (
          <div>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-gray-700">Readiness</span>
              <span className={'font-semibold ' + readinessToneText(score)}>{score}/100</span>
            </div>
            <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-gray-100">
              <div className={'h-full ' + readinessToneBar(score)} style={{ width: `${score}%` }} />
            </div>
          </div>
        )}

        {readinessQ.data && (
          <div>
            <div className="grid grid-cols-1 gap-1 text-xs text-gray-500 sm:grid-cols-3">
              <div>
                Standards rated:{' '}
                <span className="font-medium text-gray-700">
                  {readinessQ.data.standardsWithRating} of {readinessQ.data.totalAdoptedStandards}
                </span>
              </div>
              <div>
                Approved evidence:{' '}
                <span className="font-medium text-gray-700">
                  {readinessQ.data.standardsWithApprovedEvidence} of{' '}
                  {readinessQ.data.totalAdoptedStandards}
                </span>
              </div>
              <div>
                Ready:{' '}
                <span className="font-medium text-gray-700">
                  {readinessQ.data.standardsReady} of {readinessQ.data.totalAdoptedStandards}
                </span>
              </div>
            </div>
            {readinessQ.data.gaps.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  Gaps ({readinessQ.data.gaps.length})
                </div>
                <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200">
                  {readinessQ.data.gaps.slice(0, 30).map((g) => (
                    <li
                      key={g.standardId}
                      className="flex items-center justify-between p-2 text-xs"
                    >
                      <div>
                        <span className="font-mono">{g.standardCode}</span>
                        {g.domain && <span className="ml-2 text-gray-500">{g.domain}</span>}
                      </div>
                      <div className="flex gap-1">
                        <span
                          className={
                            'rounded-full px-2 py-0.5 ' +
                            (g.hasRating
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-rose-100 text-rose-700')
                          }
                        >
                          {g.hasRating ? 'rated' : 'no rating'}
                        </span>
                        <span
                          className={
                            'rounded-full px-2 py-0.5 ' +
                            (g.hasApprovedEvidence
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-rose-100 text-rose-700')
                          }
                        >
                          {g.hasApprovedEvidence ? 'evidence' : 'no evidence'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                {readinessQ.data.gaps.length > 30 && (
                  <div className="mt-1 text-xs text-gray-500">
                    + {readinessQ.data.gaps.length - 30} more
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {visit.notes && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-gray-700">{visit.notes}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
