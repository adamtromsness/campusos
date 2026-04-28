'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useBellSchedule, useUpsertPeriods } from '@/hooks/use-scheduling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  PERIOD_TYPES,
  formatTime,
  periodTypeLabel,
  scheduleTypeLabel,
} from '@/lib/scheduling-format';
import type { PeriodInputPayload, PeriodType } from '@/lib/types';

interface DraftPeriod {
  key: string;
  name: string;
  startTime: string;
  endTime: string;
  periodType: PeriodType;
  dayOfWeek: number | null;
  sortOrder: number;
}

let counter = 0;
function nextKey() {
  counter += 1;
  return `period-${counter}-${Date.now()}`;
}

export default function BellScheduleDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const schedule = useBellSchedule(id, !!user);
  const upsertPeriods = useUpsertPeriods(id);
  const { toast } = useToast();

  const [draft, setDraft] = useState<DraftPeriod[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!schedule.data) return;
    setDraft(
      schedule.data.periods
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.startTime.localeCompare(b.startTime))
        .map((p, i) => ({
          key: nextKey(),
          name: p.name,
          startTime: formatTime(p.startTime),
          endTime: formatTime(p.endTime),
          periodType: p.periodType,
          dayOfWeek: p.dayOfWeek,
          sortOrder: i,
        })),
    );
    setDirty(false);
  }, [schedule.data]);

  if (!user) return null;
  if (schedule.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (schedule.isError || !schedule.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          title="Bell schedule not found"
          description="It may have been deleted, or you don't have access."
          action={
            <Link
              href="/schedule/bell-schedules"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
            >
              Back to schedules
            </Link>
          }
        />
      </div>
    );
  }
  const data = schedule.data;

  function updateRow(key: string, patch: Partial<DraftPeriod>) {
    setDraft((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  function removeRow(key: string) {
    setDraft((rows) => rows.filter((r) => r.key !== key).map((r, i) => ({ ...r, sortOrder: i })));
    setDirty(true);
  }

  function addRow() {
    setDraft((rows) => [
      ...rows,
      {
        key: nextKey(),
        name: `Period ${rows.length + 1}`,
        startTime: '08:00',
        endTime: '08:50',
        periodType: 'LESSON',
        dayOfWeek: null,
        sortOrder: rows.length,
      },
    ]);
    setDirty(true);
  }

  function validate(): string | null {
    if (draft.length === 0) return 'Add at least one period.';
    for (const p of draft) {
      if (!p.name.trim()) return `A period needs a name.`;
      if (!/^\d{2}:\d{2}$/.test(p.startTime) || !/^\d{2}:\d{2}$/.test(p.endTime)) {
        return `Period "${p.name}" needs HH:MM start/end times.`;
      }
      if (p.startTime >= p.endTime) {
        return `Period "${p.name}" start time must be before end time.`;
      }
    }
    return null;
  }

  async function onSave() {
    const err = validate();
    if (err) {
      toast(err, 'error');
      return;
    }
    const payload: PeriodInputPayload[] = draft.map((p, i) => ({
      name: p.name.trim(),
      startTime: p.startTime,
      endTime: p.endTime,
      periodType: p.periodType,
      dayOfWeek: p.dayOfWeek,
      sortOrder: i,
    }));
    try {
      await upsertPeriods.mutateAsync({ periods: payload });
      toast('Periods saved', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not save periods', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={data.name}
        description={`${scheduleTypeLabel(data.scheduleType)}${data.isDefault ? ' · default' : ''}`}
        actions={
          <Link
            href="/schedule/bell-schedules"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Back
          </Link>
        }
      />

      <section className="mt-2 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Periods</h2>
          {isAdmin && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!dirty) return;
                  if (window.confirm('Discard unsaved changes?')) {
                    void schedule.refetch();
                  }
                }}
                disabled={!dirty}
                className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={addRow}
                className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
              >
                + Add period
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={!dirty || upsertPeriods.isPending}
                className="rounded-lg bg-campus-700 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
              >
                {upsertPeriods.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>

        {draft.length === 0 ? (
          <EmptyState
            title="No periods yet"
            description={
              isAdmin
                ? 'Add a period to define this schedule.'
                : 'Periods have not been configured.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <th className="px-2 py-2">#</th>
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Start</th>
                  <th className="px-2 py-2">End</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Day</th>
                  {isAdmin && <th className="w-10 px-2 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {draft.map((p, i) => (
                  <tr key={p.key} className="border-b border-gray-100">
                    <td className="px-2 py-2 text-xs text-gray-500">{i + 1}</td>
                    <td className="px-2 py-2">
                      {isAdmin ? (
                        <input
                          value={p.name}
                          onChange={(e) => updateRow(p.key, { name: e.target.value })}
                          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-campus-500 focus:outline-none"
                        />
                      ) : (
                        <span>{p.name}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {isAdmin ? (
                        <input
                          type="time"
                          value={p.startTime}
                          onChange={(e) => updateRow(p.key, { startTime: e.target.value })}
                          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-campus-500 focus:outline-none"
                        />
                      ) : (
                        <span className="font-mono text-xs">{p.startTime}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {isAdmin ? (
                        <input
                          type="time"
                          value={p.endTime}
                          onChange={(e) => updateRow(p.key, { endTime: e.target.value })}
                          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-campus-500 focus:outline-none"
                        />
                      ) : (
                        <span className="font-mono text-xs">{p.endTime}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {isAdmin ? (
                        <select
                          value={p.periodType}
                          onChange={(e) =>
                            updateRow(p.key, { periodType: e.target.value as PeriodType })
                          }
                          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-campus-500 focus:outline-none"
                        >
                          {PERIOD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {periodTypeLabel(t)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                            p.periodType === 'LESSON'
                              ? 'bg-campus-100 text-campus-700'
                              : p.periodType === 'LUNCH'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-gray-100 text-gray-700',
                          )}
                        >
                          {periodTypeLabel(p.periodType)}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-gray-500">
                      {p.dayOfWeek === null
                        ? 'Every weekday'
                        : (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][p.dayOfWeek] ?? '?')}
                    </td>
                    {isAdmin && (
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          onClick={() => removeRow(p.key)}
                          className="text-xs text-red-600 hover:text-red-800"
                          aria-label="Remove period"
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
