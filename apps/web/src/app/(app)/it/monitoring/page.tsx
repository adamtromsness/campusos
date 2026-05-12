'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAcknowledgeItMonitoringAlert,
  useCreateItMonitoringCheck,
  useItMonitoringAlerts,
  useItMonitoringChecks,
  useRecordItCheckResult,
} from '@/hooks/use-it-advanced';
import {
  IT_ALERT_TYPE_LABELS,
  IT_ALERT_TYPE_PILL,
  IT_MONITORING_CHECK_TYPES,
  IT_MONITORING_CHECK_TYPE_LABELS,
  IT_MONITORING_STATUS_LABELS,
  IT_MONITORING_STATUS_PILL,
  formatItDateTime,
  formatItRelative,
} from '@/lib/it-advanced-format';
import type { ItMonitoringCheckType, ItMonitoringResultStatus } from '@/lib/types';

export default function MonitoringPage() {
  const user = useAuthStore((s) => s.user);
  const canWrite = hasAnyPermission(user, ['it-006:write']);
  const checks = useItMonitoringChecks();
  const alerts = useItMonitoringAlerts(true);
  const create = useCreateItMonitoringCheck();
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<{
    systemName: string;
    checkType: ItMonitoringCheckType;
    checkUrl: string;
    intervalMinutes: string;
    consecutiveFailuresToAlert: string;
    expectedStatusCode: string;
  }>({
    systemName: '',
    checkType: 'HTTP',
    checkUrl: '',
    intervalMinutes: '5',
    consecutiveFailuresToAlert: '2',
    expectedStatusCode: '200',
  });

  const submit = async () => {
    if (!form.systemName.trim()) {
      toast('System name required.', 'warning');
      return;
    }
    if (form.checkType !== 'MANUAL' && !form.checkUrl.trim()) {
      toast('URL required for non-manual checks.', 'warning');
      return;
    }
    try {
      await create.mutateAsync({
        systemName: form.systemName.trim(),
        checkType: form.checkType,
        checkUrl: form.checkUrl.trim() || undefined,
        intervalMinutes: Number(form.intervalMinutes),
        consecutiveFailuresToAlert: Number(form.consecutiveFailuresToAlert),
        expectedStatusCode: form.expectedStatusCode ? Number(form.expectedStatusCode) : undefined,
      });
      toast('Monitoring check created.', 'success');
      setForm({
        systemName: '',
        checkType: 'HTTP',
        checkUrl: '',
        intervalMinutes: '5',
        consecutiveFailuresToAlert: '2',
        expectedStatusCode: '200',
      });
      setModalOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create check', 'error');
    }
  };

  const activeAlerts = alerts.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <PageHeader
        title="Uptime monitoring"
        description="System health checks with consecutive-failure alerting"
      />

      {activeAlerts.length > 0 ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-4">
          <h2 className="text-sm font-semibold text-rose-900">
            {activeAlerts.length} active alert{activeAlerts.length === 1 ? '' : 's'}
          </h2>
          <ul className="mt-3 space-y-2">
            {activeAlerts.map((a) => (
              <AlertRow key={a.id} alert={a} canWrite={canWrite} />
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          All monitored systems healthy.
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Configured checks</h2>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            New check
          </button>
        ) : null}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {checks.data?.map((c) => (
          <CheckCard key={c.id} check={c} canWrite={canWrite} />
        ))}
        {!checks.isLoading && (checks.data?.length ?? 0) === 0 ? (
          <li className="col-span-full rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            No checks configured.
          </li>
        ) : null}
      </ul>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New monitoring check"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={create.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-campus-700"
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">System name</label>
            <input
              value={form.systemName}
              onChange={(e) => setForm({ ...form, systemName: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="SIS API"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Check type</label>
              <select
                value={form.checkType}
                onChange={(e) =>
                  setForm({ ...form, checkType: e.target.value as ItMonitoringCheckType })
                }
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {IT_MONITORING_CHECK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {IT_MONITORING_CHECK_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Interval (min)</label>
              <input
                type="number"
                min="1"
                value={form.intervalMinutes}
                onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          {form.checkType !== 'MANUAL' ? (
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">URL / Host</label>
              <input
                value={form.checkUrl}
                onChange={(e) => setForm({ ...form, checkUrl: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
                placeholder="https://sis.example.com/health"
              />
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">
                Consecutive failures → alert
              </label>
              <input
                type="number"
                min="1"
                value={form.consecutiveFailuresToAlert}
                onChange={(e) => setForm({ ...form, consecutiveFailuresToAlert: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">
                Expected status code
              </label>
              <input
                type="number"
                value={form.expectedStatusCode}
                onChange={(e) => setForm({ ...form, expectedStatusCode: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function CheckCard({
  check,
  canWrite,
}: {
  check: ReturnType<typeof useItMonitoringChecks>['data'] extends infer T
    ? T extends Array<infer Row>
      ? Row
      : never
    : never;
  canWrite: boolean;
}) {
  const record = useRecordItCheckResult(check.id);
  const { toast } = useToast();

  const submit = async (status: ItMonitoringResultStatus) => {
    try {
      await record.mutateAsync({ status });
      toast(`Recorded ${status}.`, status === 'HEALTHY' ? 'success' : 'warning');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record result', 'error');
    }
  };

  const statusKey = check.lastStatus ?? 'UNKNOWN';

  return (
    <li className="rounded-md border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="font-semibold">{check.systemName}</p>
        <span className={`rounded px-2 py-0.5 text-xs ${IT_MONITORING_STATUS_PILL[statusKey]}`}>
          {IT_MONITORING_STATUS_LABELS[statusKey]}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {check.checkType} · every {check.intervalMinutes}min · alert at{' '}
        {check.consecutiveFailuresToAlert} consecutive
      </p>
      {check.checkUrl ? (
        <p className="mt-1 text-xs font-mono text-gray-600">{check.checkUrl}</p>
      ) : null}
      <p className="mt-2 text-xs text-gray-500">
        Last checked {formatItRelative(check.lastCheckedAt)} · {check.consecutiveFailures}{' '}
        consecutive failure
        {check.consecutiveFailures === 1 ? '' : 's'}
      </p>
      {check.activeAlertCount > 0 ? (
        <p className="mt-1 text-xs font-semibold text-rose-700">
          {check.activeAlertCount} active alert{check.activeAlertCount === 1 ? '' : 's'}
        </p>
      ) : null}
      {canWrite ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => submit('HEALTHY')}
            disabled={record.isPending}
            className="rounded border border-emerald-200 bg-white px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
          >
            Record HEALTHY
          </button>
          <button
            type="button"
            onClick={() => submit('DEGRADED')}
            disabled={record.isPending}
            className="rounded border border-amber-200 bg-white px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50"
          >
            Record DEGRADED
          </button>
          <button
            type="button"
            onClick={() => submit('DOWN')}
            disabled={record.isPending}
            className="rounded border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
          >
            Record DOWN
          </button>
        </div>
      ) : null}
    </li>
  );
}

function AlertRow({
  alert,
  canWrite,
}: {
  alert: ReturnType<typeof useItMonitoringAlerts>['data'] extends infer T
    ? T extends Array<infer Row>
      ? Row
      : never
    : never;
  canWrite: boolean;
}) {
  const ack = useAcknowledgeItMonitoringAlert(alert.id);
  const { toast } = useToast();
  const [notes, setNotes] = useState('');
  const [expanded, setExpanded] = useState(false);

  const submit = async () => {
    try {
      await ack.mutateAsync({ notes: notes.trim() || undefined });
      toast('Alert acknowledged.', 'success');
      setExpanded(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not acknowledge', 'error');
    }
  };

  return (
    <li className="rounded border border-rose-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs ${IT_ALERT_TYPE_PILL[alert.alertType]}`}>
            {IT_ALERT_TYPE_LABELS[alert.alertType]}
          </span>
          <p className="font-semibold">{alert.systemName}</p>
        </div>
        <p className="text-xs text-gray-500">
          {formatItDateTime(alert.detectedAt)} · {formatItRelative(alert.detectedAt)}
        </p>
      </div>
      {alert.errorMessage ? (
        <p className="mt-1 text-xs text-rose-700">{alert.errorMessage}</p>
      ) : null}
      {alert.acknowledgedAt ? (
        <p className="mt-1 text-xs text-emerald-700">
          Acknowledged by {alert.acknowledgedByName ?? '—'} at{' '}
          {formatItDateTime(alert.acknowledgedAt)}
          {alert.notes ? ` — ${alert.notes}` : ''}
        </p>
      ) : canWrite ? (
        expanded ? (
          <div className="mt-2 flex flex-col gap-2">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Acknowledgement notes (optional)"
              className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={ack.isPending}
                className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Acknowledge
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-2 rounded-md border border-emerald-200 bg-white px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
          >
            Acknowledge
          </button>
        )
      ) : null}
    </li>
  );
}
