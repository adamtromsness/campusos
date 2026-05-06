'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useAcceptTransfer,
  useCancelTransfer,
  useCreateGroupAnnouncement,
  useCreateGroupEvent,
  useDeclineTransfer,
  useGroup,
  useGroupAnnouncements,
  useGroupEvents,
  useGroupMembers,
  useGroupTransfers,
  useInitiateTransfer,
  useJoinGroup,
  useLeaveGroup,
  useMarkAnnouncementRead,
  useRsvpEvent,
} from '@/hooks/use-groups';
import { useAuthStore } from '@/lib/auth-store';
import {
  EVENT_TYPES,
  EVENT_TYPE_LABEL,
  EVENT_TYPE_PILL,
  MEMBER_STATUS_LABEL,
  MEMBER_STATUS_PILL,
  POLICY_LABEL,
  POLICY_PILL,
  ROLE_LABEL,
  ROLE_PILL,
  RSVP_LABEL,
  RSVP_PILL,
  SCOPE_LABEL,
  SCOPE_PILL,
  TRANSFER_STATUS_LABEL,
  TRANSFER_STATUS_PILL,
  formatDateTime,
  formatRelativeDate,
} from '@/lib/groups-format';
import type { GroupEventType, GroupRsvpStatus } from '@/lib/types';

export default function GroupDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const user = useAuthStore((s) => s.user);
  const groupQ = useGroup(id);
  const announcementsQ = useGroupAnnouncements(id);
  const eventsQ = useGroupEvents(id);
  const membersQ = useGroupMembers(id);
  const transfersQ = useGroupTransfers(id);

  const join = useJoinGroup(id);
  const leave = useLeaveGroup(id);
  const { toast: showToast } = useToast();

  const [tab, setTab] = useState<'feed' | 'events' | 'members' | 'transfers'>('feed');
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [showEventModal, setShowEventModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);

  if (!user) return null;
  if (groupQ.isLoading) return <LoadingSpinner />;
  if (!groupQ.data) return <EmptyState title="Group not found" />;

  const g = groupQ.data;
  const isManager =
    !!g.myMembership && (g.myMembership.role === 'OWNER' || g.myMembership.role === 'ADMIN');
  const isOwner = !!g.myMembership && g.myMembership.role === 'OWNER';

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/groups" className="mb-2 inline-block text-sm text-gray-500 hover:underline">
        ← Back to groups
      </Link>
      <PageHeader title={g.name} description={g.description ?? undefined} />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SCOPE_PILL[g.scopeType]}`}>
          {SCOPE_LABEL[g.scopeType]}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${POLICY_PILL[g.joinPolicy]}`}
        >
          {POLICY_LABEL[g.joinPolicy]}
        </span>
        {g.myMembership ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_PILL[g.myMembership.role]}`}
          >
            {ROLE_LABEL[g.myMembership.role]}
          </span>
        ) : null}
        <span className="text-xs text-gray-500">{g.memberCount} members</span>
        {g.scopeLabel ? <span className="text-xs text-gray-500">{g.scopeLabel}</span> : null}
        {g.autoDissolveAt ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
            Auto-dissolves {formatRelativeDate(g.autoDissolveAt)}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {!g.myMembership && g.joinPolicy !== 'INVITE_ONLY' ? (
            <button
              onClick={async () => {
                try {
                  const r = await join.mutateAsync({});
                  showToast(
                    r.status === 'ACTIVE' ? 'Joined!' : 'Join request submitted — pending approval',
                    'success',
                  );
                } catch (e) {
                  showToast((e as Error).message, 'error');
                }
              }}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
            >
              {g.joinPolicy === 'OPEN' ? 'Join group' : 'Request to join'}
            </button>
          ) : null}
          {g.myMembership && g.myMembership.role !== 'OWNER' ? (
            <button
              onClick={async () => {
                if (!confirm('Leave this group?')) return;
                try {
                  await leave.mutateAsync();
                  showToast('Left group', 'success');
                } catch (e) {
                  showToast((e as Error).message, 'error');
                }
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Leave
            </button>
          ) : null}
          {isOwner ? (
            <button
              onClick={() => setShowTransferModal(true)}
              className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-100"
            >
              Transfer ownership →
            </button>
          ) : null}
        </div>
      </div>

      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {(['feed', 'events', 'members', 'transfers'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t
                ? 'border-b-2 border-campus-600 text-campus-700'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {t === 'feed'
              ? 'Announcements'
              : t === 'events'
                ? 'Events'
                : t === 'members'
                  ? 'Members'
                  : 'Transfers'}
          </button>
        ))}
      </div>

      {tab === 'feed' ? (
        <FeedTab
          groupId={id}
          announcementsQ={announcementsQ}
          isManager={isManager}
          onCreate={() => setShowAnnouncementModal(true)}
        />
      ) : null}
      {tab === 'events' ? (
        <EventsTab
          groupId={id}
          eventsQ={eventsQ}
          isManager={isManager}
          onCreate={() => setShowEventModal(true)}
        />
      ) : null}
      {tab === 'members' ? <MembersTab membersQ={membersQ} /> : null}
      {tab === 'transfers' ? <TransfersTab transfersQ={transfersQ} /> : null}

      {showAnnouncementModal ? (
        <CreateAnnouncementModal groupId={id} onClose={() => setShowAnnouncementModal(false)} />
      ) : null}
      {showEventModal ? (
        <CreateEventModal groupId={id} onClose={() => setShowEventModal(false)} />
      ) : null}
      {showTransferModal && membersQ.data ? (
        <InitiateTransferModal
          groupId={id}
          members={membersQ.data}
          myMemberId={g.myMembership?.id ?? ''}
          onClose={() => setShowTransferModal(false)}
        />
      ) : null}
    </div>
  );
}

function FeedTab({
  groupId,
  announcementsQ,
  isManager,
  onCreate,
}: {
  groupId: string;
  announcementsQ: ReturnType<typeof useGroupAnnouncements>;
  isManager: boolean;
  onCreate: () => void;
}) {
  void groupId;
  const markRead = useMarkAnnouncementRead();
  const { toast: showToast } = useToast();

  if (announcementsQ.isLoading) return <LoadingSpinner />;
  const items = announcementsQ.data ?? [];

  return (
    <div>
      {isManager ? (
        <div className="mb-3 flex justify-end">
          <button
            onClick={onCreate}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Post announcement
          </button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <EmptyState title="No announcements yet" />
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li
              key={a.id}
              className={`rounded-lg border p-4 ${
                a.pinned
                  ? 'border-amber-200 bg-amber-50'
                  : a.iHaveRead
                    ? 'border-gray-200 bg-white'
                    : 'border-campus-200 bg-campus-50'
              }`}
            >
              <div className="mb-1 flex items-center justify-between">
                <h3 className="font-semibold text-gray-900">
                  {a.pinned ? '📌 ' : ''}
                  {a.title}
                </h3>
                <span className="text-xs text-gray-500">{formatDateTime(a.publishAt)}</span>
              </div>
              <p className="text-sm text-gray-600">By {a.authorName ?? 'Unknown'}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-gray-800">{a.body}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-gray-500">Read by {a.readCount}</span>
                {!a.iHaveRead ? (
                  <button
                    onClick={async () => {
                      try {
                        await markRead.mutateAsync(a.id);
                        showToast('Marked as read', 'success');
                      } catch (e) {
                        showToast((e as Error).message, 'error');
                      }
                    }}
                    className="text-xs text-campus-700 hover:underline"
                  >
                    Mark as read
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventsTab({
  groupId,
  eventsQ,
  isManager,
  onCreate,
}: {
  groupId: string;
  eventsQ: ReturnType<typeof useGroupEvents>;
  isManager: boolean;
  onCreate: () => void;
}) {
  void groupId;
  const rsvp = useRsvpEvent();
  const { toast: showToast } = useToast();

  if (eventsQ.isLoading) return <LoadingSpinner />;
  const items = eventsQ.data ?? [];

  return (
    <div>
      {isManager ? (
        <div className="mb-3 flex justify-end">
          <button
            onClick={onCreate}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            New event
          </button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <EmptyState title="No events yet" />
      ) : (
        <ul className="space-y-3">
          {items.map((ev) => (
            <li key={ev.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-gray-900">{ev.title}</h3>
                  {ev.description ? (
                    <p className="text-sm text-gray-600">{ev.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-gray-500">
                    {formatDateTime(ev.startsAt)}
                    {ev.location ? ` · ${ev.location}` : ''}
                    {ev.maxAttendees
                      ? ` · ${ev.goingCount}/${ev.maxAttendees} going`
                      : ` · ${ev.goingCount} going`}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${EVENT_TYPE_PILL[ev.eventType]}`}
                >
                  {EVENT_TYPE_LABEL[ev.eventType]}
                </span>
              </div>
              {ev.requiresRsvp ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(['GOING', 'MAYBE', 'NOT_GOING'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={async () => {
                        try {
                          await rsvp.mutateAsync({ id: ev.id, status: s });
                          showToast('RSVP saved', 'success');
                        } catch (e) {
                          showToast((e as Error).message, 'error');
                        }
                      }}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        ev.myRsvp === s
                          ? RSVP_PILL[s as GroupRsvpStatus]
                          : 'border-gray-300 bg-white hover:bg-gray-50'
                      }`}
                    >
                      {RSVP_LABEL[s as GroupRsvpStatus]}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MembersTab({ membersQ }: { membersQ: ReturnType<typeof useGroupMembers> }) {
  if (membersQ.isLoading) return <LoadingSpinner />;
  const items = membersQ.data ?? [];
  if (items.length === 0) return <EmptyState title="No members yet" />;
  return (
    <ul className="space-y-2">
      {items.map((m) => (
        <li
          key={m.id}
          className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3 text-sm"
        >
          <div>
            <p className="font-medium text-gray-900">{m.personName ?? 'Unknown'}</p>
            <p className="text-xs text-gray-500">Joined {formatRelativeDate(m.joinedAt)}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_PILL[m.role]}`}>
              {ROLE_LABEL[m.role]}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${MEMBER_STATUS_PILL[m.status]}`}
            >
              {MEMBER_STATUS_LABEL[m.status]}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function TransfersTab({ transfersQ }: { transfersQ: ReturnType<typeof useGroupTransfers> }) {
  const accept = useAcceptTransfer();
  const decline = useDeclineTransfer();
  const cancel = useCancelTransfer();
  const { toast: showToast } = useToast();

  if (transfersQ.isLoading) return <LoadingSpinner />;
  const items = transfersQ.data ?? [];
  if (items.length === 0) return <EmptyState title="No transfer history yet" />;
  return (
    <ul className="space-y-2">
      {items.map((t) => (
        <li key={t.id} className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">
                {t.fromName} → {t.toName}
              </p>
              {t.reason ? <p className="text-xs italic text-gray-600">{t.reason}</p> : null}
              <p className="mt-1 text-xs text-gray-500">
                Initiated {formatDateTime(t.initiatedAt)}
                {t.respondedAt ? ` · responded ${formatDateTime(t.respondedAt)}` : ''}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${TRANSFER_STATUS_PILL[t.status]}`}
            >
              {TRANSFER_STATUS_LABEL[t.status]}
            </span>
          </div>
          {t.status === 'PENDING' ? (
            <div className="mt-2 flex gap-2">
              <button
                onClick={async () => {
                  try {
                    await accept.mutateAsync(t.id);
                    showToast('Ownership transferred', 'success');
                  } catch (e) {
                    showToast((e as Error).message, 'error');
                  }
                }}
                className="rounded-md bg-campus-600 px-3 py-1 text-xs font-medium text-white hover:bg-campus-700"
              >
                Accept
              </button>
              <button
                onClick={async () => {
                  try {
                    await decline.mutateAsync(t.id);
                    showToast('Declined', 'success');
                  } catch (e) {
                    showToast((e as Error).message, 'error');
                  }
                }}
                className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
              >
                Decline
              </button>
              <button
                onClick={async () => {
                  if (!confirm('Cancel this pending transfer?')) return;
                  try {
                    await cancel.mutateAsync(t.id);
                    showToast('Cancelled', 'success');
                  } catch (e) {
                    showToast((e as Error).message, 'error');
                  }
                }}
                className="ml-auto rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CreateAnnouncementModal({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const create = useCreateGroupAnnouncement(groupId);
  const { toast: showToast } = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const submit = async () => {
    if (!title.trim() || !body.trim()) return;
    try {
      await create.mutateAsync({ title: title.trim(), body: body.trim(), pinned });
      showToast('Announcement posted', 'success');
      onClose();
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  };
  return (
    <Modal open onClose={onClose} title="Post announcement" size="md">
      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Body"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          Pin to top of feed
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={create.isPending || !title.trim() || !body.trim()}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
          >
            Post
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CreateEventModal({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const create = useCreateGroupEvent(groupId);
  const { toast: showToast } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [eventType, setEventType] = useState<GroupEventType>('MEETING');
  const [requiresRsvp, setRequiresRsvp] = useState(false);
  const [maxAttendees, setMaxAttendees] = useState('');
  const [isPublic, setIsPublic] = useState(false);

  const submit = async () => {
    if (!title.trim() || !startsAt) return;
    try {
      await create.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
        eventType,
        requiresRsvp,
        maxAttendees: maxAttendees ? Number(maxAttendees) : undefined,
        isPublic,
      });
      showToast('Event created', 'success');
      onClose();
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  };
  return (
    <Modal open onClose={onClose} title="New event" size="md">
      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Description (optional)"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Location (optional)"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs">
            Starts
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs">
            Ends (optional)
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
          </label>
        </div>
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as GroupEventType)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {EVENT_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requiresRsvp}
            onChange={(e) => setRequiresRsvp(e.target.checked)}
          />
          Require RSVP
        </label>
        {requiresRsvp ? (
          <input
            type="number"
            min={1}
            value={maxAttendees}
            onChange={(e) => setMaxAttendees(e.target.value)}
            placeholder="Max attendees (optional)"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          Public event (visible to non-members)
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={create.isPending || !title.trim() || !startsAt}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function InitiateTransferModal({
  groupId,
  members,
  myMemberId,
  onClose,
}: {
  groupId: string;
  members: { id: string; personName: string | null; role: string; status: string }[];
  myMemberId: string;
  onClose: () => void;
}) {
  const initiate = useInitiateTransfer(groupId);
  const { toast: showToast } = useToast();
  const [toMemberId, setToMemberId] = useState('');
  const [reason, setReason] = useState('');
  const candidates = members.filter((m) => m.id !== myMemberId && m.status === 'ACTIVE');

  const submit = async () => {
    if (!toMemberId) return;
    try {
      await initiate.mutateAsync({ toMemberId, reason: reason.trim() || undefined });
      showToast('Transfer initiated', 'success');
      onClose();
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  };
  return (
    <Modal open onClose={onClose} title="Transfer ownership" size="md">
      <div className="space-y-3">
        <p className="rounded-md bg-violet-50 p-3 text-sm text-violet-800">
          Once accepted by the recipient, you become an ADMIN and the new owner takes over. The
          transfer expires in 7 days if not responded to.
        </p>
        <select
          value={toMemberId}
          onChange={(e) => setToMemberId(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">Choose recipient...</option>
          {candidates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.personName ?? 'Unknown'} ({m.role})
            </option>
          ))}
        </select>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Reason (optional)"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={initiate.isPending || !toMemberId}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            Initiate transfer
          </button>
        </div>
      </div>
    </Modal>
  );
}

void Link;
