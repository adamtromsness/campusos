'use client';

import { useMemo, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { cn } from '@/components/ui/cn';
import { useBellSchedules, useRooms } from '@/hooks/use-scheduling';
import { formatTime, todayIso } from '@/lib/scheduling-format';

/**
 * Compact widget: pick a date + period → shows a green/red availability dot
 * per active room. Powered by the Step 5 RoomService availability annotation
 * (`GET /rooms?availabilityDate=&availabilityPeriodId=` returns `available:
 * boolean | null` per row by intersecting against active timetable slots
 * that match the period for the supplied date).
 */
export function RoomAvailabilityChecker() {
  const [date, setDate] = useState<string>(todayIso());
  const [periodId, setPeriodId] = useState<string>('');

  const schedules = useBellSchedules();
  const defaultSchedule = useMemo(
    () => (schedules.data ?? []).find((s) => s.isDefault) ?? schedules.data?.[0] ?? null,
    [schedules.data],
  );
  const periods = useMemo(
    () =>
      defaultSchedule
        ? defaultSchedule.periods.slice().sort((a, b) => a.sortOrder - b.sortOrder)
        : [],
    [defaultSchedule],
  );

  const rooms = useRooms(
    {
      availabilityDate: periodId ? date : undefined,
      availabilityPeriodId: periodId || undefined,
    },
    !!periodId,
  );

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900">Check room availability</h3>
      <p className="mt-1 text-xs text-gray-500">
        Pick a date and period — green rooms are free, amber rooms have a class scheduled.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="mr-2 text-gray-700">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mr-2 text-gray-700">Period</span>
          <select
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">— pick a period —</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({formatTime(p.startTime)}–{formatTime(p.endTime)})
              </option>
            ))}
          </select>
        </label>
      </div>

      {!periodId ? (
        <p className="mt-3 text-xs text-gray-400">Pick a period to see room availability.</p>
      ) : rooms.isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Checking…
        </div>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {(rooms.data ?? [])
            .filter((r) => r.isActive)
            .map((r) => (
              <li
                key={r.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs',
                  r.available === true
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : r.available === false
                      ? 'border-amber-200 bg-amber-50 text-amber-900'
                      : 'border-gray-200 bg-gray-50 text-gray-600',
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    r.available === true
                      ? 'bg-emerald-500'
                      : r.available === false
                        ? 'bg-amber-500'
                        : 'bg-gray-400',
                  )}
                />
                <span className="truncate font-medium">{r.name}</span>
                {r.capacity !== null && (
                  <span className="ml-auto text-[10px] text-gray-500">cap {r.capacity}</span>
                )}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
