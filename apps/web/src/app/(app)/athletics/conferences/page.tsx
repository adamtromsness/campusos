'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useConferences,
  useConferenceMemberships,
  useConferenceSchedule,
  useCreateConference,
} from '@/hooks/use-athletics-advanced';

export default function ConferenceManagerPage() {
  const user = useAuthStore((s) => s.user);
  const isAd =
    hasAnyPermission(user, ['sch-001:admin']) ||
    (user?.personType === 'STAFF' && hasAnyPermission(user, ['ath-003:write']));
  const { toast } = useToast();

  const conferencesQ = useConferences();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const membershipsQ = useConferenceMemberships(selectedId);
  const scheduleQ = useConferenceSchedule(selectedId);
  const createMut = useCreateConference();

  const [showCreate, setShowCreate] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftSport, setDraftSport] = useState('');
  const [draftRegion, setDraftRegion] = useState('');

  // Default-pick first conference
  if (!selectedId && conferencesQ.data && conferencesQ.data.length > 0) {
    setSelectedId(conferencesQ.data[0]!.id);
  }

  async function submitCreate() {
    if (!draftName.trim() || !draftSport.trim()) {
      toast('Name and sport are required', 'error');
      return;
    }
    try {
      const created = await createMut.mutateAsync({
        name: draftName.trim(),
        sport: draftSport.trim(),
        region: draftRegion.trim() || undefined,
      });
      toast('Conference created', 'success');
      setShowCreate(false);
      setDraftName('');
      setDraftSport('');
      setDraftRegion('');
      setSelectedId(created.id);
    } catch (e) {
      const err = e as { message?: string };
      toast(err?.message ?? 'Failed to create conference', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Athletic Conferences"
        description="Conference catalogue, memberships, and cross-school schedules"
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <aside className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-gray-700">Conferences</h2>
            {isAd && (
              <button
                type="button"
                onClick={() => setShowCreate((v) => !v)}
                className="text-xs text-campus-700 hover:underline"
              >
                {showCreate ? 'Cancel' : '+ New'}
              </button>
            )}
          </div>
          {showCreate && (
            <div className="rounded-md border border-gray-200 bg-white p-3 space-y-2">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Name (e.g. Kansas 4A)"
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
              <input
                value={draftSport}
                onChange={(e) => setDraftSport(e.target.value)}
                placeholder="Sport (e.g. Basketball)"
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
              <input
                value={draftRegion}
                onChange={(e) => setDraftRegion(e.target.value)}
                placeholder="Region (optional)"
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={submitCreate}
                disabled={createMut.isPending}
                className="w-full rounded-md bg-campus-700 px-3 py-1 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
              >
                {createMut.isPending ? 'Saving…' : 'Create'}
              </button>
            </div>
          )}
          {conferencesQ.isLoading ? (
            <LoadingSpinner />
          ) : (
            <ul className="space-y-1">
              {conferencesQ.data?.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                      c.id === selectedId
                        ? 'bg-campus-50 text-campus-700 font-medium'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    {c.name} · {c.sport}
                    <div className="text-xs text-gray-500">{c.membershipCount} members</div>
                  </button>
                </li>
              ))}
              {(conferencesQ.data?.length ?? 0) === 0 && (
                <li className="text-sm text-gray-500">No conferences yet.</li>
              )}
            </ul>
          )}
        </aside>

        <div className="space-y-6 lg:col-span-2">
          <section>
            <h2 className="font-medium text-gray-700 mb-2">Member schools</h2>
            {membershipsQ.isLoading ? (
              <LoadingSpinner />
            ) : (
              <div className="rounded-lg border border-gray-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left">
                    <tr>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        School
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Programme
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Level
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Joined
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {membershipsQ.data?.map((m) => (
                      <tr key={m.id} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">
                          {m.schoolId.slice(0, 8)}…
                        </td>
                        <td className="px-3 py-2 text-gray-700">{m.programmeName ?? '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{m.level ?? '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{m.joinedDate}</td>
                      </tr>
                    ))}
                    {(membershipsQ.data?.length ?? 0) === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-4 text-center text-gray-500">
                          No memberships.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="font-medium text-gray-700 mb-2">Schedule</h2>
            {scheduleQ.isLoading ? (
              <LoadingSpinner />
            ) : (
              <div className="rounded-lg border border-gray-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left">
                    <tr>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Date
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Time
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Home
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Away
                      </th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">
                        Linked
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduleQ.data?.map((s) => (
                      <tr key={s.id} className="border-t border-gray-100">
                        <td className="px-3 py-2 text-gray-700">{s.scheduledDate}</td>
                        <td className="px-3 py-2 text-gray-700">{s.scheduledTime ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">
                          {s.homeSchoolId.slice(0, 8)}…
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">
                          {s.awaySchoolId.slice(0, 8)}…
                        </td>
                        <td className="px-3 py-2 text-gray-700">{s.linkedGameId ? '✓' : '—'}</td>
                      </tr>
                    ))}
                    {(scheduleQ.data?.length ?? 0) === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-center text-gray-500">
                          No scheduled games.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
