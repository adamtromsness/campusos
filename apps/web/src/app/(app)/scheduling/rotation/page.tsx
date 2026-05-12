'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useCreateRotationCycle,
  useGenerateRotationCalendar,
  useRotationCalendar,
  useRotationCycles,
  useUpsertRotationCalendarEntry,
  type RotationCalendarEntryDto,
} from '@/hooks/use-scheduling-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

const DAY_COLOURS = [
  'bg-sky-100 text-sky-800 ring-sky-300',
  'bg-emerald-100 text-emerald-800 ring-emerald-300',
  'bg-amber-100 text-amber-800 ring-amber-300',
  'bg-violet-100 text-violet-800 ring-violet-300',
  'bg-rose-100 text-rose-800 ring-rose-300',
  'bg-teal-100 text-teal-800 ring-teal-300',
];

function dayColour(rotationDay: number): string {
  return DAY_COLOURS[(rotationDay - 1) % DAY_COLOURS.length] ?? DAY_COLOURS[0]!;
}

export default function RotationCalendarPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const { toast } = useToast();

  const cycles = useRotationCycles(!!user);
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const selectedCycleId =
    activeCycleId ?? cycles.data?.find((c) => c.isActive)?.id ?? cycles.data?.[0]?.id ?? null;
  const cycle = useMemo(
    () => cycles.data?.find((c) => c.id === selectedCycleId) ?? null,
    [cycles.data, selectedCycleId],
  );

  const today = new Date();
  const fromDate = today.toISOString().slice(0, 10);
  const endLookup = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  const toDate = endLookup.toISOString().slice(0, 10);
  const calendar = useRotationCalendar(selectedCycleId, fromDate, toDate, !!user);

  const create = useCreateRotationCycle();
  const upsert = useUpsertRotationCalendarEntry(selectedCycleId ?? '');
  const generate = useGenerateRotationCalendar(selectedCycleId ?? '');

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLength, setNewLength] = useState(2);
  const [showGenerate, setShowGenerate] = useState(false);
  const [genStart, setGenStart] = useState(fromDate);
  const [genEnd, setGenEnd] = useState(toDate);

  if (!user) return null;

  async function onCreateCycle() {
    if (!newName.trim()) return;
    try {
      await create.mutateAsync({ name: newName.trim(), cycleLength: newLength });
      toast('Rotation cycle created', 'success');
      setShowCreate(false);
      setNewName('');
      setNewLength(2);
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Could not create cycle', 'error');
    }
  }

  async function onGenerate() {
    if (!selectedCycleId) return;
    try {
      const result = await generate.mutateAsync({ startDate: genStart, endDate: genEnd });
      toast(
        `Generated ${result.created} created, ${result.updated} updated, ${result.closed} closed`,
        'success',
      );
      setShowGenerate(false);
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Generation failed', 'error');
    }
  }

  async function onChangeDay(entry: RotationCalendarEntryDto, newDay: number) {
    if (!cycle) return;
    if (newDay < 1 || newDay > cycle.cycleLength) return;
    try {
      await upsert.mutateAsync({
        calendarDate: entry.calendarDate,
        rotationDay: newDay,
        isSchoolDay: entry.isSchoolDay,
      });
      toast('Calendar entry updated', 'success');
    } catch (e) {
      const err = e as { message?: string };
      toast(err.message ?? 'Update failed', 'error');
    }
  }

  const list = calendar.data ?? [];
  const cyclesList = cycles.data ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Rotation Calendar"
        description="Map school days to rotation days (A/B week, 6-day rotation). Admin maintains; rotation day drives which periods run."
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <select
          value={selectedCycleId ?? ''}
          onChange={(e) => setActiveCycleId(e.target.value || null)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          {cyclesList.length === 0 ? (
            <option value="">No cycles yet</option>
          ) : (
            cyclesList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} (length {c.cycleLength}){c.isActive ? '' : ' — inactive'}
              </option>
            ))
          )}
        </select>
        {isAdmin && (
          <>
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
            >
              New cycle
            </button>
            <button
              onClick={() => setShowGenerate(true)}
              disabled={!selectedCycleId}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Auto-generate
            </button>
          </>
        )}
      </div>

      {cycles.isLoading || calendar.isLoading ? (
        <LoadingSpinner />
      ) : cyclesList.length === 0 ? (
        <EmptyState
          title="No rotation cycles defined"
          description="Create one to start mapping rotation days."
        />
      ) : cycle === null ? (
        <EmptyState title="Select a cycle" description="Pick a rotation cycle from the dropdown." />
      ) : list.length === 0 ? (
        <EmptyState
          title="No calendar entries"
          description="Use Auto-generate to populate Mon..Fri for a date range, or add entries one date at a time."
        />
      ) : (
        <div className="grid grid-cols-7 gap-2">
          <div className="col-span-7 text-xs uppercase tracking-wide text-gray-500">
            Showing {list.length} calendar entries from {fromDate} to {toDate}
          </div>
          {list.map((entry) => (
            <div
              key={entry.id}
              className={`rounded-lg p-3 text-sm ring-1 ${
                entry.isSchoolDay
                  ? dayColour(entry.rotationDay)
                  : 'bg-gray-100 text-gray-500 ring-gray-300'
              }`}
            >
              <div className="text-xs font-medium">{entry.calendarDate}</div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-lg font-semibold">
                  {entry.isSchoolDay ? `Day ${entry.rotationDay}` : 'Closed'}
                </span>
                {isAdmin && entry.isSchoolDay && (
                  <select
                    value={entry.rotationDay}
                    onChange={(e) => onChangeDay(entry, Number(e.target.value))}
                    className="ml-2 rounded border border-gray-400 bg-white px-1 py-0.5 text-xs"
                  >
                    {Array.from({ length: cycle.cycleLength }).map((_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {i + 1}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New rotation cycle">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="A/B Week, 6-day rotation, …"
              className="w-full rounded-lg border border-gray-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Cycle length (1..14)
            </label>
            <input
              type="number"
              min={1}
              max={14}
              value={newLength}
              onChange={(e) => setNewLength(Math.max(1, Math.min(14, Number(e.target.value))))}
              className="w-32 rounded-lg border border-gray-300 px-3 py-2"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onCreateCycle}
              disabled={!newName.trim() || create.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showGenerate}
        onClose={() => setShowGenerate(false)}
        title="Auto-generate calendar"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Walks Mon..Fri across the date range, alternating rotation day round-robin. Existing
            entries are updated. Closure dates can be passed individually after generation.
          </p>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Start date</label>
            <input
              type="date"
              value={genStart}
              onChange={(e) => setGenStart(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">End date</label>
            <input
              type="date"
              value={genEnd}
              onChange={(e) => setGenEnd(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowGenerate(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onGenerate}
              disabled={generate.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Generate
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
