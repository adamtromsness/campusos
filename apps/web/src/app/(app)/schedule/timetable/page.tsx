'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useEmployees } from '@/hooks/use-hr';
import { useClasses } from '@/hooks/use-classes';
import { useBellSchedules, useRooms, useTimetable } from '@/hooks/use-scheduling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { formatTime, periodTypeLabel } from '@/lib/scheduling-format';
import type { PeriodDto, TimetableSlotDto } from '@/lib/types';

type FilterMode = 'all' | 'teacher' | 'room' | 'class';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

export default function TimetablePage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);

  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [teacherId, setTeacherId] = useState<string>('');
  const [classId, setClassId] = useState<string>('');
  const [roomId, setRoomId] = useState<string>('');

  const schedules = useBellSchedules(!!user);
  const employees = useEmployees({}, !!user);
  const classes = useClasses();
  const rooms = useRooms({}, !!user);

  const filterArgs =
    filterMode === 'teacher' && teacherId
      ? { teacherId }
      : filterMode === 'class' && classId
        ? { classId }
        : filterMode === 'room' && roomId
          ? { roomId }
          : {};
  const timetable = useTimetable(filterArgs, !!user);

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
    for (const slot of timetable.data ?? []) {
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
  }, [timetable.data]);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Timetable"
        description="Week view — periods × weekdays. Cells show class, teacher, and room."
        actions={
          isAdmin ? (
            <Link
              href="/schedule/bell-schedules"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
            >
              Bell schedules
            </Link>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <FilterChip
          active={filterMode === 'all'}
          onClick={() => setFilterMode('all')}
          label="All"
        />
        <FilterChip
          active={filterMode === 'teacher'}
          onClick={() => setFilterMode('teacher')}
          label="By teacher"
        />
        <FilterChip
          active={filterMode === 'class'}
          onClick={() => setFilterMode('class')}
          label="By class"
        />
        <FilterChip
          active={filterMode === 'room'}
          onClick={() => setFilterMode('room')}
          label="By room"
        />

        {filterMode === 'teacher' && (
          <select
            value={teacherId}
            onChange={(e) => setTeacherId(e.target.value)}
            className="ml-2 rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">— select teacher —</option>
            {(employees.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName}
              </option>
            ))}
          </select>
        )}
        {filterMode === 'class' && (
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="ml-2 rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">— select class —</option>
            {(classes.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.sectionCode} · {c.course.name}
              </option>
            ))}
          </select>
        )}
        {filterMode === 'room' && (
          <select
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="ml-2 rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">— select room —</option>
            {(rooms.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {schedules.isLoading || timetable.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : !defaultSchedule ? (
        <EmptyState
          title="No bell schedules"
          description="Create a default bell schedule to render the timetable grid."
        />
      ) : periods.length === 0 ? (
        <EmptyState
          title="No periods configured"
          description="Add periods to the default bell schedule to render the grid."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                <th className="w-44 px-3 py-2">Period</th>
                {DAY_LABELS.map((d) => (
                  <th key={d} className="px-3 py-2">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <PeriodRow key={p.id} period={p} slotsByPeriodAndDay={slotsByPeriodAndDay} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-campus-600 bg-campus-50 text-campus-700'
          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
      )}
    >
      {label}
    </button>
  );
}

function PeriodRow({
  period,
  slotsByPeriodAndDay,
}: {
  period: PeriodDto;
  slotsByPeriodAndDay: Map<string, TimetableSlotDto[]>;
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
        const slots = slotsByPeriodAndDay.get(`${period.id}::${d}`) ?? [];
        return (
          <td key={d} className="border-l border-gray-100 px-2 py-2 align-top">
            {slots.length === 0 ? (
              <span className="text-xs text-gray-300">—</span>
            ) : (
              <div className="space-y-1">
                {slots.map((s) => (
                  <SlotCell key={s.id} slot={s} />
                ))}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function SlotCell({ slot }: { slot: TimetableSlotDto }) {
  return (
    <div className="rounded-lg border border-campus-100 bg-campus-50 px-2 py-1.5">
      <p className="truncate text-xs font-semibold text-campus-800">{slot.classSectionCode}</p>
      <p className="truncate text-[11px] text-campus-700">{slot.courseName}</p>
      <p className="truncate text-[11px] text-gray-600">
        {slot.teacherName ?? 'TBD'} · {slot.roomName}
      </p>
    </div>
  );
}
