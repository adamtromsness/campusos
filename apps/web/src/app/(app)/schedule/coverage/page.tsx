'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useEmployees } from '@/hooks/use-hr';
import {
  useAssignCoverage,
  useCancelCoverage,
  useCoverageRequests,
  useRooms,
} from '@/hooks/use-scheduling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { coverageStatusLabel, coverageStatusPillClasses, todayIso } from '@/lib/scheduling-format';
import type { CoverageRequestDto } from '@/lib/types';

export default function CoverageBoardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-004:admin', 'sch-001:admin']);

  const [date, setDate] = useState<string>(todayIso());
  const requests = useCoverageRequests({ fromDate: date, toDate: date }, !!user);

  const [assignTarget, setAssignTarget] = useState<CoverageRequestDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CoverageRequestDto | null>(null);

  if (!user) return null;

  const list = requests.data ?? [];
  const open = list.filter((r) => r.status === 'OPEN');
  const assigned = list.filter((r) => r.status === 'ASSIGNED' || r.status === 'COVERED');
  const cancelled = list.filter((r) => r.status === 'CANCELLED');

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Coverage Board"
        description="Substitute assignments for the day. Open rows need an immediate assignment."
        actions={
          <Link
            href="/schedule/coverage/history"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            History
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <label className="text-sm">
          <span className="mr-2 text-gray-700">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => setDate(todayIso())}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100"
        >
          Today
        </button>
        <span className="ml-auto text-xs text-gray-500">
          {open.length} open · {assigned.length} assigned · {cancelled.length} cancelled
        </span>
      </div>

      {requests.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No coverage needed"
          description="Nothing to cover on this date."
        />
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <CoverageSection
              title="Open"
              tone="bg-red-50 border-red-200"
              items={open}
              isAdmin={isAdmin}
              onAssign={setAssignTarget}
              onCancel={setCancelTarget}
            />
          )}
          {assigned.length > 0 && (
            <CoverageSection
              title="Assigned"
              tone="bg-amber-50 border-amber-200"
              items={assigned}
              isAdmin={isAdmin}
              onAssign={setAssignTarget}
              onCancel={setCancelTarget}
            />
          )}
          {cancelled.length > 0 && (
            <CoverageSection
              title="Cancelled"
              tone="bg-gray-50 border-gray-200"
              items={cancelled}
              isAdmin={false}
              onAssign={setAssignTarget}
              onCancel={setCancelTarget}
            />
          )}
        </div>
      )}

      <AssignCoverageModal
        target={assignTarget}
        onClose={() => setAssignTarget(null)}
      />
      <CancelCoverageModal
        target={cancelTarget}
        onClose={() => setCancelTarget(null)}
      />
    </div>
  );
}

function CoverageSection({
  title,
  tone,
  items,
  isAdmin,
  onAssign,
  onCancel,
}: {
  title: string;
  tone: string;
  items: CoverageRequestDto[];
  isAdmin: boolean;
  onAssign: (item: CoverageRequestDto) => void;
  onCancel: (item: CoverageRequestDto) => void;
}) {
  return (
    <section className={cn('rounded-xl border p-4 shadow-sm', tone)}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      <ul className="divide-y divide-gray-100 rounded-lg bg-white">
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-gray-900">
                {r.periodName} · {r.classSectionCode} · {r.courseName}
              </p>
              <p className="text-xs text-gray-500">
                Absent: {r.absentTeacherName} · Room {r.roomName}
                {r.assignedSubstituteName && ` · Sub: ${r.assignedSubstituteName}`}
              </p>
              {r.notes && <p className="mt-1 text-xs italic text-gray-500">{r.notes}</p>}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                  coverageStatusPillClasses(r.status),
                )}
              >
                {coverageStatusLabel(r.status)}
              </span>
              {isAdmin && r.status === 'OPEN' && (
                <button
                  type="button"
                  onClick={() => onAssign(r)}
                  className="rounded-lg bg-campus-700 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-campus-600"
                >
                  Assign
                </button>
              )}
              {isAdmin && r.status === 'ASSIGNED' && (
                <>
                  <button
                    type="button"
                    onClick={() => onAssign(r)}
                    className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                  >
                    Reassign
                  </button>
                  <button
                    type="button"
                    onClick={() => onCancel(r)}
                    className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssignCoverageModal({
  target,
  onClose,
}: {
  target: CoverageRequestDto | null;
  onClose: () => void;
}) {
  const employees = useEmployees({}, !!target);
  const rooms = useRooms({}, !!target);
  const assign = useAssignCoverage(target?.id ?? '');
  const { toast } = useToast();

  const [substituteId, setSubstituteId] = useState<string>('');
  const [roomId, setRoomId] = useState<string>('');
  const [notes, setNotes] = useState('');

  const eligible = useMemo(() => {
    const all = employees.data ?? [];
    if (!target) return all;
    return all.filter(
      (e) => e.id !== target.absentTeacherId && e.employmentStatus === 'ACTIVE',
    );
  }, [employees.data, target]);

  if (!target) return null;

  async function submit() {
    if (!substituteId) {
      toast('Pick a substitute', 'error');
      return;
    }
    try {
      await assign.mutateAsync({
        substituteId,
        ...(roomId ? { roomId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast('Substitute assigned', 'success');
      setSubstituteId('');
      setRoomId('');
      setNotes('');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not assign substitute', 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={target.status === 'OPEN' ? 'Assign substitute' : 'Reassign substitute'}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={assign.isPending || !substituteId}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {assign.isPending ? 'Assigning…' : 'Assign'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-gray-50 px-3 py-2 text-gray-700">
          <p className="font-medium">
            {target.periodName} · {target.classSectionCode} · {target.courseName}
          </p>
          <p className="text-xs text-gray-500">
            {target.coverageDate} · {target.absentTeacherName} absent · Room {target.roomName}
          </p>
        </div>
        <label className="block">
          <span className="font-medium text-gray-700">Substitute</span>
          <select
            value={substituteId}
            onChange={(e) => setSubstituteId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="">— select —</option>
            {eligible.map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName}
                {e.primaryPositionTitle ? ` (${e.primaryPositionTitle})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-medium text-gray-700">Room (optional override)</span>
          <select
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="">Default — {target.roomName}</option>
            {(rooms.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-medium text-gray-700">Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Anything the substitute needs to know"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
      </div>
    </Modal>
  );
}

function CancelCoverageModal({
  target,
  onClose,
}: {
  target: CoverageRequestDto | null;
  onClose: () => void;
}) {
  const cancel = useCancelCoverage(target?.id ?? '');
  const { toast } = useToast();
  const [notes, setNotes] = useState('');

  if (!target) return null;

  async function submit() {
    try {
      await cancel.mutateAsync(notes.trim() ? { notes: notes.trim() } : {});
      toast('Coverage cancelled', 'success');
      setNotes('');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not cancel coverage', 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Cancel coverage"
      size="md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Back
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={cancel.isPending}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel coverage'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-gray-700">
        Cancel coverage for {target.periodName} · {target.classSectionCode} on {target.coverageDate}?
        Any matching substitution row will be dropped — the substitute will no longer see this period
        on their day-view.
      </p>
      <label className="block text-sm">
        <span className="font-medium text-gray-700">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </label>
    </Modal>
  );
}
