'use client';

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import {
  useAlertTypes,
  useEmergencyAlerts,
  useEmergencyAlertStatus,
  useIssueEmergencyAlert,
  useResolveEmergencyAlert,
} from '@/hooks/use-emergency-alerts';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import type { AlertChannel, AlertSeverity, EmergencyAlertDto } from '@/lib/types';

const ALL_CHANNELS: AlertChannel[] = ['PUSH', 'APP', 'EMAIL', 'SMS'];

const SEVERITY_PILL: Record<AlertSeverity, string> = {
  INFO: 'bg-sky-100 text-sky-700',
  WARNING: 'bg-amber-100 text-amber-800',
  URGENT: 'bg-orange-100 text-orange-800',
  EMERGENCY: 'bg-rose-100 text-rose-800',
};

export default function EmergencyAlertsAdminPage() {
  const user = useAuthStore((s) => s.user);
  const canIssue = hasAnyPermission(user, ['sch-001:admin', 'com-003:write']);
  const [tab, setTab] = useState<'ACTIVE' | 'RESOLVED'>('ACTIVE');
  const [issueOpen, setIssueOpen] = useState(false);

  const activeQ = useEmergencyAlerts({ status: 'ACTIVE' });
  const resolvedQ = useEmergencyAlerts({ status: 'RESOLVED' });
  const alerts = tab === 'ACTIVE' ? (activeQ.data ?? []) : (resolvedQ.data ?? []);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Emergency alerts"
        description="Issue and resolve school-wide emergency alerts. Recipients see a dismiss-proof banner until they acknowledge."
        actions={
          canIssue ? (
            <button
              type="button"
              onClick={() => setIssueOpen(true)}
              className="rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-800"
            >
              Issue alert
            </button>
          ) : null
        }
      />

      <div className="mt-4 inline-flex rounded-lg bg-gray-100 p-1">
        <TabButton active={tab === 'ACTIVE'} onClick={() => setTab('ACTIVE')}>
          Active ({activeQ.data?.length ?? 0})
        </TabButton>
        <TabButton active={tab === 'RESOLVED'} onClick={() => setTab('RESOLVED')}>
          Resolved
        </TabButton>
      </div>

      <div className="mt-4 space-y-3">
        {alerts.length === 0 ? (
          <EmptyState
            title={tab === 'ACTIVE' ? 'No active emergency alerts' : 'No resolved alerts'}
            description={
              tab === 'ACTIVE'
                ? 'When an alert is issued it will appear here. Recipients see a dismiss-proof banner until they acknowledge.'
                : 'Historical alerts will appear here once they have been resolved.'
            }
          />
        ) : (
          alerts.map((a) => <AlertCard key={a.id} alert={a} canManage={canIssue} />)
        )}
      </div>

      {issueOpen && <IssueAlertModal onClose={() => setIssueOpen(false)} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md px-4 py-1.5 text-sm font-semibold transition ' +
        (active ? 'bg-white text-campus-900 shadow-sm' : 'text-gray-700 hover:text-gray-900')
      }
    >
      {children}
    </button>
  );
}

function AlertCard({ alert, canManage }: { alert: EmergencyAlertDto; canManage: boolean }) {
  const status = useEmergencyAlertStatus(alert.id, canManage);
  const resolve = useResolveEmergencyAlert(alert.id);
  const pill = SEVERITY_PILL[alert.alertSeverity];
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + pill}>
              {alert.alertSeverity}
            </span>
            <span className="text-xs text-gray-500">
              {alert.alertTypeName} · Issued by {alert.issuedByName ?? 'unknown'}
            </span>
          </div>
          <h3 className="mt-2 text-base font-semibold text-gray-900">{alert.title}</h3>
          <p className="mt-1 text-sm text-gray-700">{alert.body}</p>
          <p className="mt-2 text-xs text-gray-500">
            Issued {new Date(alert.issuedAt).toLocaleString()}
            {alert.status === 'RESOLVED' && alert.resolvedAt && (
              <>
                {' '}
                · Resolved {new Date(alert.resolvedAt).toLocaleString()} by{' '}
                {alert.resolvedByName ?? 'unknown'}
              </>
            )}
          </p>
        </div>
        {canManage && alert.status === 'ACTIVE' && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Mark this alert as resolved?')) {
                resolve.mutate();
              }
            }}
            className="shrink-0 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Resolve
          </button>
        )}
      </div>
      {canManage && status.data && (
        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 text-xs sm:grid-cols-5">
          <Stat label="Recipients" value={status.data.totalDeliveries} />
          <Stat label="Sent" value={status.data.sentCount} />
          <Stat label="Delivered" value={status.data.deliveredCount} />
          <Stat
            label="Acknowledged"
            value={status.data.acknowledgedCount}
            highlight={
              status.data.totalDeliveries > 0
                ? status.data.acknowledgedCount === status.data.totalDeliveries
                : false
            }
          />
          <Stat label="Pending" value={status.data.pendingCount + status.data.failedCount} />
        </dl>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd
        className={
          'mt-0.5 text-lg font-semibold ' + (highlight ? 'text-emerald-700' : 'text-gray-900')
        }
      >
        {value}
      </dd>
    </div>
  );
}

function IssueAlertModal({ onClose }: { onClose: () => void }) {
  const types = useAlertTypes();
  const issue = useIssueEmergencyAlert();
  const [alertTypeId, setAlertTypeId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [channels, setChannels] = useState<AlertChannel[]>([]);

  const selectedType = useMemo(
    () => types.data?.find((t) => t.id === alertTypeId),
    [types.data, alertTypeId],
  );

  function toggleChannel(c: AlertChannel) {
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function submit() {
    if (!alertTypeId || !title || !body) return;
    await issue.mutateAsync({
      alertTypeId,
      title,
      body,
      channels: channels.length > 0 ? channels : undefined,
    });
    onClose();
  }

  const submitDisabled = !alertTypeId || !title || !body || issue.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title="Issue emergency alert"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitDisabled}
            className="rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {issue.isPending ? 'Issuing…' : 'Issue alert'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Alert type</label>
          <select
            value={alertTypeId}
            onChange={(e) => setAlertTypeId(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
          >
            <option value="">Select an alert type…</option>
            {types.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.severity})
              </option>
            ))}
          </select>
          {selectedType && (
            <p className="mt-1 text-xs text-gray-500">
              Default channels: {selectedType.defaultChannels.join(', ')}
              {selectedType.requiresAcknowledgement && ' · Requires acknowledgement'}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
            placeholder="Severe Weather — Shelter in Place"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Body</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={4000}
            rows={4}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
            placeholder="Provide instructions to staff and students."
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Channels override (optional)
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {ALL_CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggleChannel(c)}
                className={
                  'rounded-full px-3 py-1 text-xs font-semibold transition ' +
                  (channels.includes(c)
                    ? 'bg-rose-700 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
                }
              >
                {c}
              </button>
            ))}
          </div>
          {channels.length === 0 && selectedType && (
            <p className="mt-1 text-xs text-gray-500">
              No override — alert type&apos;s default channels will be used.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
