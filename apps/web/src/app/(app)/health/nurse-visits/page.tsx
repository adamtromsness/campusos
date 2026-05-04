'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useCreateNurseVisit, useNurseVisits, useUpdateNurseVisit } from '@/hooks/use-health';
import { useStudentsForReport } from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  NURSE_VISIT_STATUS_LABELS,
  NURSE_VISIT_STATUS_PILL,
  formatDateTime,
} from '@/lib/health-format';
import type { NurseVisitDto, NurseVisitStatus } from '@/lib/types';

type FilterChip = 'TODAY' | 'IN_PROGRESS' | 'COMPLETED' | 'ALL';

const FILTER_CHIPS: Array<{ value: FilterChip; label: string }> = [
  { value: 'TODAY', label: 'Today' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'ALL', label: 'All' },
];

function todayStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function NurseVisitLogPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['hlt-003:read']);
  const canWrite = !!user && hasAnyPermission(user, ['hlt-003:write']);
  const [chip, setChip] = useState<FilterChip>('TODAY');
  const [signInOpen, setSignInOpen] = useState(false);

  const args = useMemo(() => {
    if (chip === 'TODAY') return { fromDate: todayStartIso(), limit: 100 };
    if (chip === 'IN_PROGRESS') return { status: 'IN_PROGRESS' as NurseVisitStatus, limit: 100 };
    if (chip === 'COMPLETED') return { status: 'COMPLETED' as NurseVisitStatus, limit: 100 };
    return { limit: 200 };
  }, [chip]);

  const visits = useNurseVisits(args, canRead);

  if (!canRead) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <PageHeader title="Nurse visit log" />
        <EmptyState
          title="Not available"
          description="Nurse visits are visible to nurses, counsellors, and admins only."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Nurse visit log"
        description="Today's signed-in roster, completed visits, and historical entries."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/health"
              className="text-sm font-medium text-campus-600 hover:text-campus-700"
            >
              ← Dashboard
            </Link>
            {canWrite ? (
              <button
                type="button"
                onClick={() => setSignInOpen(true)}
                className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
              >
                Sign someone in
              </button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap gap-2">
        {FILTER_CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setChip(c.value)}
            className={
              'rounded-full px-3 py-1 text-sm font-medium ' +
              (chip === c.value
                ? 'bg-campus-100 text-campus-800'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {visits.isLoading ? (
          <div className="p-6">
            <LoadingSpinner />
          </div>
        ) : (visits.data ?? []).length === 0 ? (
          <div className="p-6">
            <EmptyState title="No visits match the filter" />
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {(visits.data ?? []).map((v) => (
              <VisitRow key={v.id} visit={v} canWrite={canWrite} />
            ))}
          </ul>
        )}
      </div>

      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </div>
  );
}

function VisitRow({ visit, canWrite }: { visit: NurseVisitDto; canWrite: boolean }) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-gray-900">
              {visit.visitedPersonName ?? visit.visitedPersonId.slice(0, 8)}
            </p>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {visit.visitedPersonType === 'STUDENT' ? 'Student' : 'Staff'}
            </span>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' +
                NURSE_VISIT_STATUS_PILL[visit.status]
              }
            >
              {NURSE_VISIT_STATUS_LABELS[visit.status]}
            </span>
            {visit.sentHome ? (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
                Sent home
              </span>
            ) : null}
            {visit.parentNotified ? (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                Parent notified
              </span>
            ) : null}
          </div>
          {visit.reason ? <p className="mt-1 text-sm text-gray-700">{visit.reason}</p> : null}
          {visit.treatmentGiven ? (
            <p className="mt-1 text-sm text-gray-600">Treatment: {visit.treatmentGiven}</p>
          ) : null}
          <p className="mt-1 text-xs text-gray-500">
            {formatDateTime(visit.signedInAt)}
            {visit.signedOutAt ? ' → ' + formatDateTime(visit.signedOutAt) : ''}
            {visit.nurseName ? ' · nurse ' + visit.nurseName : ''}
          </p>
        </div>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {visit.status === 'IN_PROGRESS' ? 'Update / sign out' : 'Edit'}
          </button>
        ) : null}
      </div>
      <EditVisitModal open={editOpen} visit={visit} onClose={() => setEditOpen(false)} />
    </li>
  );
}

function SignInModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [studentId, setStudentId] = useState('');
  const [reason, setReason] = useState('');
  const students = useStudentsForReport(open);
  const create = useCreateNurseVisit();

  return (
    <Modal open={open} title="Sign someone in" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Student
          </label>
          <select
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Pick a student</option>
            {(students.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.firstName} {s.lastName} · Grade {s.gradeLevel}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            Staff visits land via direct API call for now (no UI search by employee yet).
          </p>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Reason
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Headache, scrape, asthma episode…"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!studentId || create.isPending}
            onClick={() => {
              create.mutate(
                { visitedPersonId: studentId, reason: reason || null },
                {
                  onSuccess: () => {
                    toast('Signed in', 'success');
                    onClose();
                  },
                  onError: (e) => toast((e as Error).message, 'error'),
                },
              );
            }}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
          >
            {create.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function EditVisitModal({
  open,
  visit,
  onClose,
}: {
  open: boolean;
  visit: NurseVisitDto;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateNurseVisit(visit.id);
  const [treatment, setTreatment] = useState(visit.treatmentGiven ?? '');
  const [parentNotified, setParentNotified] = useState(visit.parentNotified);
  const [sentHome, setSentHome] = useState(visit.sentHome);
  const [followUp, setFollowUp] = useState(visit.followUpRequired);
  const [followUpNotes, setFollowUpNotes] = useState(visit.followUpNotes ?? '');

  return (
    <Modal open={open} title="Update visit" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Treatment given
          </label>
          <textarea
            value={treatment}
            onChange={(e) => setTreatment(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={parentNotified}
            onChange={(e) => setParentNotified(e.target.checked)}
          />
          Parent notified
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sentHome}
            onChange={(e) => setSentHome(e.target.checked)}
          />
          Sent home
          <span className="text-xs text-gray-500">
            Emits hlth.nurse_visit.sent_home on first true.
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={followUp}
            onChange={(e) => setFollowUp(e.target.checked)}
          />
          Follow-up required
        </label>
        {followUp ? (
          <textarea
            value={followUpNotes}
            onChange={(e) => setFollowUpNotes(e.target.value)}
            rows={2}
            placeholder="Follow-up notes"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              update.mutate(
                {
                  treatmentGiven: treatment || null,
                  parentNotified,
                  sentHome,
                  followUpRequired: followUp,
                  followUpNotes: followUp ? followUpNotes || null : null,
                },
                {
                  onSuccess: () => {
                    toast('Updated', 'success');
                    onClose();
                  },
                  onError: (e) => toast((e as Error).message, 'error'),
                },
              );
            }}
            disabled={update.isPending}
            className="rounded-md bg-gray-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-60"
          >
            Save
          </button>
          {visit.status === 'IN_PROGRESS' ? (
            <button
              type="button"
              onClick={() => {
                update.mutate(
                  {
                    treatmentGiven: treatment || null,
                    parentNotified,
                    sentHome,
                    followUpRequired: followUp,
                    followUpNotes: followUp ? followUpNotes || null : null,
                    signOut: true,
                  },
                  {
                    onSuccess: () => {
                      toast('Signed out', 'success');
                      onClose();
                    },
                    onError: (e) => toast((e as Error).message, 'error'),
                  },
                );
              }}
              disabled={update.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              Save + sign out
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
