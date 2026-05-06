'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFacBuildings,
  useFacCommentWorkOrder,
  useFacCreateWorkOrder,
  useFacUpdateWorkOrder,
  useFacWorkOrder,
  useFacWorkOrders,
} from '@/hooks/use-facilities';
import {
  FAC_WO_PRIORITY_LABEL,
  FAC_WO_PRIORITY_PILL,
  FAC_WO_STATUS_LABEL,
  FAC_WO_STATUS_PILL,
  FAC_WO_TYPE_LABEL,
  formatDateTime,
} from '@/lib/facilities-format';
import type { FacWorkOrderPriority, FacWorkOrderStatus, FacWorkOrderType } from '@/lib/types';

const STATUS_COLUMNS: FacWorkOrderStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'VENDOR_ASSIGNED',
  'ON_HOLD',
  'COMPLETED',
];

export default function WorkOrdersPage() {
  const wosQ = useFacWorkOrders();
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        title="Work orders"
        description="Kanban by status — every state change writes an immutable activity row"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/facilities"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              ← Facilities
            </Link>
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
            >
              New work order
            </button>
          </div>
        }
      />

      {wosQ.isLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="grid gap-3 lg:grid-cols-5">
          {STATUS_COLUMNS.map((status) => {
            const items = (wosQ.data ?? []).filter((w) => w.status === status);
            return (
              <div key={status} className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">
                  {FAC_WO_STATUS_LABEL[status]}{' '}
                  <span className="ml-1 rounded-full bg-white px-2 py-0.5 text-xs">
                    {items.length}
                  </span>
                </h3>
                <ul className="space-y-2">
                  {items.map((w) => (
                    <li
                      key={w.id}
                      className="cursor-pointer rounded-lg border border-gray-200 bg-white p-2 hover:border-campus-300"
                      onClick={() => setOpenId(w.id)}
                    >
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${FAC_WO_PRIORITY_PILL[w.priority]}`}
                        >
                          {FAC_WO_PRIORITY_LABEL[w.priority]}
                        </span>
                        <span className="text-xs font-medium text-gray-700">
                          {FAC_WO_TYPE_LABEL[w.workOrderType]}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-gray-700">
                        {w.description ?? '—'}
                      </p>
                      <p className="mt-1 text-[11px] text-gray-500">
                        {w.spaceName ?? w.buildingName ?? '—'}
                        {w.assignedToName ? ` · ${w.assignedToName}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {showNew && <NewWorkOrderModal onClose={() => setShowNew(false)} />}
      {openId && <WorkOrderDetailModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function NewWorkOrderModal({ onClose }: { onClose: () => void }) {
  const buildingsQ = useFacBuildings();
  const create = useFacCreateWorkOrder();
  const { toast } = useToast();
  const [type, setType] = useState<FacWorkOrderType>('REPAIR');
  const [priority, setPriority] = useState<FacWorkOrderPriority>('MEDIUM');
  const [buildingId, setBuildingId] = useState<string>('');
  const [description, setDescription] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="New work order"
      footer={
        <button
          type="button"
          onClick={async () => {
            try {
              await create.mutateAsync({
                workOrderType: type,
                priority,
                buildingId: buildingId || undefined,
                description: description || undefined,
              });
              toast('Work order created', 'success');
              onClose();
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={create.isPending}
          className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="block font-medium text-gray-700">Type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as FacWorkOrderType)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="REPAIR">Repair</option>
            <option value="INSTALLATION">Installation</option>
            <option value="INSPECTION_PREP">Inspection prep</option>
            <option value="DEEP_CLEAN">Deep clean</option>
            <option value="RENOVATION">Renovation</option>
          </select>
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Priority</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as FacWorkOrderPriority)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Building</span>
          <select
            value={buildingId}
            onChange={(e) => setBuildingId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {(buildingsQ.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Description</span>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}

function WorkOrderDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const woQ = useFacWorkOrder(id);
  const update = useFacUpdateWorkOrder(id);
  const comment = useFacCommentWorkOrder(id);
  const { toast } = useToast();
  const [body, setBody] = useState('');

  const w = woQ.data;
  return (
    <Modal open onClose={onClose} title="Work order detail">
      {!w ? (
        <LoadingSpinner />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs ${FAC_WO_STATUS_PILL[w.status]}`}>
              {FAC_WO_STATUS_LABEL[w.status]}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${FAC_WO_PRIORITY_PILL[w.priority]}`}
            >
              {FAC_WO_PRIORITY_LABEL[w.priority]}
            </span>
            <span className="text-xs text-gray-600">{FAC_WO_TYPE_LABEL[w.workOrderType]}</span>
          </div>
          <p className="text-gray-900">{w.description}</p>
          <div className="text-xs text-gray-500">
            {w.spaceName ?? w.buildingName ?? '—'} ·{' '}
            {w.assignedToName ? `Assigned to ${w.assignedToName}` : 'Unassigned'} · Created{' '}
            {formatDateTime(w.createdAt)}
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <h4 className="text-sm font-semibold text-gray-900">Status</h4>
            <div className="mt-2 flex flex-wrap gap-1">
              {(
                [
                  'OPEN',
                  'IN_PROGRESS',
                  'VENDOR_ASSIGNED',
                  'ON_HOLD',
                  'COMPLETED',
                  'CANCELLED',
                ] as FacWorkOrderStatus[]
              ).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={async () => {
                    try {
                      await update.mutateAsync({ status: s });
                      toast(`Status → ${FAC_WO_STATUS_LABEL[s]}`, 'success');
                    } catch (err) {
                      toast((err as Error).message, 'error');
                    }
                  }}
                  className={`rounded-lg border px-2 py-1 text-xs ${
                    w.status === s
                      ? 'border-campus-700 bg-campus-700 text-white'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {FAC_WO_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <h4 className="text-sm font-semibold text-gray-900">Activity timeline</h4>
            <ul className="mt-2 space-y-1 text-xs">
              {(w.activity ?? []).map((a) => (
                <li key={a.id} className="rounded bg-gray-50 px-2 py-1">
                  <span className="font-mono text-gray-500">[{a.activityType}]</span>{' '}
                  <span className="text-gray-700">{JSON.stringify(a.metadata)}</span>{' '}
                  <span className="text-gray-400">
                    — {a.actorName ?? 'system'} · {formatDateTime(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <input
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Add comment…"
                className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!body) return;
                  try {
                    await comment.mutateAsync(body);
                    setBody('');
                    toast('Comment added', 'success');
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  }
                }}
                className="rounded-lg bg-campus-700 px-3 py-1 text-sm text-white hover:bg-campus-800"
              >
                Post
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
