'use client';

import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { cn } from '@/components/ui/cn';
import { useBellSchedules } from '@/hooks/use-scheduling';
import { formatTime, periodTypeLabel } from '@/lib/scheduling-format';
import type { PeriodDto, SubstitutionDto, TimetableSlotDto } from '@/lib/types';

interface TimetableWeekViewProps {
  slots: TimetableSlotDto[];
  loading: boolean;
  error: boolean;
  emptyTitle: string;
  emptyDescription: string;
  /** Render the teacher name on each cell (true for student/parent views; false for "my own" views). */
  showTeacher?: boolean;
  /** Render the room name on each cell. Default true. */
  showRoom?: boolean;
  /** Optional substitution overrides — when one matches a slot+date in the upcoming week, the cell is highlighted. */
  substitutions?: SubstitutionDto[];
}

/**
 * Reusable week-view grid: rows = the school's default bell schedule
 * periods, columns = Mon-Fri. Slots with `dayOfWeek=null` render in every
 * weekday column (the seed pattern); slots with a specific dayOfWeek
 * render only in that column.
 */
export function TimetableWeekView({
  slots,
  loading,
  error,
  emptyTitle,
  emptyDescription,
  showTeacher = false,
  showRoom = true,
  substitutions,
}: TimetableWeekViewProps) {
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

  const slotsByPeriodAndDay = useMemo(() => {
    const map = new Map<string, TimetableSlotDto[]>();
    for (const slot of slots) {
      const days = slot.dayOfWeek === null ? [0, 1, 2, 3, 4] : [slot.dayOfWeek];
      for (const d of days) {
        if (d > 4) continue;
        const key = `${slot.periodId}::${d}`;
        const arr = map.get(key);
        if (arr) arr.push(slot);
        else map.set(key, [slot]);
      }
    }
    return map;
  }, [slots]);

  /**
   * Map of `${slotId}::${YYYY-MM-DD}` → SubstitutionDto for any upcoming
   * substitution this week. The week-view only highlights the chip; the
   * caller can render a separate list of upcoming substitutions for full
   * detail.
   */
  const subsBySlotDate = useMemo(() => {
    const map = new Map<string, SubstitutionDto>();
    for (const sub of substitutions ?? []) {
      map.set(`${sub.originalSlotId}::${sub.effectiveDate}`, sub);
    }
    return map;
  }, [substitutions]);

  const weekDates = useMemo(() => mondayThroughFriday(new Date()), []);

  if (loading || schedules.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (error) {
    return (
      <EmptyState
        title="Couldn't load the timetable"
        description="Try refreshing the page."
      />
    );
  }
  if (!defaultSchedule) {
    return (
      <EmptyState
        title="No bell schedule"
        description="The school hasn't set a default bell schedule yet."
      />
    );
  }
  if (slots.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
            <th className="w-44 px-3 py-2">Period</th>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((label, i) => (
              <th key={label} className="px-3 py-2">
                {label}
                <span className="ml-1 font-normal text-gray-400">
                  {weekDates[i]?.slice(5)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <PeriodRow
              key={p.id}
              period={p}
              slotsByPeriodAndDay={slotsByPeriodAndDay}
              subsBySlotDate={subsBySlotDate}
              weekDates={weekDates}
              showTeacher={showTeacher}
              showRoom={showRoom}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function mondayThroughFriday(reference: Date): string[] {
  const day = (reference.getUTCDay() + 6) % 7; // shift Mon=0
  const monday = new Date(reference);
  monday.setUTCDate(reference.getUTCDate() - day);
  const out: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function PeriodRow({
  period,
  slotsByPeriodAndDay,
  subsBySlotDate,
  weekDates,
  showTeacher,
  showRoom,
}: {
  period: PeriodDto;
  slotsByPeriodAndDay: Map<string, TimetableSlotDto[]>;
  subsBySlotDate: Map<string, SubstitutionDto>;
  weekDates: string[];
  showTeacher: boolean;
  showRoom: boolean;
}) {
  const isLesson = period.periodType === 'LESSON';
  return (
    <tr className="border-b border-gray-100 align-top">
      <td className="px-3 py-2">
        <p className="font-medium text-gray-900">{period.name}</p>
        <p className="font-mono text-xs text-gray-500">
          {formatTime(period.startTime)}–{formatTime(period.endTime)}
        </p>
        {!isLesson && (
          <span className="mt-1 inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase text-gray-600">
            {periodTypeLabel(period.periodType)}
          </span>
        )}
      </td>
      {[0, 1, 2, 3, 4].map((d) => {
        const dayDate = weekDates[d] ?? '';
        const slots = slotsByPeriodAndDay.get(`${period.id}::${d}`) ?? [];
        return (
          <td key={d} className="border-l border-gray-100 px-2 py-2 align-top">
            {slots.length === 0 ? (
              <span className="text-xs text-gray-300">—</span>
            ) : (
              <div className="space-y-1">
                {slots.map((s) => {
                  const sub = subsBySlotDate.get(`${s.id}::${dayDate}`);
                  return (
                    <SlotCell
                      key={s.id}
                      slot={s}
                      substitution={sub ?? null}
                      showTeacher={showTeacher}
                      showRoom={showRoom}
                    />
                  );
                })}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function SlotCell({
  slot,
  substitution,
  showTeacher,
  showRoom,
}: {
  slot: TimetableSlotDto;
  substitution: SubstitutionDto | null;
  showTeacher: boolean;
  showRoom: boolean;
}) {
  const isSubbed = !!substitution;
  return (
    <div
      className={cn(
        'rounded-lg border px-2 py-1.5',
        isSubbed
          ? 'border-amber-300 bg-amber-50'
          : 'border-campus-100 bg-campus-50',
      )}
    >
      <p
        className={cn(
          'truncate text-xs font-semibold',
          isSubbed ? 'text-amber-900' : 'text-campus-800',
        )}
      >
        {slot.classSectionCode}
      </p>
      <p
        className={cn(
          'truncate text-[11px]',
          isSubbed ? 'text-amber-900' : 'text-campus-700',
        )}
      >
        {slot.courseName}
      </p>
      {showTeacher && (
        <p className="truncate text-[11px] text-gray-600">
          {isSubbed ? (
            <>
              <span className="line-through opacity-60">
                {slot.teacherName ?? 'TBD'}
              </span>{' '}
              <span className="font-semibold text-amber-900">
                → {substitution!.substituteName}
              </span>
            </>
          ) : (
            <>{slot.teacherName ?? 'TBD'}</>
          )}
        </p>
      )}
      {showRoom && (
        <p className="truncate text-[11px] text-gray-500">
          {isSubbed && substitution!.roomName !== slot.roomName ? (
            <>
              <span className="line-through opacity-60">{slot.roomName}</span>{' '}
              <span className="font-medium text-amber-900">
                → {substitution!.roomName}
              </span>
            </>
          ) : (
            <>{slot.roomName}</>
          )}
        </p>
      )}
    </div>
  );
}
