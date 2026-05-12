'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useItAsset,
  useItAssetAssignments,
  useItAssetDocuments,
  useItDamageReports,
  useItRepairs,
} from '@/hooks/use-it';
import {
  useCreateItRemoteAction,
  useItDeviceUsage,
  useItRemoteActions,
  useUpdateItRemoteActionStatus,
} from '@/hooks/use-it-advanced';
import {
  IT_ASSET_STATUS_LABELS,
  IT_ASSET_STATUS_PILL,
  IT_DAMAGE_PILL,
  IT_DAMAGE_SEVERITY_LABELS,
  IT_REPAIR_STATUS_LABELS,
  IT_REPAIR_STATUS_PILL,
  formatItCurrency,
  formatItDate,
  formatItDateTime,
} from '@/lib/it-format';
import {
  IT_REMOTE_ACTION_LABELS,
  IT_REMOTE_ACTION_PILL,
  IT_REMOTE_ACTION_STATUS_LABELS,
  IT_REMOTE_ACTION_STATUS_PILL,
  IT_REMOTE_ACTION_TYPES,
  formatItDateTime as fmtDt,
} from '@/lib/it-advanced-format';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { ItRemoteActionType } from '@/lib/types';

export default function AssetDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const asset = useItAsset(id);
  const assignments = useItAssetAssignments(id);
  const documents = useItAssetDocuments(id);
  const damages = useItDamageReports({ assetId: id });
  const repairs = useItRepairs({ assetId: id });
  const remoteActions = useItRemoteActions(id);
  const usage = useItDeviceUsage(id);

  if (asset.isLoading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (!asset.data) {
    return <div className="p-6 text-sm text-rose-700">Asset not found.</div>;
  }
  const a = asset.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader title={a.assetTag} description={`${a.make ?? ''} ${a.model ?? ''}`.trim()} />
      <div className="rounded-md border border-gray-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs uppercase text-gray-500">Status</p>
            <span
              className={`mt-1 inline-block rounded px-2 py-0.5 text-xs ${IT_ASSET_STATUS_PILL[a.status]}`}
            >
              {IT_ASSET_STATUS_LABELS[a.status]}
            </span>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Category</p>
            <p className="mt-1 font-medium">{a.categoryName}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Serial</p>
            <p className="mt-1 font-mono text-xs">{a.serialNumber ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Cost / Warranty</p>
            <p className="mt-1">
              {formatItCurrency(a.purchaseCost)} · {formatItDate(a.warrantyExpiry)}
            </p>
          </div>
        </div>
        {a.currentAssigneeName ? (
          <div className="mt-3 rounded bg-sky-50 p-2 text-sm text-sky-800">
            Currently assigned to <strong>{a.currentAssigneeName}</strong>
          </div>
        ) : null}
        {a.notes ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700">{a.notes}</p>
        ) : null}
      </div>

      <RemoteActionsPanel assetId={id} actions={remoteActions.data ?? []} />

      <UsagePanel rows={usage.data ?? []} />

      <Section title={`Assignment history (${assignments.data?.length ?? 0})`}>
        {(assignments.data?.length ?? 0) === 0 ? (
          <Empty>No assignment history.</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {assignments.data?.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-medium">{r.assigneeName}</p>
                  <p className="text-xs text-gray-500">
                    Assigned {formatItDateTime(r.assignedAt)}
                    {r.returnedAt ? ` · Returned ${formatItDateTime(r.returnedAt)}` : ''}
                  </p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    r.returnedAt ? 'bg-gray-100 text-gray-700' : 'bg-emerald-100 text-emerald-700'
                  }`}
                >
                  {r.returnedAt ? 'Returned' : 'Active'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Damage reports (${damages.data?.length ?? 0})`}>
        {(damages.data?.length ?? 0) === 0 ? (
          <Empty>No damage reports.</Empty>
        ) : (
          <ul className="space-y-2">
            {damages.data?.map((d) => (
              <li key={d.id} className="rounded border border-gray-200 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{d.reportedByName}</p>
                  <span className={`rounded px-2 py-0.5 text-xs ${IT_DAMAGE_PILL[d.severity]}`}>
                    {IT_DAMAGE_SEVERITY_LABELS[d.severity]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{formatItDateTime(d.reportedAt)}</p>
                <p className="mt-2 whitespace-pre-wrap text-gray-700">{d.description}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Repair records (${repairs.data?.length ?? 0})`}>
        {(repairs.data?.length ?? 0) === 0 ? (
          <Empty>No repair records.</Empty>
        ) : (
          <ul className="space-y-2">
            {repairs.data?.map((r) => (
              <li key={r.id} className="rounded border border-gray-200 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{r.repairType.replace('_', ' ')}</p>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${IT_REPAIR_STATUS_PILL[r.status]}`}
                  >
                    {IT_REPAIR_STATUS_LABELS[r.status]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Sent {formatItDate(r.sentForRepairAt)} · ETA {formatItDate(r.estimatedReturnDate)}
                </p>
                {r.vendorName ? (
                  <p className="text-xs text-gray-500">Vendor: {r.vendorName}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Documents (${documents.data?.length ?? 0})`}>
        {(documents.data?.length ?? 0) === 0 ? (
          <Empty>No documents.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {documents.data?.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded border border-gray-100 p-2"
              >
                <span>{d.fileName}</span>
                <span className="text-xs uppercase text-gray-500">{d.documentType}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">{title}</h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-500">{children}</p>;
}

/**
 * RemoteActionsPanel — extends device detail with MDM remote
 * controls. The IMMUTABLE contract is surfaced via copy: the
 * justification textarea is required with a min-20-character
 * gate (client-side mirrors the schema CHECK + service-layer
 * validation) and the warning copy notes the row is permanent
 * audit. WIPE additionally surfaces a rose-tinted warning band
 * because it auto-resets tech_assets.status to AVAILABLE on
 * completion.
 */
function RemoteActionsPanel({
  assetId,
  actions,
}: {
  assetId: string;
  actions: ReturnType<typeof useItRemoteActions>['data'] extends infer T
    ? T extends Array<infer Row>
      ? Row[]
      : never
    : never;
}) {
  const user = useAuthStore((s) => s.user);
  const canWrite = hasAnyPermission(user, ['it-002:write']);
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [actionType, setActionType] = useState<ItRemoteActionType>('LOCK');
  const [justification, setJustification] = useState('');
  const createAction = useCreateItRemoteAction(assetId);
  const updateStatus = useUpdateItRemoteActionStatus();

  const submit = async () => {
    if (justification.trim().length < 20) {
      toast('Justification must be at least 20 characters.', 'warning');
      return;
    }
    try {
      await createAction.mutateAsync({ actionType, justification: justification.trim() });
      toast(`${IT_REMOTE_ACTION_LABELS[actionType]} issued.`, 'success');
      setJustification('');
      setActionType('LOCK');
      setModalOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not issue remote action', 'error');
    }
  };

  const markComplete = async (id: string) => {
    try {
      await updateStatus.mutateAsync({ id, body: { status: 'COMPLETED' } });
      toast('Action marked completed.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update status', 'error');
    }
  };

  const charCount = justification.trim().length;
  const validLength = charCount >= 20;

  return (
    <Section title={`Remote MDM actions (${actions.length})`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs text-gray-500">
          Remote actions are an <strong>IMMUTABLE</strong> audit trail. Every action requires a
          justification (≥ 20 chars). <code className="rounded bg-gray-100 px-1">WIPE</code> +
          COMPLETED auto-resets the device to AVAILABLE.
        </p>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="shrink-0 rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Issue action
          </button>
        ) : null}
      </div>

      {actions.length === 0 ? (
        <Empty>No remote actions recorded.</Empty>
      ) : (
        <ul className="space-y-2">
          {actions.map((a) => (
            <li key={a.id} className="rounded border border-gray-200 p-3 text-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-semibold ${IT_REMOTE_ACTION_PILL[a.actionType]}`}
                  >
                    {IT_REMOTE_ACTION_LABELS[a.actionType]}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${IT_REMOTE_ACTION_STATUS_PILL[a.status]}`}
                  >
                    {IT_REMOTE_ACTION_STATUS_LABELS[a.status]}
                  </span>
                </div>
                <p className="text-xs text-gray-500">{fmtDt(a.initiatedAt)}</p>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                By <strong>{a.initiatedByName ?? '—'}</strong>
                {a.mdmCommandRef ? (
                  <>
                    {' · '}
                    <span className="font-mono">{a.mdmCommandRef}</span>
                  </>
                ) : null}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-gray-700">{a.justification}</p>
              {a.failureReason ? (
                <p className="mt-1 text-xs text-rose-700">Failed: {a.failureReason}</p>
              ) : null}
              {canWrite && (a.status === 'PENDING' || a.status === 'SENT') ? (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => markComplete(a.id)}
                    className="rounded border border-emerald-200 bg-white px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                  >
                    Mark completed
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Issue remote action"
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
              disabled={!validLength || createAction.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-campus-700"
            >
              Issue
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Action</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {IT_REMOTE_ACTION_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setActionType(t)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    actionType === t
                      ? 'border-campus-600 bg-campus-50 text-campus-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {IT_REMOTE_ACTION_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          {actionType === 'WIPE' ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              <p className="font-semibold">WIPE is destructive</p>
              <p className="mt-1">
                On COMPLETED, the device flips to AVAILABLE and any active assignment ends. The
                audit row is permanent.
              </p>
            </div>
          ) : null}
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Justification</label>
            <textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={4}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="Why is this remote action necessary?"
            />
            <p className={`mt-1 text-xs ${validLength ? 'text-emerald-700' : 'text-gray-500'}`}>
              {charCount} / 20 minimum chars · permanent audit record
            </p>
          </div>
        </div>
      </Modal>
    </Section>
  );
}

/**
 * UsagePanel — surfaces device usage summaries with flagged-day
 * highlighting. Step 8 — when flagged_activity=true the row gets
 * rose tinting and the apps_used list is shown verbatim so the IT
 * admin can triage.
 */
function UsagePanel({
  rows,
}: {
  rows: ReturnType<typeof useItDeviceUsage>['data'] extends infer T
    ? T extends Array<infer Row>
      ? Row[]
      : never
    : never;
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <Section title={`Device usage (${rows.length} day${rows.length === 1 ? '' : 's'})`}>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className={`rounded border p-3 text-sm ${
              r.flaggedActivity ? 'border-rose-300 bg-rose-50' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between">
              <p className="font-medium">{formatItDate(r.summaryDate)}</p>
              {r.flaggedActivity ? (
                <span className="rounded bg-rose-200 px-2 py-0.5 text-xs font-semibold text-rose-800">
                  Flagged activity
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {r.screenTimeMinutes !== null ? `${r.screenTimeMinutes} min screen time` : '—'}
              {r.summarySource ? ` · ${r.summarySource}` : ''}
            </p>
            {r.appsUsed.length > 0 ? (
              <p className="mt-1 text-xs text-gray-700">
                <span className="font-medium">Apps:</span> {r.appsUsed.join(', ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
