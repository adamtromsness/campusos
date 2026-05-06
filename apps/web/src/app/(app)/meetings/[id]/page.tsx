'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useAgenda,
  useApproveNotes,
  useCreateActionItem,
  useCreateRecording,
  useGiveConsent,
  useIepMeetingRecord,
  useMeeting,
  useMeetingActionItems,
  useMeetingNotes,
  useRecording,
  useUpdateActionItem,
  useUpsertMeetingNotes,
} from '@/hooks/use-meetings';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import type { ActionItemStatus, MeetingNotesDto } from '@/lib/types';

const STATUS_PILL: Record<string, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

const ACTION_PILL: Record<ActionItemStatus, string> = {
  OPEN: 'bg-rose-100 text-rose-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  DONE: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function MeetingDetailPage() {
  const params = useParams();
  const meetingId = String(params.id);
  const user = useAuthStore((s) => s.user);

  const { data: meeting } = useMeeting(meetingId);
  const { data: agenda } = useAgenda(meetingId);
  const { data: notes } = useMeetingNotes(meetingId);
  const { data: actionItems } = useMeetingActionItems(meetingId);
  const { data: recording } = useRecording(meetingId);

  const isStaffOrAdmin = user?.personType === 'STAFF' || hasAnyPermission(user, ['sch-001:admin']);
  const isOrganiser = !!user && meeting?.organiserId === user.id;
  const canEdit = isOrganiser || hasAnyPermission(user, ['sch-001:admin']);

  // IEP records require hlt-001:read or admin
  const canSeeIep = hasAnyPermission(user, ['sch-001:admin', 'hlt-001:read']);
  const isIepMeeting = meeting?.meetingTypeName === 'IEP Review';
  const { data: iepRecord } = useIepMeetingRecord(
    isIepMeeting && canSeeIep ? meetingId : null,
    isIepMeeting && canSeeIep,
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title={meeting?.title ?? 'Meeting'}
        description={meeting?.description ?? ''}
        actions={
          <Link
            href="/meetings"
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            ← All meetings
          </Link>
        }
      />

      {meeting && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase text-gray-500">Type</dt>
              <dd className="text-gray-900">{meeting.meetingTypeName ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">When</dt>
              <dd className="text-gray-900">
                {formatDateTime(meeting.scheduledAt)} · {meeting.durationMinutes} min
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Status</dt>
              <dd>
                <span
                  className={
                    'rounded-full px-2 py-0.5 text-xs font-semibold ' +
                    (STATUS_PILL[meeting.status] ?? 'bg-gray-100 text-gray-700')
                  }
                >
                  {meeting.status.replace(/_/g, ' ')}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Organiser</dt>
              <dd className="text-gray-900">{meeting.organiserName ?? '—'}</dd>
            </div>
          </dl>
          {meeting.meetingUrl && (
            <p className="mt-3 text-sm">
              <a
                href={meeting.meetingUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-campus-700 hover:underline"
              >
                Join video call →
              </a>
            </p>
          )}
        </div>
      )}

      {/* Participants */}
      {meeting && meeting.participants && meeting.participants.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold text-gray-900">Participants</h2>
          <div className="flex flex-wrap gap-2">
            {meeting.participants.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700"
              >
                {p.participantName ?? 'Unknown'}
                <span className="text-[10px] text-gray-500">({p.role})</span>
                {p.attended && <span className="text-[10px] text-emerald-700">✓ attended</span>}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Agenda */}
      {agenda && agenda.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold text-gray-900">Agenda</h2>
          <ol className="space-y-2 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            {agenda.map((a) => (
              <li key={a.id} className="text-sm">
                <span className="text-xs text-gray-400">#{a.sortOrder + 1}</span>{' '}
                <span className="font-semibold text-gray-900">{a.title}</span>
                {a.durationMinutes && (
                  <span className="ml-2 text-xs text-gray-500">{a.durationMinutes} min</span>
                )}
                {a.presenterName && (
                  <span className="ml-2 text-xs text-gray-500">by {a.presenterName}</span>
                )}
                {a.description && <p className="mt-1 text-sm text-gray-600">{a.description}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Notes panel — parent-visibility gate applied server-side */}
      <NotesPanel
        meetingId={meetingId}
        notes={notes ?? null}
        canEdit={canEdit && isStaffOrAdmin}
        isIepMeeting={isIepMeeting}
      />

      {/* Action items */}
      <ActionItemsPanel
        meetingId={meetingId}
        items={actionItems ?? []}
        canCreate={canEdit && isStaffOrAdmin}
      />

      {/* Recording panel */}
      <RecordingPanel
        meetingId={meetingId}
        recording={recording ?? null}
        canCreate={canEdit && isStaffOrAdmin}
      />

      {/* IEP record */}
      {isIepMeeting && canSeeIep && (
        <section>
          <h2 className="mb-2 text-lg font-semibold text-gray-900">IEP record</h2>
          {iepRecord ? (
            <div className="rounded-lg border border-violet-200 bg-violet-50 p-4 text-sm">
              <p>
                <span className="font-semibold text-violet-900">Student:</span>{' '}
                {iepRecord.studentName ?? iepRecord.studentId}
              </p>
              {iepRecord.iepPlanType && (
                <p className="text-violet-900">
                  <span className="font-semibold">Linked plan:</span> {iepRecord.iepPlanType}
                  {iepRecord.iepPlanStatus ? ' (' + iepRecord.iepPlanStatus + ')' : ''}
                </p>
              )}
              {iepRecord.outcomesSummary && (
                <p className="mt-2 text-violet-900">{iepRecord.outcomesSummary}</p>
              )}
              {iepRecord.nextReviewDate && (
                <p className="mt-2 text-xs text-violet-700">
                  Next review: {iepRecord.nextReviewDate}
                </p>
              )}
              {iepRecord.attendeeRoles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {iepRecord.attendeeRoles.map((a, i) => (
                    <span
                      key={i}
                      className="rounded-full bg-violet-200 px-2 py-0.5 text-xs font-semibold text-violet-900"
                    >
                      {a.name} — {a.role}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              title="No IEP record yet"
              description="Counsellor or admin can create an IEP meeting record from this meeting."
            />
          )}
        </section>
      )}
    </div>
  );
}

function NotesPanel({
  meetingId,
  notes,
  canEdit,
  isIepMeeting,
}: {
  meetingId: string;
  notes: MeetingNotesDto | null;
  canEdit: boolean;
  isIepMeeting: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [notesText, setNotesText] = useState(notes?.notesText ?? '');
  const [parentVisible, setParentVisible] = useState(notes?.isParentVisible ?? false);
  const [parentSummary, setParentSummary] = useState(notes?.parentVisibleSummary ?? '');
  const upsert = useUpsertMeetingNotes(meetingId);
  const approve = useApproveNotes(meetingId);
  const { toast } = useToast();

  // Sync local state when notes load/change
  useEffect(() => {
    if (notes && !editing) {
      setNotesText(notes.notesText ?? '');
      setParentVisible(notes.isParentVisible);
      setParentSummary(notes.parentVisibleSummary ?? '');
    }
  }, [notes, editing]);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold text-gray-900">Meeting notes</h2>
      {!notes && !canEdit && (
        <EmptyState title="No notes available" description="Notes have not been written yet." />
      )}

      {notes && !editing && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {notes.isApproved ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
                Approved
                {notes.approvedByName ? ' — ' + notes.approvedByName : ''}
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                Pending approval
              </span>
            )}
            {notes.isParentVisible && (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-800">
                Parent-visible
              </span>
            )}
          </div>
          {notes.parentVisibleSummary && !notes.notesText && (
            <p className="text-xs text-gray-500">
              You are seeing the parent-visible summary. Full notes stay with the staff team.
            </p>
          )}
          <div className="mt-2 whitespace-pre-wrap text-sm text-gray-800">
            {notes.parentVisibleSummary && !notes.notesText
              ? notes.parentVisibleSummary
              : (notes.notesText ?? <em className="text-gray-400">[no notes content]</em>)}
          </div>
          {canEdit && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Edit
              </button>
              {!notes.isApproved && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Approving locks the notes. They become visible to parents (when is_parent_visible=true) and cannot be unapproved. Continue?',
                      )
                    ) {
                      approve.mutate(notes.id, {
                        onSuccess: () => toast('Notes approved', 'success'),
                        onError: (err) =>
                          toast(
                            'Failed to approve: ' +
                              (err instanceof Error ? err.message : 'unknown'),
                            'error',
                          ),
                      });
                    }
                  }}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800"
                >
                  Approve
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {(editing || (canEdit && !notes)) && (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div>
            <label className="block text-sm font-medium text-gray-700">Notes (staff)</label>
            <textarea
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              rows={6}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm"
              placeholder="Internal staff notes — confidential."
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={parentVisible}
              onChange={(e) => setParentVisible(e.target.checked)}
            />
            Show notes to parent (after approval)
          </label>
          {parentVisible && (
            <div className="rounded-md border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
              Once approved, the parent will see either this summary or the full staff notes.
            </div>
          )}
          {parentVisible && (
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Parent-facing summary (optional)
              </label>
              <textarea
                value={parentSummary}
                onChange={(e) => setParentSummary(e.target.value)}
                rows={3}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm"
                placeholder="A separate summary the parent will see instead of the full staff notes."
              />
            </div>
          )}
          {isIepMeeting && (
            <div className="rounded-md border-l-4 border-rose-500 bg-rose-50 p-3 text-sm text-rose-900">
              IEP meeting. Health-sensitive content should usually stay staff-side. Consider keeping
              parent-visible off and writing a separate parent summary email instead.
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                upsert.mutate(
                  {
                    notesText: notesText || undefined,
                    isParentVisible: parentVisible,
                    parentVisibleSummary: parentSummary || undefined,
                  },
                  {
                    onSuccess: () => {
                      toast('Notes saved', 'success');
                      setEditing(false);
                    },
                    onError: (err) =>
                      toast(
                        'Failed to save notes: ' + (err instanceof Error ? err.message : 'unknown'),
                        'error',
                      ),
                  },
                )
              }
              disabled={upsert.isPending}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {upsert.isPending ? 'Saving…' : 'Save notes'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ActionItemsPanel({
  meetingId,
  items,
  canCreate,
}: {
  meetingId: string;
  items: {
    id: string;
    description: string;
    status: ActionItemStatus;
    assigneeId: string;
    assigneeName: string | null;
    dueDate: string | null;
  }[];
  canCreate: boolean;
}) {
  const user = useAuthStore((s) => s.user);
  const [createOpen, setCreateOpen] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const create = useCreateActionItem(meetingId);
  const update = useUpdateActionItem();
  const { toast } = useToast();

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Action items</h2>
        {canCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-800"
          >
            Add action item
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyState
          title="No action items yet"
          description="Action items track follow-ups assigned to staff or parents."
        />
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white shadow-sm">
          {items.map((a) => {
            const isMine = !!user && a.assigneeId === user.id;
            return (
              <li key={a.id} className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-xs font-semibold ' + ACTION_PILL[a.status]
                      }
                    >
                      {a.status.replace(/_/g, ' ')}
                    </span>
                    {isMine && (
                      <span className="rounded-full bg-campus-100 px-2 py-0.5 text-xs font-semibold text-campus-800">
                        Assigned to you
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-gray-800">{a.description}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {a.assigneeName ?? a.assigneeId}
                    {a.dueDate ? ' · due ' + a.dueDate : ''}
                  </p>
                </div>
                {isMine && a.status !== 'DONE' && a.status !== 'CANCELLED' && (
                  <button
                    type="button"
                    onClick={() =>
                      update.mutate(
                        { id: a.id, input: { status: 'DONE' } },
                        {
                          onSuccess: () => toast('Marked done', 'success'),
                          onError: (err) =>
                            toast(
                              'Failed to update: ' +
                                (err instanceof Error ? err.message : 'unknown'),
                              'error',
                            ),
                        },
                      )
                    }
                    className="shrink-0 rounded-md border border-emerald-700 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                  >
                    Mark done
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {createOpen && (
        <Modal
          open
          onClose={() => setCreateOpen(false)}
          title="Add action item"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!assigneeId || !description || create.isPending}
                onClick={() =>
                  create.mutate(
                    {
                      assigneeId,
                      description,
                      dueDate: dueDate || undefined,
                    },
                    {
                      onSuccess: () => {
                        toast('Action item created', 'success');
                        setCreateOpen(false);
                        setAssigneeId('');
                        setDescription('');
                        setDueDate('');
                      },
                      onError: (err) =>
                        toast(
                          'Failed to create: ' + (err instanceof Error ? err.message : 'unknown'),
                          'error',
                        ),
                    },
                  )
                }
                className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Assignee (platform user UUID)
              </label>
              <input
                type="text"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm shadow-sm"
                placeholder="UUID — staff or parent"
              />
              <p className="mt-1 text-xs text-gray-500">
                Use the participant&apos;s platform user id. Parents can be assignees.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Due date (optional)</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm"
              />
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function RecordingPanel({
  meetingId,
  recording,
  canCreate,
}: {
  meetingId: string;
  recording: import('@/lib/types').RecordingDto | null;
  canCreate: boolean;
}) {
  const create = useCreateRecording(meetingId);
  const consent = useGiveConsent(meetingId);
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);

  const myConsent = useMemo(() => {
    if (!recording || !user) return null;
    return recording.consents?.find((c) => c.participantId === user.id) ?? null;
  }, [recording, user]);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold text-gray-900">Recording</h2>
      {!recording && !canCreate && (
        <EmptyState
          title="No recording for this meeting"
          description="If a recording was made, it will appear here once uploaded."
        />
      )}
      {!recording && canCreate && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-700">
            No recording yet. Use the placeholder below to register a recording row. Actual upload
            integration is deferred to the video processing service.
          </p>
          <button
            type="button"
            onClick={() =>
              create.mutate(
                {},
                {
                  onSuccess: () => toast('Recording placeholder created', 'success'),
                  onError: (err) =>
                    toast('Failed: ' + (err instanceof Error ? err.message : 'unknown'), 'error'),
                },
              )
            }
            className="mt-3 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-800"
          >
            Register recording
          </button>
        </div>
      )}
      {recording && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-semibold ' +
                (recording.status === 'AVAILABLE'
                  ? 'bg-emerald-100 text-emerald-800'
                  : recording.status === 'FAILED'
                    ? 'bg-rose-100 text-rose-800'
                    : 'bg-amber-100 text-amber-800')
              }
            >
              {recording.status}
            </span>
            <span className="text-xs text-gray-500">
              {recording.consentedCount ?? 0} of {recording.totalParticipants ?? 0} consented
            </span>
            {recording.consentConfirmed ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                Consent confirmed
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                Awaiting consent
              </span>
            )}
          </div>
          {recording.consentConfirmed && recording.signedUrl && (
            <p className="mt-2 text-sm">
              <a
                href={recording.signedUrl}
                className="font-semibold text-campus-700 hover:underline"
              >
                Play recording →
              </a>
            </p>
          )}
          {!recording.consentConfirmed && (
            <p className="mt-2 text-sm text-gray-600">
              The recording is available once every meeting participant consents.
            </p>
          )}
          {/* Consent action */}
          {!myConsent && user && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold">This meeting was recorded.</p>
              <p className="mt-1">
                Do you consent to the recording being stored and accessible to meeting participants?
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    consent.mutate(
                      { recordingId: recording.id, input: { consentGiven: true } },
                      {
                        onSuccess: () => toast('Consent recorded', 'success'),
                        onError: (err) =>
                          toast(
                            'Failed: ' + (err instanceof Error ? err.message : 'unknown'),
                            'error',
                          ),
                      },
                    )
                  }
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800"
                >
                  I consent
                </button>
                <button
                  type="button"
                  onClick={() =>
                    consent.mutate(
                      { recordingId: recording.id, input: { consentGiven: false } },
                      {
                        onSuccess: () => toast('Decline recorded', 'success'),
                      },
                    )
                  }
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  Decline
                </button>
              </div>
            </div>
          )}
          {myConsent && (
            <p className="mt-2 text-xs text-gray-500">
              You {myConsent.consentGiven ? 'consented' : 'declined'} on{' '}
              {new Date(myConsent.consentedAt).toLocaleDateString()}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
