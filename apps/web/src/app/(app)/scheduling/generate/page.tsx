'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useActivateCandidate,
  useApproveCandidate,
  useCandidateSlots,
  useRejectCandidate,
  useResolveClash,
  useSchedulingConstraints,
  useSchedulingRequest,
  useSchedulingRequests,
  useSubmitSchedulingRequest,
  type CandidateSlotDto,
  type SchedulingCandidateDto,
  type SolverAlgorithm,
} from '@/hooks/use-scheduling-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

function suggestedAlgorithm(sectionCount: number | undefined): SolverAlgorithm | null {
  if (sectionCount === undefined) return null;
  return sectionCount <= 300 ? 'CP_SAT' : 'HEURISTIC';
}

function statusPill(status: string): { label: string; class: string } {
  const map: Record<string, { label: string; class: string }> = {
    QUEUED: { label: 'Queued', class: 'bg-gray-100 text-gray-700' },
    RUNNING: { label: 'Running', class: 'bg-sky-100 text-sky-700' },
    COMPLETED: { label: 'Completed', class: 'bg-emerald-100 text-emerald-700' },
    FAILED: { label: 'Failed', class: 'bg-rose-100 text-rose-700' },
    CANCELLED: { label: 'Cancelled', class: 'bg-gray-100 text-gray-500' },
    PENDING: { label: 'Pending', class: 'bg-amber-100 text-amber-700' },
    APPROVED: { label: 'Approved', class: 'bg-emerald-100 text-emerald-700' },
    REJECTED: { label: 'Rejected', class: 'bg-rose-100 text-rose-700' },
    MODIFIED: { label: 'Modified', class: 'bg-violet-100 text-violet-700' },
  };
  return map[status] ?? { label: status, class: 'bg-gray-100 text-gray-700' };
}

export default function ScheduleGenerationPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const { toast } = useToast();

  const constraints = useSchedulingConstraints(!!user);
  const requests = useSchedulingRequests(undefined, !!user);

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const request = useSchedulingRequest(selectedRequestId, !!user);

  const [showCreate, setShowCreate] = useState(false);
  const [constraintId, setConstraintId] = useState<string>('');
  const [sectionCount, setSectionCount] = useState<number | undefined>(undefined);
  const [algorithm, setAlgorithm] = useState<SolverAlgorithm | ''>('');

  const submit = useSubmitSchedulingRequest();

  const suggested = useMemo(() => suggestedAlgorithm(sectionCount), [sectionCount]);

  if (!user) return null;

  async function onSubmit() {
    if (!constraintId) return;
    try {
      const result = await submit.mutateAsync({
        constraintId,
        sectionCount,
        solverAlgorithm: algorithm === '' ? undefined : algorithm,
      });
      toast(`Request ${result.id.slice(0, 8)} submitted — ${result.solverAlgorithm}`, 'success');
      setShowCreate(false);
      setSelectedRequestId(result.id);
      setConstraintId('');
      setSectionCount(undefined);
      setAlgorithm('');
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Submit failed', 'error');
    }
  }

  const requestsList = requests.data ?? [];
  const constraintsList = constraints.data ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Schedule Generation"
        description="Queue solver runs, review candidates side-by-side with clash highlighting, approve and activate."
      />

      <div className="mb-6 flex items-center gap-3">
        {isAdmin && (
          <button
            onClick={() => setShowCreate(true)}
            disabled={constraintsList.length === 0}
            className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            New generation
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <aside className="lg:col-span-1">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-600">
            Requests
          </h3>
          {requests.isLoading ? (
            <LoadingSpinner />
          ) : requestsList.length === 0 ? (
            <EmptyState title="No requests yet" description="Queue a generation to begin." />
          ) : (
            <ul className="space-y-2">
              {requestsList.map((r) => {
                const pill = statusPill(r.status);
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => setSelectedRequestId(r.id)}
                      className={`w-full rounded-lg border p-3 text-left text-sm hover:bg-gray-50 ${
                        selectedRequestId === r.id
                          ? 'border-campus-500 bg-campus-50'
                          : 'border-gray-200'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{r.id.slice(0, 8)}</span>
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${pill.class}`}>
                          {pill.label}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {r.solverAlgorithm} • {r.sectionCountAtSubmission} sections •{' '}
                        {new Date(r.queuedAt).toLocaleString()}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main className="lg:col-span-2">
          {selectedRequestId === null ? (
            <EmptyState
              title="Select a request"
              description="Pick a generation request from the left to review candidates."
            />
          ) : request.isLoading ? (
            <LoadingSpinner />
          ) : !request.data ? (
            <EmptyState title="Not found" description="Request could not be loaded." />
          ) : (
            <>
              <h3 className="mb-2 text-base font-semibold text-gray-900">
                Request {request.data.id.slice(0, 8)} candidates
              </h3>
              <div className="mb-4 text-xs text-gray-500">
                {request.data.solverAlgorithm} solver • {request.data.sectionCountAtSubmission}{' '}
                sections • {request.data.candidatesGenerated ?? 0} candidates
              </div>
              {(request.data.candidates ?? []).length === 0 ? (
                <EmptyState
                  title="No candidates yet"
                  description="Solver hasn't produced candidates for this request."
                />
              ) : (
                <div className="space-y-4">
                  {(request.data.candidates ?? []).map((c) => (
                    <CandidateCard key={c.id} candidate={c} isAdmin={isAdmin} />
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Queue a generation">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Constraint profile
            </label>
            <select
              value={constraintId}
              onChange={(e) => setConstraintId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {constraintsList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Section count (optional override)
            </label>
            <input
              type="number"
              min={0}
              value={sectionCount ?? ''}
              onChange={(e) =>
                setSectionCount(e.target.value === '' ? undefined : Number(e.target.value))
              }
              placeholder="Auto-count from sis_classes if blank"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            {suggested && (
              <p className="mt-1 text-xs text-gray-500">
                ADR-060 suggests <span className="font-mono">{suggested}</span> at this section
                count.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Solver algorithm</label>
            <select
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value as SolverAlgorithm | '')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Auto (ADR-060)</option>
              <option value="CP_SAT">CP_SAT (≤300 sections)</option>
              <option value="HEURISTIC">HEURISTIC</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={!constraintId || submit.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {submit.isPending ? 'Queuing…' : 'Queue'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function CandidateCard({
  candidate,
  isAdmin,
}: {
  candidate: SchedulingCandidateDto;
  isAdmin: boolean;
}) {
  const { toast } = useToast();
  const slots = useCandidateSlots(candidate.id);
  const approve = useApproveCandidate(candidate.id);
  const reject = useRejectCandidate(candidate.id);
  const resolve = useResolveClash(candidate.id);
  const activate = useActivateCandidate(candidate.id);
  const [showSlots, setShowSlots] = useState(false);

  const pill = statusPill(candidate.reviewStatus);
  const clashedSlots = (slots.data ?? []).filter((s) => s.hasClash);

  async function onApprove() {
    try {
      await approve.mutateAsync({});
      toast('Candidate approved', 'success');
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Approve failed', 'error');
    }
  }

  async function onReject() {
    try {
      await reject.mutateAsync({});
      toast('Candidate rejected', 'success');
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Reject failed', 'error');
    }
  }

  async function onActivate() {
    try {
      const result = await activate.mutateAsync();
      toast(
        `Activated — ${result.slotsPromoted} promoted, ${result.slotsSkipped} skipped`,
        'success',
      );
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Activate failed', 'error');
    }
  }

  async function onResolveClash(slot: CandidateSlotDto) {
    try {
      await resolve.mutateAsync({ slotId: slot.id });
      toast(`Clash on slot ${slot.id.slice(0, 8)} cleared`, 'success');
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Resolve failed', 'error');
    }
  }

  const canActivate = candidate.reviewStatus === 'APPROVED' && clashedSlots.length === 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold text-gray-900">
            {candidate.candidateName ?? candidate.id.slice(0, 8)}
          </div>
          <div className="text-xs text-gray-500">
            {candidate.totalSlots} slots • {candidate.totalClashes} clashes • soft score{' '}
            {candidate.softConstraintScore ?? 'n/a'}
          </div>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${pill.class}`}>
          {pill.label}
        </span>
      </div>

      {clashedSlots.length > 0 && (
        <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm">
          <div className="font-medium text-rose-900">
            {clashedSlots.length} unresolved clash{clashedSlots.length === 1 ? '' : 'es'}
          </div>
          <ul className="mt-2 space-y-1 text-xs text-rose-800">
            {clashedSlots.slice(0, 3).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span>{s.clashDescription}</span>
                {isAdmin && (
                  <button
                    onClick={() => onResolveClash(s)}
                    className="rounded bg-rose-200 px-2 py-0.5 text-xs font-medium hover:bg-rose-300"
                  >
                    Resolve
                  </button>
                )}
              </li>
            ))}
            {clashedSlots.length > 3 && (
              <li className="italic">…and {clashedSlots.length - 3} more</li>
            )}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowSlots((v) => !v)}
          className="rounded-lg border border-gray-300 px-3 py-1 text-xs"
        >
          {showSlots ? 'Hide slots' : `View all ${slots.data?.length ?? '—'} slots`}
        </button>
        {isAdmin && candidate.reviewStatus === 'PENDING' && (
          <>
            <button
              onClick={onApprove}
              disabled={approve.isPending}
              className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={onReject}
              disabled={reject.isPending}
              className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}
        {isAdmin && candidate.reviewStatus === 'APPROVED' && (
          <button
            onClick={onActivate}
            disabled={!canActivate || activate.isPending}
            title={
              canActivate
                ? 'Promote slots to sch_timetable_slots'
                : 'Resolve all has_clash=true slots first'
            }
            className="rounded-lg bg-campus-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {activate.isPending ? 'Activating…' : 'Activate'}
          </button>
        )}
      </div>

      {showSlots && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded border border-gray-200 text-xs">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 text-gray-700">
              <tr>
                <th className="px-2 py-1 text-left">Day</th>
                <th className="px-2 py-1 text-left">Rot</th>
                <th className="px-2 py-1 text-left">Period</th>
                <th className="px-2 py-1 text-left">Class</th>
                <th className="px-2 py-1 text-left">Room</th>
                <th className="px-2 py-1 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(slots.data ?? []).map((s) => (
                <tr key={s.id} className={s.hasClash ? 'bg-rose-50' : ''}>
                  <td className="px-2 py-1">{s.dayOfWeek ?? '—'}</td>
                  <td className="px-2 py-1">{s.rotationDay ?? '—'}</td>
                  <td className="px-2 py-1">{s.periodId?.slice(0, 8) ?? '—'}</td>
                  <td className="px-2 py-1">{s.classId?.slice(0, 8) ?? '—'}</td>
                  <td className="px-2 py-1">{s.roomId?.slice(0, 8) ?? '—'}</td>
                  <td className="px-2 py-1">
                    {s.hasClash ? (
                      <span className="text-rose-700">{s.clashDescription}</span>
                    ) : (
                      <span className="text-emerald-700">OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
