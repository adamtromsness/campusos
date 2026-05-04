'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useAddAction,
  useDisciplineActionTypes,
  useDisciplineIncident,
  useRemoveAction,
  useReopenIncident,
  useResolveIncident,
  useReviewIncident,
  useUpdateAction,
} from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_STATUS_PILL,
  SEVERITY_LABELS,
  SEVERITY_PILL,
  formatIncidentDate,
  formatIncidentDateTime,
  studentName,
} from '@/lib/discipline-format';
import type { DisciplineActionDto, DisciplineActionTypeDto } from '@/lib/types';

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['beh-001:read']);
  const isAdmin = !!user && hasAnyPermission(user, ['beh-001:admin', 'sch-001:admin']);
  const { toast } = useToast();

  const incident = useDisciplineIncident(id, canRead);
  const actionTypes = useDisciplineActionTypes(canRead && isAdmin);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveNotes, setResolveNotes] = useState('');
  const [addActionOpen, setAddActionOpen] = useState(false);

  const review = useReviewIncident(id);
  const resolve = useResolveIncident(id);
  const reopen = useReopenIncident(id);
  const addAction = useAddAction(id);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Incident" />
        <EmptyState
          title="Access required"
          description="You need behaviour-read access to view this incident."
        />
      </div>
    );
  }

  if (incident.isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Incident" />
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      </div>
    );
  }

  if (incident.isError || !incident.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Incident" />
        <EmptyState
          title="Not found"
          description="This incident does not exist or is not visible to you."
        />
        <div className="mt-4">
          <Link href="/behaviour" className="text-sm text-campus-700 hover:underline">
            ← Back to queue
          </Link>
        </div>
      </div>
    );
  }

  const inc = incident.data;
  const showAdminNotes = isAdmin && !!inc.adminNotes;

  async function handleReview(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await review.mutateAsync({ adminNotes: reviewNotes.trim() || undefined });
      toast('Incident moved to Under review', 'success');
      setReviewOpen(false);
      setReviewNotes('');
    } catch (err: any) {
      toast('Could not transition: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  async function handleResolve(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await resolve.mutateAsync({ adminNotes: resolveNotes.trim() || undefined });
      toast('Incident resolved', 'success');
      setResolveOpen(false);
      setResolveNotes('');
    } catch (err: any) {
      toast('Could not resolve: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  async function handleReopen() {
    if (!confirm('Reopen this incident? Resolution timestamps will be cleared.')) return;
    try {
      await reopen.mutateAsync();
      toast('Incident reopened', 'success');
    } catch (err: any) {
      toast('Could not reopen: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={'Incident · ' + studentName(inc)}
        description={inc.categoryName}
        actions={
          <div className="flex items-center gap-3">
            <Link
              href={'/students/' + inc.studentId + '/behaviour'}
              className="text-sm text-campus-700 hover:underline"
            >
              View student summary →
            </Link>
            <Link href="/behaviour" className="text-sm text-gray-500 hover:text-gray-700">
              ← Queue
            </Link>
          </div>
        }
      />

      <div className="space-y-4">
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                SEVERITY_PILL[inc.severity],
              )}
            >
              {SEVERITY_LABELS[inc.severity]}
            </span>
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                INCIDENT_STATUS_PILL[inc.status],
              )}
            >
              {INCIDENT_STATUS_LABELS[inc.status]}
            </span>
            {inc.studentGradeLevel && (
              <span className="text-xs text-gray-500">Grade {inc.studentGradeLevel}</span>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
            <Field
              label="Date"
              value={formatIncidentDateTime(inc.incidentDate, inc.incidentTime)}
            />
            <Field label="Location" value={inc.location ?? '—'} />
            <Field label="Reported by" value={inc.reportedByName ?? '—'} />
          </dl>

          {inc.witnesses && (
            <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
              <span className="font-semibold">Witnesses:</span> {inc.witnesses}
            </div>
          )}

          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Description</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{inc.description}</p>
          </div>

          {inc.status === 'RESOLVED' && (inc.resolvedByName || inc.resolvedAt) && (
            <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
              Resolved
              {inc.resolvedByName ? ' by ' + inc.resolvedByName : ''}
              {inc.resolvedAt ? ' on ' + new Date(inc.resolvedAt).toLocaleString() : ''}.
            </div>
          )}

          {isAdmin && (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
              {inc.status === 'OPEN' && (
                <>
                  <button
                    type="button"
                    onClick={() => setReviewOpen(true)}
                    className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
                  >
                    Mark under review
                  </button>
                  <button
                    type="button"
                    onClick={() => setResolveOpen(true)}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                  >
                    Resolve
                  </button>
                </>
              )}
              {inc.status === 'UNDER_REVIEW' && (
                <button
                  type="button"
                  onClick={() => setResolveOpen(true)}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Resolve
                </button>
              )}
              {inc.status === 'RESOLVED' && (
                <button
                  type="button"
                  onClick={handleReopen}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Reopen
                </button>
              )}
            </div>
          )}
        </div>

        {showAdminNotes && (
          <div className="rounded-lg border border-gray-200 bg-amber-50/50 p-5 ring-1 ring-amber-100">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-900">
              Admin notes{' '}
              <span className="font-normal text-amber-700">
                (internal — not visible to parents)
              </span>
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-gray-800">{inc.adminNotes}</p>
          </div>
        )}

        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-gray-900">
              Actions{' '}
              <span className="text-xs font-normal text-gray-500">({inc.actions.length})</span>
            </h3>
            {isAdmin && inc.status !== 'RESOLVED' && (
              <button
                type="button"
                onClick={() => setAddActionOpen(true)}
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
              >
                Add action
              </button>
            )}
          </div>

          {inc.actions.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No actions assigned yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {inc.actions.map((action) => (
                <ActionRow
                  key={action.id}
                  action={action}
                  canManage={isAdmin && inc.status !== 'RESOLVED'}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <Modal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Mark under review"
        footer={
          <>
            <button
              type="button"
              onClick={() => setReviewOpen(false)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="review-form"
              disabled={review.isPending}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:bg-gray-300"
            >
              {review.isPending ? 'Saving…' : 'Mark under review'}
            </button>
          </>
        }
      >
        <form id="review-form" onSubmit={handleReview} className="space-y-3">
          <p className="text-sm text-gray-600">
            Optionally append an internal note describing your initial review.
          </p>
          <textarea
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Internal admin note (parents do not see this)…"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </form>
      </Modal>

      <Modal
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title="Resolve incident"
        footer={
          <>
            <button
              type="button"
              onClick={() => setResolveOpen(false)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="resolve-form"
              disabled={resolve.isPending}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-gray-300"
            >
              {resolve.isPending ? 'Saving…' : 'Resolve'}
            </button>
          </>
        }
      >
        <form id="resolve-form" onSubmit={handleResolve} className="space-y-3">
          <p className="text-sm text-gray-600">
            The reporter will receive a notification. Optionally append an internal admin note
            describing the resolution.
          </p>
          <textarea
            value={resolveNotes}
            onChange={(e) => setResolveNotes(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Internal admin note (parents do not see this)…"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </form>
      </Modal>

      {addActionOpen && (
        <AddActionModal
          actionTypes={actionTypes.data ?? []}
          loading={actionTypes.isLoading}
          submitting={addAction.isPending}
          onClose={() => setAddActionOpen(false)}
          onSubmit={async (payload) => {
            try {
              await addAction.mutateAsync(payload);
              toast('Action added', 'success');
              setAddActionOpen(false);
            } catch (err: any) {
              toast('Could not add action: ' + (err?.message ?? 'unknown error'), 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value}</dd>
    </div>
  );
}

function ActionRow({ action, canManage }: { action: DisciplineActionDto; canManage: boolean }) {
  const update = useUpdateAction(action.id);
  const remove = useRemoveAction();
  const { toast } = useToast();

  const dateRange = useMemo(() => {
    if (!action.startDate && !action.endDate) return null;
    if (action.startDate && action.endDate && action.startDate !== action.endDate) {
      return formatIncidentDate(action.startDate) + ' – ' + formatIncidentDate(action.endDate);
    }
    return formatIncidentDate(action.startDate ?? action.endDate ?? '');
  }, [action.startDate, action.endDate]);

  async function markNotified() {
    try {
      await update.mutateAsync({ parentNotified: true });
      toast('Marked as parent-notified', 'success');
    } catch (err: any) {
      toast('Could not update action: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  async function handleRemove() {
    if (!confirm('Remove this action?')) return;
    try {
      await remove.mutateAsync(action.id);
      toast('Action removed', 'success');
    } catch (err: any) {
      toast('Could not remove action: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <li className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{action.actionTypeName}</span>
        {action.requiresParentNotification && (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              action.parentNotified
                ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
            )}
          >
            {action.parentNotified ? 'Parent notified' : 'Parent notification pending'}
          </span>
        )}
        {dateRange && <span className="text-xs text-gray-500">{dateRange}</span>}
      </div>
      {action.notes && <p className="mt-1 text-sm text-gray-700">{action.notes}</p>}
      <p className="mt-1 text-xs text-gray-400">
        {action.assignedByName ? 'Assigned by ' + action.assignedByName : ''}
        {action.parentNotifiedAt
          ? ' · Notified ' + new Date(action.parentNotifiedAt).toLocaleString()
          : ''}
      </p>
      {canManage && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {action.requiresParentNotification && !action.parentNotified && (
            <button
              type="button"
              onClick={markNotified}
              disabled={update.isPending}
              className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:bg-gray-100"
            >
              Mark parent notified
            </button>
          )}
          <button
            type="button"
            onClick={handleRemove}
            disabled={remove.isPending}
            className="rounded border border-rose-300 bg-white px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:bg-gray-100"
          >
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

function AddActionModal({
  actionTypes,
  loading,
  submitting,
  onClose,
  onSubmit,
}: {
  actionTypes: DisciplineActionTypeDto[];
  loading: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    actionTypeId: string;
    startDate?: string;
    endDate?: string;
    notes?: string | null;
  }) => Promise<void>;
}) {
  const [actionTypeId, setActionTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [notes, setNotes] = useState('');
  const { toast } = useToast();

  const activeTypes = actionTypes.filter((t) => t.isActive);
  const selected = activeTypes.find((t) => t.id === actionTypeId);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!actionTypeId) {
      toast('Pick an action type', 'error');
      return;
    }
    if (startDate && endDate && endDate < startDate) {
      toast('End date must be on or after start date', 'error');
      return;
    }
    await onSubmit({
      actionTypeId,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add disciplinary action"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="add-action-form"
            disabled={submitting}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {submitting ? 'Saving…' : 'Add action'}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading action types…
        </div>
      ) : (
        <form id="add-action-form" onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Action type</label>
            <select
              value={actionTypeId}
              onChange={(e) => setActionTypeId(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              <option value="">— pick an action type —</option>
              {activeTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.requiresParentNotification ? ' · Notifies parent' : ''}
                </option>
              ))}
            </select>
            {selected?.requiresParentNotification && (
              <p className="mt-1 text-xs text-amber-700">
                This action will fan out an IN_APP notification to portal-enabled guardians once
                saved.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900">
                Start date <span className="text-gray-400">(optional)</span>
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900">
                End date <span className="text-gray-400">(optional)</span>
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">
              Notes <span className="text-gray-400">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Additional context for the consequence."
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>
        </form>
      )}
    </Modal>
  );
}
