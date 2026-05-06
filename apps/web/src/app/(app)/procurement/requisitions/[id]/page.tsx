'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import {
  DEST_MODULE_LABELS,
  formatCurrency,
  formatDateTime,
  REQ_STATUS_LABELS,
  REQ_STATUS_PILL,
  URGENCY_LABELS,
  URGENCY_PILL,
} from '@/lib/procurement-format';
import {
  useApproveRequisition,
  useRejectRequisition,
  useRequisition,
  useSubmitRequisition,
} from '@/hooks/use-procurement';
import type { PrcReqStatus } from '@/lib/types';

export default function RequisitionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user ? hasAnyPermission(user, ['sch-001:admin']) : false;
  const canBuyer = user ? hasAnyPermission(user, ['prc-002:read']) : false;
  const req = useRequisition(params?.id ?? null);
  const submit = useSubmitRequisition();
  const approve = useApproveRequisition();
  const reject = useRejectRequisition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  if (req.isLoading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (req.error || !req.data) {
    return (
      <div className="p-6">
        <PageHeader title="Requisition not found" />
        <Link href="/procurement/requisitions" className="text-sm text-campus-600 hover:underline">
          ← Back to requisitions
        </Link>
      </div>
    );
  }
  const r = req.data;

  const onSubmit = async () => {
    try {
      await submit.mutateAsync(r.id);
      toast('Requisition submitted', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Submit failed', 'error');
    }
  };

  const onApprove = async (toStatus: 'DEPT_APPROVED' | 'ADMIN_APPROVED' | 'DISTRICT_APPROVED') => {
    try {
      await approve.mutateAsync({ id: r.id, toStatus });
      toast(`Approved → ${REQ_STATUS_LABELS[toStatus]}`, 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Approve failed', 'error');
    }
  };

  const onReject = async () => {
    if (!rejectReason.trim()) {
      toast('Reason is required', 'error');
      return;
    }
    try {
      await reject.mutateAsync({ id: r.id, reason: rejectReason });
      setRejectOpen(false);
      setRejectReason('');
      toast('Requisition rejected', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Reject failed', 'error');
    }
  };

  const nextApproveStep = nextApprovalStep(r.status);

  return (
    <div>
      <PageHeader
        title={`Requisition #${r.id.slice(0, 8)}`}
        description={`Submitted by ${r.requestingPersonName ?? 'Unknown'} · ${formatDateTime(r.createdAt)}`}
        actions={
          <Link
            href="/procurement/requisitions"
            className="text-sm text-campus-600 hover:underline"
          >
            ← Back to requisitions
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${REQ_STATUS_PILL[r.status]}`}
        >
          {REQ_STATUS_LABELS[r.status]}
        </span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${URGENCY_PILL[r.urgency]}`}>
          {URGENCY_LABELS[r.urgency]}
        </span>
        {r.budgetAccountCode && (
          <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700">
            Budget {r.budgetAccountCode}
          </span>
        )}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card label="Total estimate">{formatCurrency(r.totalEstimatedCost)}</Card>
        <Card label="Department">{r.requestingDepartment ?? '—'}</Card>
        <Card label="Submitted">{formatDateTime(r.submittedAt)}</Card>
      </div>

      {/* Action bar */}
      {(r.status === 'DRAFT' || nextApproveStep || isAdmin) && (
        <div className="mb-6 flex flex-wrap gap-2 rounded-card border border-gray-200 bg-white p-3 shadow-sm">
          {r.status === 'DRAFT' && (
            <button
              onClick={onSubmit}
              disabled={submit.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Submit for approval
            </button>
          )}
          {nextApproveStep && isAdmin && (
            <button
              onClick={() => onApprove(nextApproveStep)}
              disabled={approve.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {approve.isPending ? 'Approving…' : `Approve → ${REQ_STATUS_LABELS[nextApproveStep]}`}
            </button>
          )}
          {isAdmin && r.status !== 'REJECTED' && r.status !== 'CLOSED' && r.status !== 'DRAFT' && (
            <button
              onClick={() => setRejectOpen(true)}
              className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
            >
              Reject
            </button>
          )}
          {canBuyer && r.status === 'ADMIN_APPROVED' && (
            <button
              onClick={() => router.push(`/procurement/purchase-orders/new?requisitionId=${r.id}`)}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Create PO from this requisition →
            </button>
          )}
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Justification</h2>
        <div className="whitespace-pre-wrap rounded-card border border-gray-200 bg-white p-4 text-sm text-gray-800 shadow-sm">
          {r.justification}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Line items</h2>
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>#</Th>
                <Th>Description</Th>
                <Th className="text-right">Qty</Th>
                <Th>Unit</Th>
                <Th className="text-right">Est. unit cost</Th>
                <Th className="text-right">Line total</Th>
                <Th>Destination</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {r.lines.map((l, idx) => (
                <tr key={l.id}>
                  <Td>{idx + 1}</Td>
                  <Td>{l.itemDescription}</Td>
                  <Td className="text-right">{l.quantity}</Td>
                  <Td>{l.unit ?? '—'}</Td>
                  <Td className="text-right">{formatCurrency(l.estimatedUnitCost)}</Td>
                  <Td className="text-right">
                    {l.estimatedUnitCost !== null && l.estimatedUnitCost !== undefined
                      ? formatCurrency(l.estimatedUnitCost * l.quantity)
                      : '—'}
                  </Td>
                  <Td>{DEST_MODULE_LABELS[l.destinationModule]}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(r.reviewedAt || r.rejectionReason) && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Review</h2>
          <div className="rounded-card border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-sm">
            {r.reviewedByName && <div>Reviewed by {r.reviewedByName}</div>}
            {r.reviewedAt && <div>{formatDateTime(r.reviewedAt)}</div>}
            {r.rejectionReason && (
              <div className="mt-2 rounded-md bg-rose-50 p-3 text-rose-700">
                <strong>Rejection reason:</strong> {r.rejectionReason}
              </div>
            )}
          </div>
        </section>
      )}

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject requisition"
        footer={
          <>
            <button
              onClick={() => setRejectOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onReject}
              disabled={reject.isPending}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Reject
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-sm text-gray-600">
            Please give the requester a reason. They will see this in the requisition detail.
          </div>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={4}
            maxLength={2000}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </Modal>
    </div>
  );
}

function nextApprovalStep(
  status: PrcReqStatus,
): 'DEPT_APPROVED' | 'ADMIN_APPROVED' | 'DISTRICT_APPROVED' | null {
  if (status === 'SUBMITTED') return 'DEPT_APPROVED';
  if (status === 'DEPT_APPROVED') return 'ADMIN_APPROVED';
  if (status === 'ADMIN_APPROVED') return 'DISTRICT_APPROVED';
  return null;
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-gray-900">{children}</div>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
