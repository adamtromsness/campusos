'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useCreateItInventoryAudit, useItInventoryAudits } from '@/hooks/use-it-advanced';
import {
  IT_AUDIT_STATUS_LABELS,
  IT_AUDIT_STATUS_PILL,
  formatItDate,
  formatItRelative,
} from '@/lib/it-advanced-format';

export default function InventoryAuditsPage() {
  const user = useAuthStore((s) => s.user);
  const canWrite = hasAnyPermission(user, ['it-002:write']);
  const audits = useItInventoryAudits();
  const create = useCreateItInventoryAudit();
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [auditName, setAuditName] = useState('');
  const [building, setBuilding] = useState('');

  const submit = async () => {
    if (!auditName.trim()) {
      toast('Audit name is required.', 'warning');
      return;
    }
    try {
      const created = await create.mutateAsync({
        auditName: auditName.trim(),
        building: building.trim() || undefined,
      });
      toast(
        `Audit started — ${created.totalAssetsExpected} expected asset${created.totalAssetsExpected === 1 ? '' : 's'}.`,
        'success',
      );
      setAuditName('');
      setBuilding('');
      setModalOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start audit', 'error');
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader
        title="Inventory audits"
        description="Per-asset verification with discrepancy reporting"
      />
      <div className="flex justify-end">
        {canWrite ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Start audit
          </button>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Name</th>
              <th className="p-3">Building</th>
              <th className="p-3">Started</th>
              <th className="p-3">Status</th>
              <th className="p-3">Expected</th>
              <th className="p-3">Found</th>
              <th className="p-3">Missing</th>
              <th className="p-3">Unrecorded</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {audits.data?.map((a) => (
              <tr key={a.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-3 font-medium">{a.auditName}</td>
                <td className="p-3 text-gray-700">{a.building ?? '—'}</td>
                <td className="p-3 text-xs text-gray-500">
                  {formatItDate(a.auditDate)} · {formatItRelative(a.auditDate)}
                </td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${IT_AUDIT_STATUS_PILL[a.status]}`}>
                    {IT_AUDIT_STATUS_LABELS[a.status]}
                  </span>
                </td>
                <td className="p-3 text-gray-700">{a.totalAssetsExpected}</td>
                <td className="p-3 text-emerald-700">{a.totalAssetsFound}</td>
                <td
                  className={`p-3 ${a.totalAssetsMissing > 0 ? 'text-rose-700' : 'text-gray-700'}`}
                >
                  {a.totalAssetsMissing}
                </td>
                <td
                  className={`p-3 ${a.totalAssetsUnrecorded > 0 ? 'text-amber-700' : 'text-gray-700'}`}
                >
                  {a.totalAssetsUnrecorded}
                </td>
                <td className="p-3 text-right">
                  <Link
                    href={`/it/inventory-audits/${a.id}`}
                    className="text-sm font-medium text-campus-700 hover:underline"
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
            {!audits.isLoading && (audits.data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={9} className="p-6 text-center text-sm text-gray-500">
                  No audits yet. Start one to verify per-asset presence in a building.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Start inventory audit"
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
              Start
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Audit name</label>
            <input
              value={auditName}
              onChange={(e) => setAuditName(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="Annual device audit — Building A"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">
              Building (optional)
            </label>
            <input
              value={building}
              onChange={(e) => setBuilding(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="Building A"
            />
            <p className="mt-1 text-xs text-gray-500">
              Leave blank to audit all ACTIVE / ASSIGNED assets in the school.
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
