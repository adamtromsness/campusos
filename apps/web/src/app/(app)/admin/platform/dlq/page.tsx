'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useDiscardDlq,
  useDlqMessage,
  useDlqMessages,
  useDlqStats,
  useReplayDlq,
  type DlqRow,
} from '@/hooks/use-platform-admin';

/**
 * Cycle 31 Step 9 — DLQ admin surface.
 *
 * Lists every dead-letter message. Per-row Replay or Discard. Replay
 * goes through the KafkaProducerService.emitRaw() bypass path so the
 * original event_id + correlation_id + tenant_id survive intact —
 * downstream processWithIdempotency claims still behave correctly.
 *
 * Refresh interval is 30s. The Step 8 alert pages on-call when a row
 * sits unresolved for more than 15 minutes.
 */
export default function DlqPage() {
  const user = useAuthStore((s) => s.user);
  const isPlatformAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const [filter, setFilter] = useState<'PENDING' | 'RESOLVED' | 'ALL'>('PENDING');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [discardId, setDiscardId] = useState<string | null>(null);

  const stats = useDlqStats();
  const list = useDlqMessages({
    resolved: filter === 'PENDING' ? false : filter === 'RESOLVED' ? true : undefined,
    limit: 100,
  });
  const detail = useDlqMessage(detailId);
  const replay = useReplayDlq();
  const discard = useDiscardDlq();
  const { toast } = useToast();

  if (!user) return null;
  if (!isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Dead-letter queue" />
        <EmptyState title="Platform Admin only" />
      </div>
    );
  }

  const rows = list.data ?? [];

  async function onReplay(id: string) {
    if (!confirm('Replay this DLQ message? It will be re-emitted to its original topic.')) return;
    try {
      await replay.mutateAsync(id);
      toast('DLQ message replayed', 'success');
      if (detailId === id) setDetailId(null);
    } catch (err) {
      toast(`Replay failed: ${(err as Error).message}`, 'error');
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Dead-letter queue"
        description="Inspect, replay, or discard messages that exceeded retry. Replay preserves the original event_id."
      />

      {stats.data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Pending" value={stats.data.totalUnresolved} tone="amber" />
          <StatCard
            label="Older than 15 min"
            value={stats.data.olderThan15Min}
            tone={stats.data.olderThan15Min > 0 ? 'rose' : 'neutral'}
          />
          <StatCard label="Consumer groups affected" value={stats.data.byConsumerGroup.length} />
        </div>
      )}

      <div className="flex gap-2">
        {(['PENDING', 'RESOLVED', 'ALL'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm font-medium',
              filter === f
                ? 'border-campus-600 bg-campus-600 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No DLQ messages"
          description="Healthy state. Every Kafka consumer is processing cleanly."
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Topic</th>
                <th className="px-3 py-2 text-left">Group</th>
                <th className="px-3 py-2 text-left">Error</th>
                <th className="px-3 py-2 text-right">Age</th>
                <th className="px-3 py-2 text-right">Retries</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <DlqRowItem
                  key={r.id}
                  row={r}
                  onView={() => setDetailId(r.id)}
                  onReplay={() => onReplay(r.id)}
                  onDiscard={() => setDiscardId(r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailId && detail.data && (
        <Modal open onClose={() => setDetailId(null)} title="DLQ message detail">
          <div className="space-y-3 text-sm">
            <Field label="ID" value={detail.data.id} mono />
            <Field label="Topic" value={detail.data.topic} mono />
            <Field label="Consumer group" value={detail.data.consumerGroup} mono />
            <Field label="Event ID" value={detail.data.eventId ?? '—'} mono />
            <Field label="Tenant ID" value={detail.data.tenantId ?? '—'} mono />
            <Field label="Error class" value={detail.data.errorClass ?? '—'} />
            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-gray-500">Error message</p>
              <pre className="whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-rose-800">
                {detail.data.errorMessage}
              </pre>
            </div>
            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-gray-500">Payload</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-700">
                {JSON.stringify(detail.data.payload, null, 2)}
              </pre>
            </div>
          </div>
        </Modal>
      )}

      {discardId && (
        <DiscardModal
          id={discardId}
          onClose={() => setDiscardId(null)}
          onSubmit={async (id, reason) => {
            try {
              await discard.mutateAsync({ id, reason });
              toast('DLQ message discarded', 'success');
              setDiscardId(null);
            } catch (err) {
              toast(`Discard failed: ${(err as Error).message}`, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function DlqRowItem({
  row,
  onView,
  onReplay,
  onDiscard,
}: {
  row: DlqRow;
  onView: () => void;
  onReplay: () => void;
  onDiscard: () => void;
}) {
  const ageLabel =
    row.ageHours < 1 ? `${Math.round(row.ageHours * 60)}m` : `${row.ageHours.toFixed(1)}h`;
  const isOld = row.ageHours > 0.25 && !row.resolvedAt;
  return (
    <tr className={cn('hover:bg-gray-50', isOld && 'bg-rose-50')}>
      <td className="px-3 py-2 font-mono text-xs text-gray-900">{row.topic}</td>
      <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.consumerGroup}</td>
      <td className="px-3 py-2 text-gray-700">
        <span className="inline-flex rounded bg-rose-100 px-1.5 py-0.5 font-mono text-xs text-rose-800">
          {row.errorClass ?? 'UNKNOWN'}
        </span>
      </td>
      <td
        className={cn(
          'px-3 py-2 text-right tabular-nums',
          isOld ? 'text-rose-700 font-semibold' : 'text-gray-700',
        )}
      >
        {ageLabel}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-700">{row.retryCount}</td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex gap-2">
          <button
            onClick={onView}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            View
          </button>
          {!row.resolvedAt && (
            <>
              <button
                onClick={onReplay}
                className="rounded bg-campus-600 px-2 py-1 text-xs font-medium text-white hover:bg-campus-700"
              >
                Replay
              </button>
              <button
                onClick={onDiscard}
                className="rounded border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
              >
                Discard
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function DiscardModal({
  id,
  onClose,
  onSubmit,
}: {
  id: string;
  onClose: () => void;
  onSubmit: (id: string, reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="Discard DLQ message"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(id, reason.trim())}
            disabled={!reason.trim()}
            className="rounded bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300"
          >
            Discard
          </button>
        </div>
      }
    >
      <p className="text-sm text-gray-700">
        Discarding marks the row resolved without replay. The DLQ row stays for audit. Provide a
        reason — typically a ticket id or root-cause summary.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="e.g. Bogus envelope from cycle-12 producer; producer fix landed in commit abc123"
        className="mt-3 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
      />
    </Modal>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={cn('text-sm text-gray-900', mono && 'font-mono')}>{value}</p>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'amber' | 'rose';
}) {
  const valueClass =
    tone === 'rose' ? 'text-rose-600' : tone === 'amber' ? 'text-amber-700' : 'text-gray-900';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value.toLocaleString()}</p>
    </div>
  );
}
