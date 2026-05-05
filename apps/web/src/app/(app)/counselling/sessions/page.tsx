'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useLockSessionNote,
  useSession,
  useSessionNotes,
  useSessions,
} from '@/hooks/use-counselling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUS_PILL,
  SESSION_STATUS_LABELS,
  SESSION_STATUS_PILL,
  SESSION_TYPE_LABELS,
  SESSION_TYPE_PILL,
  formatDateOnly,
  formatDateTime,
  studentDisplay,
} from '@/lib/counselling-format';
import type { SessionDto, SessionStatus, SessionType } from '@/lib/types';

const STATUS_CHIPS: Array<{ value: SessionStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'NO_SHOW', label: 'No-show' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const TYPE_CHIPS: Array<{ value: SessionType | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'Any type' },
  { value: 'INDIVIDUAL', label: 'Individual' },
  { value: 'GROUP', label: 'Group' },
  { value: 'CRISIS', label: 'Crisis' },
  { value: 'CHECK_IN', label: 'Check-in' },
  { value: 'PARENT_MEETING', label: 'Parent meeting' },
  { value: 'CONSULTATION', label: 'Consultation' },
];

export default function SessionsLogPage() {
  const { user } = useAuthStore();
  const isCounsellor = hasAnyPermission(user, ['cou-001:write']);
  const hasFerpa = hasAnyPermission(user, ['student_counseling_record:read']);
  const [statusChip, setStatusChip] = useState<SessionStatus | 'ALL'>('ALL');
  const [typeChip, setTypeChip] = useState<SessionType | 'ALL'>('ALL');
  const [openId, setOpenId] = useState<string | null>(null);

  const sessionsQ = useSessions({});
  const sorted = useMemo(() => {
    let list = sessionsQ.data ?? [];
    if (statusChip !== 'ALL') list = list.filter((s) => s.status === statusChip);
    if (typeChip !== 'ALL') list = list.filter((s) => s.sessionType === typeChip);
    return [...list].sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));
  }, [sessionsQ.data, statusChip, typeChip]);

  return (
    <div>
      <PageHeader
        title="Session log"
        description={
          isCounsellor
            ? 'Counselling sessions for your caseload.'
            : 'Counselling sessions across the school.'
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setStatusChip(c.value)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium',
              statusChip === c.value
                ? 'border-campus-300 bg-campus-100 text-campus-900'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {TYPE_CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setTypeChip(c.value)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
              typeChip === c.value
                ? 'border-violet-300 bg-violet-100 text-violet-900'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {sessionsQ.isLoading ? (
        <LoadingSpinner />
      ) : sorted.length === 0 ? (
        <EmptyState title="No sessions" description="Nothing to show for the selected filters." />
      ) : (
        <ul className="space-y-2">
          {sorted.map((s) => (
            <SessionRow key={s.id} session={s} onClick={() => setOpenId(s.id)} />
          ))}
        </ul>
      )}

      {openId ? (
        <SessionDetailModal
          sessionId={openId}
          hasFerpa={hasFerpa}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

function SessionRow({ session, onClick }: { session: SessionDto; onClick: () => void }) {
  return (
    <li
      className="flex cursor-pointer flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white p-3 hover:border-campus-300"
      onClick={onClick}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-900">
          {formatDateOnly(session.sessionDate)}
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            SESSION_TYPE_PILL[session.sessionType],
          )}
        >
          {SESSION_TYPE_LABELS[session.sessionType]}
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            SESSION_STATUS_PILL[session.status],
          )}
        >
          {SESSION_STATUS_LABELS[session.status]}
        </span>
        {session.durationMinutes ? (
          <span className="text-xs text-gray-500">{session.durationMinutes} min</span>
        ) : null}
      </div>
      <div className="text-xs text-gray-500">
        {session.primaryStudentName ?? 'GROUP / multiple participants'}
      </div>
    </li>
  );
}

function SessionDetailModal({
  sessionId,
  hasFerpa,
  onClose,
}: {
  sessionId: string;
  hasFerpa: boolean;
  onClose: () => void;
}) {
  const sessionQ = useSession(sessionId);
  const notesQ = useSessionNotes(sessionId, hasFerpa);
  const session = sessionQ.data;
  if (!session) {
    return (
      <Modal open={true} onClose={onClose} title="Session" size="lg">
        <LoadingSpinner />
      </Modal>
    );
  }
  return (
    <Modal open={true} onClose={onClose} title="Session detail" size="lg">
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-base font-semibold text-gray-900">
              {session.primaryStudentName ?? 'Group session'}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  SESSION_TYPE_PILL[session.sessionType],
                )}
              >
                {SESSION_TYPE_LABELS[session.sessionType]}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  SESSION_STATUS_PILL[session.status],
                )}
              >
                {SESSION_STATUS_LABELS[session.status]}
              </span>
            </div>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            {formatDateOnly(session.sessionDate)}
            {session.durationMinutes ? ' · ' + session.durationMinutes + ' min' : ''}
            {session.counselorName ? ' · ' + session.counselorName : ''}
          </div>
        </div>

        {session.notes ? (
          <div className="rounded border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
            <div className="text-xs font-semibold uppercase text-gray-500">
              Session notes (logistics)
            </div>
            <div className="mt-1 whitespace-pre-wrap">{session.notes}</div>
          </div>
        ) : null}

        <div>
          <div className="text-xs font-semibold uppercase text-gray-500">Participants</div>
          {(session.participants ?? []).length === 0 ? (
            <div className="mt-1 text-sm text-gray-500">
              No participants recorded — this is an INDIVIDUAL session linked to a primary caseload.
            </div>
          ) : (
            <ul className="mt-2 space-y-1">
              {(session.participants ?? []).map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded border border-gray-100 bg-white p-2 text-sm"
                >
                  <span className="text-gray-900">
                    {studentDisplay(p.studentFirstName, p.studentLastName)}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      ATTENDANCE_STATUS_PILL[p.attendanceStatus],
                    )}
                  >
                    {ATTENDANCE_STATUS_LABELS[p.attendanceStatus]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* FERPA-gated notes panel */}
        <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
          <div className="flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase text-violet-700">
              Session notes (FERPA-protected)
            </div>
          </div>
          {!hasFerpa ? (
            <p className="mt-2 text-sm text-violet-900">
              Session notes are restricted to the counselling team. Teachers and parents see only
              that the session occurred — not its content.
            </p>
          ) : notesQ.isLoading ? (
            <LoadingSpinner />
          ) : notesQ.isError ? (
            <p className="mt-2 text-sm text-rose-700">
              Failed to load notes — you may not have access.
            </p>
          ) : (notesQ.data ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-violet-900">No notes recorded for this session yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {(notesQ.data ?? []).map((n) => (
                <li key={n.id} className="rounded border border-violet-100 bg-white p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900">
                      {studentDisplay(n.studentFirstName, n.studentLastName)}
                    </span>
                    <span className="flex items-center gap-2 text-[11px]">
                      {n.followUpRequired ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">
                          Follow-up required
                        </span>
                      ) : null}
                      {n.isLocked ? (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 font-medium text-gray-700">
                          Locked
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">
                          Editable
                        </span>
                      )}
                    </span>
                  </div>
                  {n.goalsAddressed && n.goalsAddressed.length > 0 ? (
                    <div className="mt-1 text-xs text-gray-500">
                      Goals: {n.goalsAddressed.join(' · ')}
                    </div>
                  ) : null}
                  <div className="mt-2 whitespace-pre-wrap text-gray-800">{n.notesText}</div>
                  {n.isLocked ? (
                    <div className="mt-2 text-[11px] text-gray-500">
                      Locked by {n.lockedByName ?? 'Unknown'} on {formatDateTime(n.lockedAt)} —
                      immutable.
                    </div>
                  ) : (
                    <LockNoteButton noteId={n.id} sessionId={session.id} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function LockNoteButton({ noteId, sessionId }: { noteId: string; sessionId: string }) {
  const { toast } = useToast();
  const lock = useLockSessionNote(noteId, sessionId);
  return (
    <button
      type="button"
      className="mt-2 rounded-md border border-violet-300 px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
      disabled={lock.isPending}
      onClick={async () => {
        if (
          !window.confirm(
            'Lock this note? Locking is irreversible — the note becomes immutable forever and corrections must go on a follow-up session.',
          )
        )
          return;
        try {
          await lock.mutateAsync();
          toast('Note locked', 'success');
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Failed to lock', 'error');
        }
      }}
    >
      {lock.isPending ? 'Locking…' : 'Lock note (irreversible)'}
    </button>
  );
}
