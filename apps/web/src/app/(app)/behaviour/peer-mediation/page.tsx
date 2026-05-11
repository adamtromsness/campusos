'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useCreatePeerMediation,
  usePeerMediations,
  useUpdatePeerMediation,
  type PeerMediationStatus,
} from '@/hooks/use-behaviour-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

const STATUS_PILL: Record<PeerMediationStatus, string> = {
  REFERRED: 'bg-sky-100 text-sky-700',
  SCHEDULED: 'bg-amber-100 text-amber-700',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  UNRESOLVED: 'bg-rose-100 text-rose-700',
};

const CHIPS: Array<{ value: PeerMediationStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'REFERRED', label: 'Referred' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'UNRESOLVED', label: 'Unresolved' },
];

export default function PeerMediationPage() {
  const { user } = useAuthStore();
  const canRefer = hasAnyPermission(user, ['beh-001:write', 'beh-001:admin']);
  const [filter, setFilter] = useState<PeerMediationStatus | 'ALL'>('ALL');
  const [refModal, setRefModal] = useState(false);
  const [mediator, setMediator] = useState('');
  const [partyA, setPartyA] = useState('');
  const [partyB, setPartyB] = useState('');
  const [desc, setDesc] = useState('');
  const { toast } = useToast();

  const meds = usePeerMediations(filter === 'ALL' ? undefined : filter);
  const create = useCreatePeerMediation();
  const [resolveOpen, setResolveOpen] = useState<string | null>(null);
  const [resolveOutcome, setResolveOutcome] = useState('');
  const resolveSvc = useUpdatePeerMediation(resolveOpen ?? '');

  async function submitRef() {
    try {
      await create.mutateAsync({
        mediatorStudentId: mediator,
        partyAStudentId: partyA,
        partyBStudentId: partyB,
        conflictDescription: desc,
      });
      toast('Referred for mediation', 'success');
      setRefModal(false);
      setMediator('');
      setPartyA('');
      setPartyB('');
      setDesc('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function submitResolve() {
    if (!resolveOpen) return;
    try {
      await resolveSvc.mutateAsync({ status: 'RESOLVED', outcome: resolveOutcome });
      toast('Resolved', 'success');
      setResolveOpen(null);
      setResolveOutcome('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Peer mediation"
        description="Lower-tier conflict resolution between students with trained mediators."
        actions={
          canRefer ? (
            <button
              type="button"
              onClick={() => setRefModal(true)}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white"
            >
              Refer
            </button>
          ) : null
        }
      />

      <div className="flex gap-2">
        {CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setFilter(c.value)}
            className={
              'rounded-full px-3 py-1 text-xs ' +
              (filter === c.value
                ? 'bg-campus-700 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      {meds.isLoading ? (
        <LoadingSpinner />
      ) : meds.data && meds.data.length > 0 ? (
        <div className="space-y-3">
          {meds.data.map((m) => (
            <div key={m.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm text-gray-700">
                    <strong>Mediator:</strong> {m.mediatorStudentName ?? '—'}
                  </div>
                  <div className="text-sm text-gray-700">
                    <strong>Parties:</strong> {m.partyAStudentName ?? '—'} ·{' '}
                    {m.partyBStudentName ?? '—'}
                  </div>
                  <p className="mt-2 text-sm text-gray-600">{m.conflictDescription}</p>
                  {m.outcome ? (
                    <p className="mt-1 text-sm text-emerald-700">
                      <strong>Outcome:</strong> {m.outcome}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className={'rounded-full px-2 py-1 text-xs ' + STATUS_PILL[m.status]}>
                    {m.status}
                  </span>
                  {canRefer && m.status !== 'RESOLVED' && m.status !== 'UNRESOLVED' ? (
                    <button
                      type="button"
                      onClick={() => setResolveOpen(m.id)}
                      className="text-xs text-campus-700 hover:underline"
                    >
                      Mark resolved
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No mediations"
          description="Refer a student-to-student conflict to begin."
        />
      )}

      <Modal
        open={refModal}
        onClose={() => setRefModal(false)}
        title="Refer for peer mediation"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRefModal(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitRef}
              disabled={!mediator || !partyA || !partyB || !desc}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Refer
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Mediator must be different from both parties. Parties cannot be the same student.
          </p>
          <label className="block">
            <span className="text-sm">Mediator student UUID</span>
            <input
              value={mediator}
              onChange={(e) => setMediator(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Party A student UUID</span>
            <input
              value={partyA}
              onChange={(e) => setPartyA(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Party B student UUID</span>
            <input
              value={partyB}
              onChange={(e) => setPartyB(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Conflict description</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={!!resolveOpen}
        onClose={() => setResolveOpen(null)}
        title="Resolve mediation"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setResolveOpen(null)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitResolve}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm text-white"
            >
              Resolve
            </button>
          </div>
        }
      >
        <label className="block">
          <span className="text-sm">Outcome</span>
          <textarea
            value={resolveOutcome}
            onChange={(e) => setResolveOutcome(e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </Modal>
    </div>
  );
}
