'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useRjConferences,
  useCreateRjConference,
  type RjConferenceStatus,
} from '@/hooks/use-behaviour-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

const STATUS_PILL: Record<RjConferenceStatus, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  AGREEMENT_REACHED: 'bg-violet-100 text-violet-700',
  RESOLVED_SUCCESSFULLY: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-rose-100 text-rose-700',
};

const STATUS_LABEL: Record<RjConferenceStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  AGREEMENT_REACHED: 'Agreement reached',
  RESOLVED_SUCCESSFULLY: 'Resolved',
  FAILED: 'Failed',
};

export default function RestorativeJusticePage() {
  const { user } = useAuthStore();
  const canWrite = hasAnyPermission(user, ['beh-001:write', 'beh-001:admin']);
  const [open, setOpen] = useState(false);
  const [incidentId, setIncidentId] = useState('');
  const [offender, setOffender] = useState('');
  const [harmed, setHarmed] = useState('');
  const [notes, setNotes] = useState('');
  const { toast } = useToast();

  const confs = useRjConferences();
  const create = useCreateRjConference();

  async function submit() {
    try {
      await create.mutateAsync({
        incidentId,
        offenderStudentId: offender,
        harmedPartyIds: harmed
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        conferenceNotes: notes || undefined,
      });
      toast('Conference initiated', 'success');
      setOpen(false);
      setIncidentId('');
      setOffender('');
      setHarmed('');
      setNotes('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create conference', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Restorative justice"
        description="Counsellor-led conferences with structured agreements and follow-through tracking."
        actions={
          canWrite ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800"
            >
              Initiate conference
            </button>
          ) : null
        }
      />

      {confs.isLoading ? (
        <LoadingSpinner />
      ) : confs.data && confs.data.length > 0 ? (
        <div className="space-y-3">
          {confs.data.map((c) => (
            <Link
              key={c.id}
              href={`/behaviour/restorative-justice/${c.id}`}
              className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-campus-300 hover:bg-campus-50"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-900">
                    {c.offenderStudentName ?? 'Student'}
                  </div>
                  <div className="text-sm text-gray-600">
                    {c.harmedPartyIds.length} harmed{' '}
                    {c.harmedPartyIds.length === 1 ? 'party' : 'parties'}
                    {c.conferenceDate
                      ? ' · ' + new Date(c.conferenceDate).toLocaleDateString()
                      : ''}
                  </div>
                </div>
                <span
                  className={'rounded-full px-3 py-1 text-xs font-medium ' + STATUS_PILL[c.status]}
                >
                  {STATUS_LABEL[c.status]}
                </span>
              </div>
              {c.conferenceNotes ? (
                <p className="mt-2 text-sm text-gray-600 line-clamp-2">{c.conferenceNotes}</p>
              ) : null}
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No conferences yet"
          description="Restorative justice conferences are initiated from a Cycle 9 discipline incident by a counsellor."
        />
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Initiate restorative justice conference"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!incidentId || !offender || !harmed || create.isPending}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Incident UUID</span>
            <input
              type="text"
              value={incidentId}
              onChange={(e) => setIncidentId(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="from Cycle 9 sis_discipline_incidents"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Offender student UUID</span>
            <input
              type="text"
              value={offender}
              onChange={(e) => setOffender(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Harmed party UUIDs (comma-separated)
            </span>
            <input
              type="text"
              value={harmed}
              onChange={(e) => setHarmed(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Initial notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
