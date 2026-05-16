'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, Modal } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCancelSchedule,
  useCheckpointVersion,
  usePublication,
  usePublicationAnalytics,
  useRevertToVersion,
  useScheduleForPublication,
  useSchedulePublication,
  useSections,
  useVersionsForPublication,
} from '@/hooks/use-publications';
import {
  PUBLICATION_TYPE_LABELS,
  ROLE_PILL,
  SCHEDULED_STATUS_LABELS,
  SCHEDULED_STATUS_PILL,
  SECTION_TYPE_LABELS,
  STATUS_PILL,
  VERSION_TRIGGER_LABELS,
  VERSION_TRIGGER_PILL,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatEngagement,
} from '@/lib/publications-format';
import { useToast } from '@/components/ui/Toast';

export default function PublicationDetailPage({ params }: { params: { id: string } }) {
  const { user } = useAuthStore();
  const canEdit = hasAnyPermission(user, ['pub-001:write', 'pub-002:write', 'sch-001:admin']);

  const pubQ = usePublication(params.id);
  const sectionsQ = useSections(params.id);
  const versionsQ = useVersionsForPublication(canEdit ? params.id : null);
  const scheduleQ = useScheduleForPublication(canEdit ? params.id : null);
  const analyticsQ = usePublicationAnalytics(canEdit ? params.id : null);

  const checkpoint = useCheckpointVersion(params.id);
  const revert = useRevertToVersion(params.id);
  const schedulePub = useSchedulePublication(params.id);
  const cancelSchedule = useCancelSchedule(params.id);
  const { toast } = useToast();

  const [showCheckpoint, setShowCheckpoint] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [revertTarget, setRevertTarget] = useState<number | null>(null);

  if (!pubQ.data) return <p className="p-6 text-sm text-gray-500">Loading…</p>;
  const p = pubQ.data;
  const versions = versionsQ.data ?? [];
  const schedule = scheduleQ.data;
  const analytics = analyticsQ.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader
        title={p.title}
        description={
          PUBLICATION_TYPE_LABELS[p.publicationType] +
          (p.seriesTitle ? ` · ${p.seriesTitle}` : '') +
          (p.editionNumber ? ` · Edition #${p.editionNumber}` : '')
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_PILL[p.status]}`}>{p.status}</span>
        {p.publishedAt && (
          <span className="text-xs text-gray-500">Published {formatDate(p.publishedAt)}</span>
        )}
        <Link
          href={`/publications/${p.id}/delivery`}
          className="ml-auto rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
        >
          Delivery dashboard
        </Link>
        {p.editionId && (
          <Link
            href={`/publications/editions/${p.editionId}`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
          >
            Edit edition
          </Link>
        )}
        {canEdit && (
          <>
            <button
              type="button"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
              onClick={() => setShowCheckpoint(true)}
            >
              Save checkpoint
            </button>
            {!schedule && p.status !== 'PUBLISHED' && (
              <button
                type="button"
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                onClick={() => setShowSchedule(true)}
              >
                Schedule publish
              </button>
            )}
          </>
        )}
      </div>

      {p.collaborators.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Collaborators
          </h2>
          <ul className="flex flex-wrap gap-2">
            {p.collaborators.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
              >
                <span>{c.userName ?? c.userId.slice(0, 8)}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${ROLE_PILL[c.role]}`}>
                  {c.role}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Sections
        </h2>
        {(sectionsQ.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No sections yet.</p>
        ) : (
          <ul className="space-y-3">
            {sectionsQ.data!.map((sec) => (
              <li
                key={sec.id}
                className={`rounded-md border p-4 ${sec.isApproved ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50/40'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-gray-900">{sec.title}</h3>
                    <p className="text-xs text-gray-500">
                      {SECTION_TYPE_LABELS[sec.sectionType]}
                      {sec.ownerName ? ` · ${sec.ownerName}` : ''}
                      {!sec.isApproved && ' · pending approval'}
                    </p>
                  </div>
                  {sec.isApproved ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                      Approved
                    </span>
                  ) : (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                      Pending
                    </span>
                  )}
                </div>
                {sec.body && (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                    {sec.body}
                  </p>
                )}
                {sec.contributors.length > 0 && (
                  <p className="mt-3 text-xs text-gray-500">
                    Contributors:{' '}
                    {sec.contributors
                      .map((c) => c.contributorName ?? c.contributorId.slice(0, 8))
                      .join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit && schedule && (
        <section className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-amber-900">Scheduled publish</h2>
              <p className="mt-1 text-sm text-gray-700">
                {formatDateTime(schedule.scheduledAt)}{' '}
                <span className="text-amber-700">({formatCountdown(schedule.scheduledAt)})</span>
              </p>
              <p className="text-xs text-gray-600">
                Timezone: {schedule.timezone} · Scheduled by{' '}
                {schedule.scheduledByName ?? schedule.scheduledById}
              </p>
            </div>
            <span
              className={
                'rounded px-2 py-0.5 text-xs font-semibold ' +
                SCHEDULED_STATUS_PILL[schedule.status]
              }
            >
              {SCHEDULED_STATUS_LABELS[schedule.status]}
            </span>
          </div>
          {schedule.status === 'SCHEDULED' && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                onClick={async () => {
                  if (!window.confirm('Cancel this scheduled publish?')) return;
                  try {
                    await cancelSchedule.mutateAsync({});
                    toast('Schedule cancelled', 'success');
                  } catch (err) {
                    toast(err instanceof Error ? err.message : 'Failed to cancel', 'error');
                  }
                }}
              >
                Cancel schedule
              </button>
            </div>
          )}
        </section>
      )}

      {canEdit && analytics && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Engagement
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Recipients" value={analytics.totalRecipients} />
            <Stat label="Views" value={analytics.totalViews} />
            <Stat label="Unique views" value={analytics.uniqueViews} />
            <Stat label="Opens" value={analytics.totalOpens} />
            <Stat label="Link clicks" value={analytics.totalLinkClicks} />
            <Stat label="Bounces" value={analytics.totalBounces} tone="rose" />
            <Stat
              label="Open rate"
              value={formatEngagement(analytics.totalOpens, analytics.totalRecipients)}
            />
            <Stat
              label="Avg read"
              value={
                analytics.avgReadTimeSeconds !== null ? `${analytics.avgReadTimeSeconds}s` : '—'
              }
            />
          </div>
        </section>
      )}

      {canEdit && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Version history
          </h2>
          <p className="mb-2 text-xs text-gray-500">
            Every status transition + every saved checkpoint creates a new IMMUTABLE version. Revert
            creates a new version from an earlier snapshot (append-only).
          </p>
          {versions.length === 0 ? (
            <p className="text-sm text-gray-500">No versions yet.</p>
          ) : (
            <ol className="space-y-2">
              {versions.map((v) => (
                <li key={v.id} className="rounded-md border border-gray-200 bg-white p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-campus-700">v{v.versionNumber}</p>
                      <p className="text-xs text-gray-500">
                        {formatDateTime(v.createdAt)} {v.createdByName && `· ${v.createdByName}`}
                      </p>
                      {v.versionNote && (
                        <p className="mt-1 text-sm text-gray-700">{v.versionNote}</p>
                      )}
                      {v.revertedFromVersion !== null && (
                        <p className="mt-1 text-xs text-amber-700">
                          Reverted from v{v.revertedFromVersion}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span
                        className={
                          'rounded px-2 py-0.5 text-xs font-semibold ' +
                          VERSION_TRIGGER_PILL[v.trigger]
                        }
                      >
                        {VERSION_TRIGGER_LABELS[v.trigger]}
                      </span>
                      <button
                        type="button"
                        className="text-xs text-campus-700 hover:underline"
                        onClick={() => setRevertTarget(v.versionNumber)}
                      >
                        Revert to this version
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {showCheckpoint && (
        <CheckpointModal
          onClose={() => setShowCheckpoint(false)}
          onSubmit={async (note) => {
            try {
              await checkpoint.mutateAsync({ versionNote: note });
              toast('Checkpoint saved', 'success');
              setShowCheckpoint(false);
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Failed to save', 'error');
            }
          }}
          submitting={checkpoint.isPending}
        />
      )}

      {showSchedule && (
        <ScheduleModal
          onClose={() => setShowSchedule(false)}
          onSubmit={async (scheduledAt, timezone) => {
            try {
              await schedulePub.mutateAsync({ scheduledAt, timezone });
              toast('Scheduled for ' + scheduledAt, 'success');
              setShowSchedule(false);
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Failed to schedule', 'error');
            }
          }}
          submitting={schedulePub.isPending}
        />
      )}

      {revertTarget !== null && (
        <RevertModal
          versionNumber={revertTarget}
          onClose={() => setRevertTarget(null)}
          onConfirm={async (note) => {
            try {
              await revert.mutateAsync({
                versionNumber: revertTarget,
                payload: { versionNote: note },
              });
              toast(`Reverted to v${revertTarget}`, 'success');
              setRevertTarget(null);
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Failed to revert', 'error');
            }
          }}
          submitting={revert.isPending}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'rose' }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={
          'mt-1 text-2xl font-semibold ' + (tone === 'rose' ? 'text-rose-700' : 'text-campus-700')
        }
      >
        {value}
      </p>
    </div>
  );
}

function CheckpointModal({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: (note: string) => Promise<void>;
  submitting: boolean;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal
      open={true}
      title="Save checkpoint"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-700 disabled:opacity-50"
            onClick={() => onSubmit(note.trim())}
          >
            {submitting ? 'Saving…' : 'Save checkpoint'}
          </button>
        </div>
      }
    >
      <p className="mb-2 text-sm text-gray-700">
        Save the current content as a new IMMUTABLE version. You can revert to this point later.
      </p>
      <label className="block text-sm">
        <span className="text-gray-700">Optional note</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          placeholder="e.g. before sending to review"
        />
      </label>
    </Modal>
  );
}

function ScheduleModal({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: (scheduledAt: string, timezone: string) => Promise<void>;
  submitting: boolean;
}) {
  const [whenLocal, setWhenLocal] = useState('');
  const [timezone, setTimezone] = useState('America/Chicago');
  return (
    <Modal
      open={true}
      title="Schedule publish"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!whenLocal || submitting}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-700 disabled:opacity-50"
            onClick={() => {
              const iso = new Date(whenLocal).toISOString();
              return onSubmit(iso, timezone);
            }}
          >
            {submitting ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      }
    >
      <p className="mb-2 text-sm text-gray-700">
        The publication will be auto-published when the scheduled time arrives. Cancel any time
        before fire.
      </p>
      <label className="block text-sm">
        <span className="text-gray-700">When</span>
        <input
          type="datetime-local"
          value={whenLocal}
          onChange={(e) => setWhenLocal(e.target.value)}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="text-gray-700">Display timezone</span>
        <input
          type="text"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          maxLength={80}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </label>
    </Modal>
  );
}

function RevertModal({
  versionNumber,
  onClose,
  onConfirm,
  submitting,
}: {
  versionNumber: number;
  onClose: () => void;
  onConfirm: (note: string) => Promise<void>;
  submitting: boolean;
}) {
  const [note, setNote] = useState(`Reverted to v${versionNumber}`);
  return (
    <Modal
      open={true}
      title={`Revert to v${versionNumber}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            onClick={() => onConfirm(note.trim())}
          >
            {submitting ? 'Reverting…' : 'Revert (creates new version)'}
          </button>
        </div>
      }
    >
      <p className="mb-2 text-sm text-gray-700">
        This creates a new IMMUTABLE version with the same content as v{versionNumber}. The existing
        versions are never modified — the revert is append-only.
      </p>
      <label className="block text-sm">
        <span className="text-gray-700">Version note</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </label>
    </Modal>
  );
}
