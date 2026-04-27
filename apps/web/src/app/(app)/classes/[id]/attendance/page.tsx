'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useBatchSubmitAttendance, useClass, useClassAttendance } from '@/hooks/use-attendance';
import { ClassTabs } from '@/components/classroom/ClassTabs';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Avatar } from '@/components/ui/Avatar';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import type { AttendanceRecord, AttendanceStatus, BatchAttendanceEntry } from '@/lib/types';

type Override = { status: AttendanceStatus; note: string };
type OverrideMap = Record<string, Override>;

const STATUS_OPTIONS: { value: AttendanceStatus; label: string; short: string }[] = [
  { value: 'PRESENT', label: 'Present', short: 'P' },
  { value: 'TARDY', label: 'Tardy', short: 'T' },
  { value: 'ABSENT', label: 'Absent', short: 'A' },
  { value: 'EXCUSED', label: 'Excused', short: 'E' },
];

export default function ClassAttendancePage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  const classId = params?.id;
  const today = new Date().toISOString().slice(0, 10);
  const date = search?.get('date') || today;

  const classQuery = useClass(classId);
  const period = classQuery.data?.sectionCode;
  const attendanceQuery = useClassAttendance(classId, date, period);
  const submit = useBatchSubmitAttendance(classId ?? '', date);

  const [overrides, setOverrides] = useState<OverrideMap>({});
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Reset overrides whenever the class+date+period changes (e.g. navigating dates).
  useEffect(() => {
    setOverrides({});
    setConfirmOpen(false);
  }, [classId, date, period]);

  if (classQuery.isLoading || !classQuery.data) {
    return <PageLoader label="Loading class…" />;
  }

  const cls = classQuery.data;
  const records = attendanceQuery.data ?? [];
  const allConfirmed =
    records.length > 0 && records.every((r) => r.confirmationStatus === 'CONFIRMED');
  const locked = allConfirmed;
  const teacherName = cls.teachers[0]?.fullName ?? 'Unassigned';

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/dashboard"
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to dashboard
      </Link>

      <PageHeader
        title={cls.course.name}
        description={`Period ${cls.sectionCode} · ${teacherName}${cls.room ? ` · Room ${cls.room}` : ''}`}
        actions={
          <input
            type="date"
            value={date}
            onChange={(e) => {
              const next = e.target.value || today;
              const qs = next === today ? '' : `?date=${next}`;
              router.replace(`/classes/${classId}/attendance${qs}`);
            }}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-campus-400 focus:outline-none"
          />
        }
      />

      <ClassTabs classId={classId!} active="attendance" />

      {locked && <SubmittedBanner records={records} />}

      {!locked && records.length > 0 && <PreSubmitBanner totalStudents={records.length} />}

      {attendanceQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          Loading roster…
        </div>
      ) : records.length === 0 ? (
        <EmptyState
          title="No students enrolled"
          description="There are no active enrollments for this class period."
        />
      ) : (
        <RosterTable
          records={records}
          overrides={overrides}
          locked={locked}
          onChangeStatus={(r, status) =>
            setOverrides((prev) => withOverride(prev, r, { status, note: prev[r.id]?.note ?? '' }))
          }
          onChangeNote={(r, note) =>
            setOverrides((prev) =>
              withOverride(prev, r, {
                status: prev[r.id]?.status ?? (r.status as AttendanceStatus),
                note,
              }),
            )
          }
        />
      )}

      {!locked && records.length > 0 && (
        <SubmitBar
          records={records}
          overrides={overrides}
          submitting={submit.isPending}
          onSubmit={() => setConfirmOpen(true)}
        />
      )}

      {!locked && (
        <ConfirmSubmitModal
          open={confirmOpen}
          records={records}
          overrides={overrides}
          submitting={submit.isPending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            const entries = buildBatchEntries(records, overrides);
            try {
              const result = await submit.mutateAsync({ period: period!, records: entries });
              toast(
                `Attendance submitted — ${result.tardyCount} tardy, ${result.absentCount} absent`,
                'success',
              );
              setOverrides({});
              setConfirmOpen(false);
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Failed to submit attendance';
              toast(msg, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

interface ConfirmSubmitModalProps {
  open: boolean;
  records: AttendanceRecord[];
  overrides: OverrideMap;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmSubmitModal({
  open,
  records,
  overrides,
  submitting,
  onCancel,
  onConfirm,
}: ConfirmSubmitModalProps) {
  const counts = countByStatus(records, overrides);
  const exceptions = formatExceptions(counts);
  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onCancel}
      title="Submit attendance?"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <LoadingSpinner size="sm" className="border-white/40 border-t-white" />}
            Confirm submit
          </button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-gray-700">
        <p>
          <span className="font-medium">{records.length}</span> students ·{' '}
          <span className="font-medium">{counts.PRESENT}</span> present
          {exceptions ? <> · {exceptions}</> : null}.
        </p>
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
          Once submitted, attendance is locked. Changes to confirmed records require an
          administrator override.
        </p>
      </div>
    </Modal>
  );
}

function PreSubmitBanner({ totalStudents }: { totalStudents: number }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-card border border-campus-200 bg-campus-50 px-4 py-3 text-sm">
      <span aria-hidden className="mt-0.5">
        ✏️
      </span>
      <div>
        <p className="font-medium text-campus-700">Take attendance — {totalStudents} students</p>
        <p className="mt-0.5 text-xs text-gray-600">
          Default is Present. Tap a row to mark Tardy / Absent / Excused, then use the Submit button
          at the bottom to confirm.
        </p>
      </div>
    </div>
  );
}

// ── Roster table ─────────────────────────────────────────────────────────

interface RosterTableProps {
  records: AttendanceRecord[];
  overrides: OverrideMap;
  locked: boolean;
  onChangeStatus: (record: AttendanceRecord, status: AttendanceStatus) => void;
  onChangeNote: (record: AttendanceRecord, note: string) => void;
}

function RosterTable({
  records,
  overrides,
  locked,
  onChangeStatus,
  onChangeNote,
}: RosterTableProps) {
  return (
    <ul className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      {records.map((r) => {
        const ov = overrides[r.id];
        const status = (ov?.status ?? (r.status as AttendanceStatus)) as AttendanceStatus;
        const note = ov?.note ?? r.parentExplanation ?? '';
        return (
          <li
            key={r.id}
            className={cn(
              'border-b border-gray-100 last:border-b-0 transition-colors',
              status === 'TARDY' && 'bg-status-tardy-soft/40',
              status === 'ABSENT' && 'bg-status-absent-soft/40',
              status === 'EXCUSED' && 'bg-status-excused-soft/40',
            )}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <Avatar name={r.fullName} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{r.fullName}</p>
                {r.studentNumber && <p className="text-xs text-gray-400">#{r.studentNumber}</p>}
              </div>
              <StatusButtonGroup
                value={status}
                disabled={locked}
                onChange={(next) => onChangeStatus(r, next)}
              />
            </div>
            {status !== 'PRESENT' && (
              <div className="px-4 pb-3">
                <input
                  type="text"
                  value={note}
                  disabled={locked}
                  placeholder={notePlaceholder(status)}
                  onChange={(e) => onChangeNote(r, e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-400 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StatusButtonGroup({
  value,
  disabled,
  onChange,
}: {
  value: AttendanceStatus;
  disabled: boolean;
  onChange: (next: AttendanceStatus) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-gray-200 text-xs font-medium">
      {STATUS_OPTIONS.map((opt) => {
        const active = opt.value === value;
        const palette = activeColor(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            aria-label={opt.label}
            title={opt.label}
            className={cn(
              'flex h-9 w-10 items-center justify-center border-l border-gray-200 first:border-l-0 transition-colors disabled:cursor-not-allowed',
              active ? palette : 'bg-white text-gray-500 hover:bg-gray-50',
              disabled && 'opacity-60',
            )}
          >
            {opt.short}
          </button>
        );
      })}
    </div>
  );
}

function activeColor(status: AttendanceStatus): string {
  switch (status) {
    case 'PRESENT':
      return 'bg-status-present-soft text-status-present-text';
    case 'TARDY':
      return 'bg-status-tardy-soft text-status-tardy-text';
    case 'ABSENT':
      return 'bg-status-absent-soft text-status-absent-text';
    case 'EXCUSED':
      return 'bg-status-excused-soft text-status-excused-text';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

function notePlaceholder(status: AttendanceStatus): string {
  switch (status) {
    case 'TARDY':
      return 'e.g. "arrived 8:15"';
    case 'ABSENT':
      return 'Reason for absence (optional)';
    case 'EXCUSED':
      return 'Reason — links to absence request if any';
    default:
      return 'Notes';
  }
}

// ── Submit bar ───────────────────────────────────────────────────────────

interface SubmitBarProps {
  records: AttendanceRecord[];
  overrides: OverrideMap;
  submitting: boolean;
  onSubmit: () => void;
}

function SubmitBar({ records, overrides, submitting, onSubmit }: SubmitBarProps) {
  const counts = useMemo(() => countByStatus(records, overrides), [records, overrides]);
  const exceptionCount = counts.TARDY + counts.ABSENT + counts.EXCUSED;
  const exceptionLabel = formatExceptions(counts);

  return (
    <div className="sticky bottom-4 mt-4 rounded-card border border-gray-200 bg-white/95 px-4 py-3 shadow-elevated backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-600">
          {counts.PRESENT} present
          {exceptionCount > 0 ? ` · ${exceptionLabel}` : ''}
        </div>
        <button
          type="button"
          disabled={submitting}
          onClick={onSubmit}
          className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-5 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting && <LoadingSpinner size="sm" className="border-white/40 border-t-white" />}
          {exceptionCount > 0 ? `Submit attendance — ${exceptionLabel}` : 'Submit attendance'}
        </button>
      </div>
    </div>
  );
}

function SubmittedBanner({ records }: { records: AttendanceRecord[] }) {
  const tardies = records.filter((r) => r.status === 'TARDY').length;
  const absents = records.filter((r) => r.status === 'ABSENT').length;
  const excused = records.filter((r) => r.status === 'EXCUSED').length;
  const summary =
    tardies + absents + excused === 0
      ? 'All students present'
      : [
          tardies > 0 ? `${tardies} tardy` : null,
          absents > 0 ? `${absents} absent` : null,
          excused > 0 ? `${excused} excused` : null,
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-card border border-status-present-soft bg-status-present-soft/40 px-4 py-3 text-sm">
      <div>
        <p className="font-medium text-status-present-text">Attendance submitted</p>
        <p className="text-xs text-gray-600">{summary}</p>
      </div>
      <span className="rounded-full bg-status-present-soft px-2.5 py-0.5 text-xs font-medium text-status-present-text">
        Locked
      </span>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function withOverride(prev: OverrideMap, record: AttendanceRecord, next: Override): OverrideMap {
  // Drop the override entirely if it matches the server state — keeps state clean.
  const serverStatus = record.status as AttendanceStatus;
  const serverNote = record.parentExplanation ?? '';
  if (next.status === serverStatus && (next.note || '') === serverNote) {
    if (!(record.id in prev)) return prev;
    const copy = { ...prev };
    delete copy[record.id];
    return copy;
  }
  return { ...prev, [record.id]: next };
}

function countByStatus(
  records: AttendanceRecord[],
  overrides: OverrideMap,
): Record<AttendanceStatus, number> {
  const out: Record<AttendanceStatus, number> = {
    PRESENT: 0,
    TARDY: 0,
    ABSENT: 0,
    EXCUSED: 0,
    EARLY_DEPARTURE: 0,
  };
  for (const r of records) {
    const status = (overrides[r.id]?.status ?? r.status) as AttendanceStatus;
    out[status] = (out[status] ?? 0) + 1;
  }
  return out;
}

function formatExceptions(counts: Record<AttendanceStatus, number>): string {
  const parts: string[] = [];
  if (counts.TARDY > 0) parts.push(`${counts.TARDY} tardy`);
  if (counts.ABSENT > 0) parts.push(`${counts.ABSENT} absent`);
  if (counts.EXCUSED > 0) parts.push(`${counts.EXCUSED} excused`);
  return parts.join(', ');
}

function buildBatchEntries(
  records: AttendanceRecord[],
  overrides: OverrideMap,
): BatchAttendanceEntry[] {
  const entries: BatchAttendanceEntry[] = [];
  for (const r of records) {
    const ov = overrides[r.id];
    const status = (ov?.status ?? r.status) as AttendanceStatus;
    const note = ov?.note ?? r.parentExplanation ?? '';
    if (status === 'PRESENT' && !note) continue; // exception-only payload
    const entry: BatchAttendanceEntry = { studentId: r.studentId, status };
    if (note) entry.parentExplanation = note;
    entries.push(entry);
  }
  return entries;
}
