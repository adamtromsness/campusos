'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ELIGIBILITY_LABELS,
  ELIGIBILITY_PILL,
  ROSTER_LEVEL_LABELS,
  formatRecord,
} from '@/lib/athletics-format';
import {
  useAddAthleticsRosterMember,
  useAthleticsCoaches,
  useAthleticsRoster,
  useAthleticsRosterMembers,
  useAthleticsSeasonRecord,
  useCertifyAthleticsRoster,
  useCheckAthleticsEligibility,
} from '@/hooks/use-athletics';

export default function RosterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const isAd =
    hasAnyPermission(user, ['sch-001:admin']) ||
    (user?.personType === 'STAFF' && hasAnyPermission(user, ['ath-001:write']));
  const { toast } = useToast();

  const rosterQ = useAthleticsRoster(id ?? null);
  const membersQ = useAthleticsRosterMembers(id ?? null);
  const coachesQ = useAthleticsCoaches(id ?? null);
  const recordQ = useAthleticsSeasonRecord(id ?? null);

  const [showAdd, setShowAdd] = useState(false);
  const [draftStudentId, setDraftStudentId] = useState('');
  const [draftJersey, setDraftJersey] = useState('');
  const [draftPosition, setDraftPosition] = useState('');

  const addMut = useAddAthleticsRosterMember(id ?? '');
  const certifyMut = useCertifyAthleticsRoster(id ?? '');
  const checkMut = useCheckAthleticsEligibility(id ?? '');

  if (rosterQ.isLoading) return <LoadingSpinner />;
  if (!rosterQ.data) return <p className="text-gray-500">Roster not found.</p>;
  const r = rosterQ.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${ROSTER_LEVEL_LABELS[r.level]} Roster`}
        description={r.headCoachName ? `Head Coach: ${r.headCoachName}` : 'No head coach assigned'}
      />

      {/* Stat row */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg bg-emerald-50 p-4">
          <div className="text-xs text-emerald-700">Members</div>
          <div className="mt-1 text-2xl font-semibold text-emerald-900">
            {r.eligibleCount ?? 0}/{r.memberCount ?? 0}
          </div>
          <div className="text-xs text-emerald-700">eligible</div>
        </div>
        <div className="rounded-lg bg-sky-50 p-4">
          <div className="text-xs text-sky-700">Record</div>
          <div className="mt-1 text-2xl font-semibold text-sky-900">
            {formatRecord(recordQ.data)}
          </div>
          <div className="text-xs text-sky-700">
            Conf{' '}
            {recordQ.data
              ? `${recordQ.data.conferenceWins}-${recordQ.data.conferenceLosses}-${recordQ.data.conferenceDraws}`
              : '—'}
          </div>
        </div>
        <div className={`rounded-lg p-4 ${r.isCertified ? 'bg-emerald-50' : 'bg-amber-50'}`}>
          <div className={`text-xs ${r.isCertified ? 'text-emerald-700' : 'text-amber-700'}`}>
            Certification
          </div>
          <div
            className={`mt-1 text-2xl font-semibold ${r.isCertified ? 'text-emerald-900' : 'text-amber-900'}`}
          >
            {r.isCertified ? 'Certified' : 'Draft'}
          </div>
          <div className={`text-xs ${r.isCertified ? 'text-emerald-700' : 'text-amber-700'}`}>
            {r.certifiedByName ? `By ${r.certifiedByName}` : ''}
          </div>
        </div>
      </div>

      {/* Action bar */}
      {isAd ? (
        <div className="flex gap-2">
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700"
          >
            Add member
          </button>
          <button
            onClick={async () => {
              try {
                const list = await checkMut.mutateAsync();
                toast(`Eligibility re-checked across ${list.length} member(s)`, 'success');
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'error');
              }
            }}
            disabled={checkMut.isPending}
            className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200 disabled:opacity-50"
          >
            Re-check eligibility
          </button>
          {!r.isCertified ? (
            <button
              onClick={async () => {
                try {
                  await certifyMut.mutateAsync();
                  toast('Roster certified', 'success');
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
              disabled={certifyMut.isPending}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Certify roster
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Members table */}
      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-4 font-semibold text-gray-900">Members</div>
        {membersQ.isLoading ? (
          <div className="p-4">
            <LoadingSpinner />
          </div>
        ) : membersQ.data && membersQ.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Position</th>
                <th className="px-4 py-2">Eligibility</th>
                <th className="px-4 py-2">Live GPA</th>
              </tr>
            </thead>
            <tbody>
              {membersQ.data.map((m) => (
                <tr key={m.id} className="border-b border-gray-100">
                  <td className="px-4 py-2 font-mono text-gray-700">{m.jerseyNumber ?? '—'}</td>
                  <td className="px-4 py-2 font-medium text-gray-900">{m.studentName}</td>
                  <td className="px-4 py-2 text-gray-600">{m.position ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${ELIGIBILITY_PILL[m.eligibilityStatus]}`}
                    >
                      {ELIGIBILITY_LABELS[m.eligibilityStatus]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {m.liveGpa !== null ? m.liveGpa.toFixed(1) : '—'}
                    {m.programmeMinGpa !== null ? ` (req ${m.programmeMinGpa.toFixed(1)})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-4 text-sm text-gray-500">No members yet.</p>
        )}
      </section>

      {/* Coaching staff */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 font-semibold text-gray-900">Coaching staff</div>
        {coachesQ.data && coachesQ.data.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {coachesQ.data.map((c) => (
              <li key={c.id}>
                <span className="font-medium text-gray-900">{c.coachName ?? c.coachPersonId}</span>
                <span className="ml-2 text-xs text-gray-500">{c.role}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No coaches assigned yet.</p>
        )}
      </section>

      <Modal
        open={showAdd}
        title="Add roster member"
        onClose={() => setShowAdd(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!draftStudentId.trim()) {
                  toast('studentId is required', 'error');
                  return;
                }
                try {
                  const dto = await addMut.mutateAsync({
                    studentId: draftStudentId.trim(),
                    jerseyNumber: draftJersey || undefined,
                    position: draftPosition || undefined,
                  });
                  toast(
                    `Added ${dto.studentName} — ${ELIGIBILITY_LABELS[dto.eligibilityStatus]}`,
                    'success',
                  );
                  setShowAdd(false);
                  setDraftStudentId('');
                  setDraftJersey('');
                  setDraftPosition('');
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
              disabled={addMut.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            The GPA eligibility check reads live grades from the gradebook and sets eligibility
            accordingly when the programme has a min GPA.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700">Student id (UUID)</label>
            <input
              type="text"
              value={draftStudentId}
              onChange={(e) => setDraftStudentId(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Jersey number</label>
            <input
              type="text"
              value={draftJersey}
              onChange={(e) => setDraftJersey(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Position</label>
            <input
              type="text"
              value={draftPosition}
              onChange={(e) => setDraftPosition(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
