'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useStudent, useStudentAttendance } from '@/hooks/use-children';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/components/ui/cn';
import type { AttendanceRecord, AttendanceStatus } from '@/lib/types';

type DaySummary = 'NONE' | 'PRESENT' | 'TARDY' | 'ABSENT' | 'EXCUSED' | 'MIXED';

export default function ChildAttendancePage() {
  const params = useParams<{ id: string }>();
  const studentId = params?.id;
  const student = useStudent(studentId);

  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const monthStart = isoDate(monthCursor.year, monthCursor.month, 1);
  const monthEnd = isoDate(monthCursor.year, monthCursor.month + 1, 0);
  const att = useStudentAttendance(studentId, monthStart, monthEnd);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const byDate = useMemo(() => groupByDate(att.data ?? []), [att.data]);
  const stats = useMemo(() => computeStats(att.data ?? []), [att.data]);

  if (student.isLoading || !student.data) return <PageLoader label="Loading…" />;

  const monthLabel = new Date(monthCursor.year, monthCursor.month).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/dashboard"
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to dashboard
      </Link>

      <PageHeader
        title={`${student.data.fullName}'s attendance`}
        description={
          student.data.gradeLevel
            ? `Grade ${student.data.gradeLevel}${student.data.studentNumber ? ` · #${student.data.studentNumber}` : ''}`
            : undefined
        }
        actions={
          <Link
            href={`/children/${studentId}/absence-request`}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Report absence
          </Link>
        }
      />

      <StatsPanel stats={stats} loading={att.isLoading} />

      <div className="mt-6 rounded-card border border-gray-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">{monthLabel}</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => shiftMonth(setMonthCursor, -1)}
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm hover:bg-gray-50"
              aria-label="Previous month"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => shiftMonth(setMonthCursor, 1)}
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm hover:bg-gray-50"
              aria-label="Next month"
            >
              →
            </button>
          </div>
        </div>

        {att.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-gray-500">
            <LoadingSpinner size="sm" /> Loading month…
          </div>
        ) : (
          <CalendarGrid
            year={monthCursor.year}
            month={monthCursor.month}
            byDate={byDate}
            selectedDate={selectedDate}
            onSelect={(d) => setSelectedDate((cur) => (cur === d ? null : d))}
          />
        )}

        {selectedDate && <DayDetail date={selectedDate} rows={byDate[selectedDate] ?? []} />}
      </div>

      {!att.isLoading && (att.data ?? []).length === 0 && (
        <div className="mt-4">
          <EmptyState
            title="No attendance recorded this month"
            description="Pre-populated rows appear once a teacher opens the period."
          />
        </div>
      )}
    </div>
  );
}

// ── Calendar grid ───────────────────────────────────────────────────────

function CalendarGrid({
  year,
  month,
  byDate,
  selectedDate,
  onSelect,
}: {
  year: number;
  month: number;
  byDate: Record<string, AttendanceRecord[]>;
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay(); // 0 = Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ date: string | null; day: number | null }> = [];

  for (let i = 0; i < startWeekday; i++) cells.push({ date: null, day: null });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: isoDate(year, month, d), day: d });
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="px-3 py-3">
      <div className="grid grid-cols-7 gap-1 text-center text-xs uppercase tracking-wide text-gray-500">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((cell, idx) => {
          if (!cell.date) {
            return <div key={idx} aria-hidden className="h-12 rounded-lg" />;
          }
          const rows = byDate[cell.date] ?? [];
          const summary = summariseDay(rows);
          const isToday = cell.date === today;
          const isSelected = cell.date === selectedDate;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelect(cell.date as string)}
              className={cn(
                'relative flex h-12 flex-col items-center justify-center rounded-lg border text-sm transition-colors',
                summaryColor(summary),
                isSelected ? 'ring-2 ring-campus-500 ring-offset-1' : 'border-transparent',
                rows.length === 0 && 'border-gray-100',
                'hover:ring-1 hover:ring-campus-300',
              )}
            >
              <span className={cn('font-medium', isToday && 'underline')}>{cell.day}</span>
              {rows.length > 0 && <span className="text-[10px] opacity-80">{rows.length}p</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function summariseDay(rows: AttendanceRecord[]): DaySummary {
  if (rows.length === 0) return 'NONE';
  if (rows.some((r) => r.status === 'ABSENT')) return 'ABSENT';
  if (rows.some((r) => r.status === 'TARDY')) return 'TARDY';
  if (rows.some((r) => r.status === 'EXCUSED')) return 'EXCUSED';
  if (rows.every((r) => r.status === 'PRESENT')) return 'PRESENT';
  return 'MIXED';
}

function summaryColor(s: DaySummary): string {
  switch (s) {
    case 'PRESENT':
      return 'bg-status-present-soft text-status-present-text';
    case 'TARDY':
      return 'bg-status-tardy-soft text-status-tardy-text';
    case 'ABSENT':
      return 'bg-status-absent-soft text-status-absent-text';
    case 'EXCUSED':
      return 'bg-status-excused-soft text-status-excused-text';
    case 'MIXED':
      return 'bg-status-tardy-soft text-status-tardy-text';
    case 'NONE':
    default:
      return 'bg-gray-50 text-gray-500';
  }
}

// ── Day detail ──────────────────────────────────────────────────────────

function DayDetail({ date, rows }: { date: string; rows: AttendanceRecord[] }) {
  const label = new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    <div className="border-t border-gray-100 px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">No periods recorded for this day.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows
            .sort((a, b) => a.period.localeCompare(b.period))
            .map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2"
              >
                <div className="text-sm text-gray-700">
                  Period {r.period}
                  {r.parentExplanation ? (
                    <span className="ml-2 text-xs text-gray-500">— {r.parentExplanation}</span>
                  ) : null}
                </div>
                <StatusPill status={r.status as AttendanceStatus} />
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: AttendanceStatus }) {
  const styles: Record<string, string> = {
    PRESENT: 'bg-status-present-soft text-status-present-text',
    TARDY: 'bg-status-tardy-soft text-status-tardy-text',
    ABSENT: 'bg-status-absent-soft text-status-absent-text',
    EXCUSED: 'bg-status-excused-soft text-status-excused-text',
    EARLY_DEPARTURE: 'bg-status-tardy-soft text-status-tardy-text',
  };
  const labels: Record<string, string> = {
    PRESENT: 'Present',
    TARDY: 'Tardy',
    ABSENT: 'Absent',
    EXCUSED: 'Excused',
    EARLY_DEPARTURE: 'Left early',
  };
  return (
    <span
      className={cn(
        'whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        styles[status] || 'bg-gray-100 text-gray-700',
      )}
    >
      {labels[status] || status}
    </span>
  );
}

// ── Stats panel ─────────────────────────────────────────────────────────

interface Stats {
  total: number;
  present: number;
  tardy: number;
  absent: number;
  excused: number;
  rate: string;
}

function computeStats(rows: AttendanceRecord[]): Stats {
  const total = rows.length;
  const present = rows.filter((r) => r.status === 'PRESENT').length;
  const tardy = rows.filter((r) => r.status === 'TARDY').length;
  const absent = rows.filter((r) => r.status === 'ABSENT').length;
  const excused = rows.filter((r) => r.status === 'EXCUSED').length;
  const inAttendance = present + tardy + excused;
  const rate = total === 0 ? '—' : `${Math.round((inAttendance / total) * 100)}%`;
  return { total, present, tardy, absent, excused, rate };
}

function StatsPanel({ stats, loading }: { stats: Stats; loading: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard label="Attendance rate" value={loading ? '…' : stats.rate} />
      <StatCard
        label="Periods present"
        value={loading ? '…' : (stats.present + stats.tardy + stats.excused).toString()}
      />
      <StatCard label="Tardies" value={loading ? '…' : stats.tardy.toString()} accent="tardy" />
      <StatCard label="Absences" value={loading ? '…' : stats.absent.toString()} accent="absent" />
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'tardy' | 'absent';
}) {
  const accentClass =
    accent === 'tardy'
      ? 'text-status-tardy-text'
      : accent === 'absent'
        ? 'text-status-absent-text'
        : 'text-campus-700';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-5 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={cn('mt-2 text-3xl font-semibold', accentClass)}>{value}</p>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function isoDate(year: number, month: number, day: number): string {
  // month is 0-based for the JS Date constructor; produces a UTC midnight ISO date.
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function shiftMonth(
  setter: (fn: (prev: { year: number; month: number }) => { year: number; month: number }) => void,
  delta: number,
) {
  setter((prev) => {
    const d = new Date(prev.year, prev.month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
}

function groupByDate(rows: AttendanceRecord[]): Record<string, AttendanceRecord[]> {
  const out: Record<string, AttendanceRecord[]> = {};
  for (const r of rows) {
    (out[r.date] ||= []).push(r);
  }
  return out;
}
