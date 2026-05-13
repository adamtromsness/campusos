'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useClassSets, useCreateClassSet, useReturnClassSetCopies } from '@/hooks/use-library';
import { useEmployees } from '@/hooks/use-hr';
import {
  CLASS_SET_STATUS_LABELS,
  CLASS_SET_STATUS_PILL,
  classSetProgress,
  formatDate,
} from '@/lib/library-format';
import type {
  ClassSetCheckoutDto,
  ClassSetStatus,
  CreateClassSetCheckoutPayload,
} from '@/lib/types';

/**
 * /library/class-sets — Librarian class set checkout manager.
 *
 * Bulk-checkout flow: pick a catalogue item, a teacher, and a copy
 * count; the backend INSERT chain reserves N copies, INSERTs N
 * individual lib_checkouts, and links them via class_set_checkout_id.
 * Return form decrements the count and walks the state machine
 * (PARTIALLY_RETURNED → RETURNED on the final copy).
 */
export default function ClassSetsPage() {
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-002:write']);

  const [statusFilter, setStatusFilter] = useState<ClassSetStatus | 'ALL'>('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<ClassSetCheckoutDto | null>(null);

  const setsQ = useClassSets(statusFilter === 'ALL' ? {} : { status: statusFilter });

  if (!user) return null;
  if (!isLibrarian) {
    return (
      <EmptyState
        title="Librarian access required"
        description="Class set checkouts are managed by librarians and school admins."
      />
    );
  }

  const sets = setsQ.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Class sets"
        description="Bulk checkouts for novels and book sets used by whole classes."
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(['ALL', 'ACTIVE', 'PARTIALLY_RETURNED', 'OVERDUE', 'RETURNED'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={
                'rounded-full px-3 py-1 text-xs font-medium ' +
                (statusFilter === s
                  ? 'bg-campus-600 text-white'
                  : 'border border-gray-200 bg-white text-gray-700 hover:border-campus-300')
              }
            >
              {s === 'ALL' ? 'All' : CLASS_SET_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
        >
          + Check out class set
        </button>
      </div>

      {setsQ.isLoading ? (
        <LoadingSpinner />
      ) : sets.length === 0 ? (
        <EmptyState
          title="No class sets"
          description="Bulk-check-out a title for a whole class to track returns as a group."
        />
      ) : (
        <div className="grid gap-3">
          {sets.map((s) => (
            <ClassSetCard key={s.id} set={s} onReturn={() => setReturnTarget(s)} />
          ))}
        </div>
      )}

      <CreateClassSetModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <ReturnCopiesModal set={returnTarget} onClose={() => setReturnTarget(null)} />
    </div>
  );
}

function ClassSetCard({ set, onReturn }: { set: ClassSetCheckoutDto; onReturn: () => void }) {
  const progress = classSetProgress(set.returnedCount, set.copyCount);
  const outstanding = set.copyCount - set.returnedCount;
  const isLive =
    set.status === 'ACTIVE' || set.status === 'PARTIALLY_RETURNED' || set.status === 'OVERDUE';
  const overdue = set.status === 'OVERDUE';

  return (
    <div
      className={
        'rounded-lg border p-4 ' +
        (overdue ? 'border-rose-300 bg-rose-50' : 'border-gray-200 bg-white')
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-gray-900">
            {set.catalogueItemTitle ?? '—'}
            {set.catalogueItemAuthor ? (
              <span className="ml-2 text-sm font-normal text-gray-600">
                by {set.catalogueItemAuthor}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-sm text-gray-700">
            Teacher: <span className="font-medium">{set.teacherName ?? '—'}</span>
            <span className="ml-3">{set.copyCount} copies</span>
            <span className="ml-3">Due {formatDate(set.dueDate)}</span>
          </div>
          {set.notes ? (
            <div className="mt-2 max-w-xl text-sm text-gray-600">{set.notes}</div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className={
              'rounded-full px-2 py-0.5 text-xs font-medium ' + CLASS_SET_STATUS_PILL[set.status]
            }
          >
            {CLASS_SET_STATUS_LABELS[set.status]}
          </span>
          {isLive && (
            <button
              type="button"
              onClick={onReturn}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Return copies
            </button>
          )}
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-gray-600">
          <span>
            {set.returnedCount} of {set.copyCount} returned
            {isLive ? ` · ${outstanding} outstanding` : ''}
          </span>
          <span className="font-medium">{progress}%</span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className={
              'h-full ' +
              (set.status === 'RETURNED'
                ? 'bg-emerald-500'
                : set.status === 'OVERDUE'
                  ? 'bg-rose-500'
                  : 'bg-sky-500')
            }
            style={{ width: progress + '%' }}
          />
        </div>
      </div>
    </div>
  );
}

function CreateClassSetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateClassSet();
  const employeesQ = useEmployees({}, true);

  const today = new Date().toISOString().slice(0, 10);
  const defaultDue = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [catalogueItemId, setCatalogueItemId] = useState('');
  const [teacherPatronId, setTeacherPatronId] = useState('');
  const [copyCount, setCopyCount] = useState(25);
  const [checkoutDate, setCheckoutDate] = useState(today);
  const [dueDate, setDueDate] = useState(defaultDue);
  const [notes, setNotes] = useState('');

  const teachers = useMemo(
    () => (employeesQ.data ?? []).filter((e) => e.employmentStatus === 'ACTIVE'),
    [employeesQ.data],
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!catalogueItemId.trim()) {
      toast('Provide the catalogue item id', 'error');
      return;
    }
    if (!teacherPatronId) {
      toast('Pick a teacher', 'error');
      return;
    }
    if (copyCount < 1) {
      toast('Copy count must be at least 1', 'error');
      return;
    }
    const teacher = teachers.find((t) => t.id === teacherPatronId);
    if (!teacher) {
      toast('Teacher not found', 'error');
      return;
    }
    const body: CreateClassSetCheckoutPayload = {
      catalogueItemId: catalogueItemId.trim(),
      teacherPatronId: teacher.personId,
      copyCount,
      checkoutDate,
      dueDate,
      notes: notes.trim() || undefined,
    };
    create.mutate(body, {
      onSuccess: () => {
        toast('Class set checked out', 'success');
        onClose();
      },
      onError: (err) => toast((err as Error).message, 'error'),
    });
  }

  return (
    <Modal open={open} title="Check out a class set" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Catalogue item id">
          <input
            value={catalogueItemId}
            onChange={(e) => setCatalogueItemId(e.target.value)}
            placeholder="UUID — paste from /library/catalogue"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Teacher">
          <select
            value={teacherPatronId}
            onChange={(e) => setTeacherPatronId(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="">— pick a teacher —</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
                {t.primaryPositionTitle ? ' (' + t.primaryPositionTitle + ')' : ''}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Copies">
            <input
              type="number"
              min={1}
              value={copyCount}
              onChange={(e) => setCopyCount(Number(e.target.value))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
          <Field label="Checkout date">
            <input
              type="date"
              value={checkoutDate}
              onChange={(e) => setCheckoutDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
          <Field label="Due date">
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Check out
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReturnCopiesModal({
  set,
  onClose,
}: {
  set: ClassSetCheckoutDto | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const setId = set?.id ?? '';
  const returnCopies = useReturnClassSetCopies(setId);
  const outstanding = set ? set.copyCount - set.returnedCount : 0;
  const [count, setCount] = useState(outstanding);

  // Sync count to outstanding when the target class set changes.
  useEffect(() => {
    if (set) setCount(set.copyCount - set.returnedCount);
  }, [set]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!set) return;
    if (count < 1) {
      toast('Return at least 1 copy', 'error');
      return;
    }
    if (count > outstanding) {
      toast('Cannot return more than ' + outstanding + ' outstanding copies', 'error');
      return;
    }
    returnCopies.mutate(
      { copiesReturned: count },
      {
        onSuccess: () => {
          toast('Returned ' + count + ' copies', 'success');
          onClose();
        },
        onError: (err) => toast((err as Error).message, 'error'),
      },
    );
  }

  return (
    <Modal
      open={!!set}
      title={'Return copies — ' + (set?.catalogueItemTitle ?? 'class set')}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-700">
          {set?.returnedCount ?? 0} of {set?.copyCount ?? 0} already returned · {outstanding} still
          out
        </div>
        <Field label="Number of copies returned now">
          <input
            type="number"
            min={1}
            max={outstanding}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={returnCopies.isPending}
            className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Mark returned
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600">
        {label}
      </span>
      {children}
    </label>
  );
}
