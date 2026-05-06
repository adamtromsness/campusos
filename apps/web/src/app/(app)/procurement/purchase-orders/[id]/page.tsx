'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  COMMITMENT_LABELS,
  COMMITMENT_PILL,
  DEST_MODULE_LABELS,
  formatCurrency,
  formatDate,
  formatDateTime,
  PO_STATUS_LABELS,
  PO_STATUS_PILL,
} from '@/lib/procurement-format';
import { usePurchaseOrder, useReceiptsForPO, useTransitionPO } from '@/hooks/use-procurement';
import type { PrcPOStatus } from '@/lib/types';

const TRANSITIONS: Record<
  PrcPOStatus,
  Array<{
    action: 'ISSUE' | 'ACKNOWLEDGE' | 'SHIP' | 'CLOSE' | 'CANCEL';
    label: string;
    tone: string;
  }>
> = {
  DRAFT: [
    { action: 'ISSUE', label: 'Issue PO', tone: 'bg-emerald-600 text-white' },
    { action: 'CANCEL', label: 'Cancel', tone: 'bg-rose-600 text-white' },
  ],
  ISSUED: [
    { action: 'ACKNOWLEDGE', label: 'Acknowledge', tone: 'bg-sky-600 text-white' },
    { action: 'SHIP', label: 'Mark shipped', tone: 'bg-amber-600 text-white' },
    { action: 'CANCEL', label: 'Cancel', tone: 'bg-rose-600 text-white' },
  ],
  ACKNOWLEDGED: [
    { action: 'SHIP', label: 'Mark shipped', tone: 'bg-amber-600 text-white' },
    { action: 'CANCEL', label: 'Cancel', tone: 'bg-rose-600 text-white' },
  ],
  SHIPPED: [{ action: 'CANCEL', label: 'Cancel', tone: 'bg-rose-600 text-white' }],
  PARTIALLY_RECEIVED: [{ action: 'CANCEL', label: 'Cancel', tone: 'bg-rose-600 text-white' }],
  RECEIVED: [{ action: 'CLOSE', label: 'Close PO', tone: 'bg-gray-600 text-white' }],
  CLOSED: [],
  CANCELLED: [],
};

export default function PurchaseOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const { toast } = useToast();
  const po = usePurchaseOrder(params?.id ?? null);
  const receipts = useReceiptsForPO(params?.id ?? null);
  const transition = useTransitionPO();
  const [issueOpen, setIssueOpen] = useState(false);
  const [budgetLineId, setBudgetLineId] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);

  if (po.isLoading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (po.error || !po.data) {
    return (
      <div className="p-6">
        <PageHeader title="Purchase order not found" />
        <Link
          href="/procurement/purchase-orders"
          className="text-sm text-campus-600 hover:underline"
        >
          ← Back
        </Link>
      </div>
    );
  }
  const p = po.data;

  const onTransition = async (
    action: 'ISSUE' | 'ACKNOWLEDGE' | 'SHIP' | 'CLOSE' | 'CANCEL',
    reason?: string,
    bl?: string,
  ) => {
    try {
      await transition.mutateAsync({ id: p.id, action, reason, budgetLineId: bl });
      toast(`PO ${action.toLowerCase()}d`, 'success');
      setIssueOpen(false);
      setCancelOpen(false);
      setBudgetLineId('');
      setCancelReason('');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Transition failed', 'error');
    }
  };

  const transitions = TRANSITIONS[p.status];

  return (
    <div>
      <PageHeader
        title={p.poNumber}
        description={`Vendor: ${p.vendorName ?? 'Unknown'} · ${formatDate(p.createdAt)}`}
        actions={
          <Link
            href="/procurement/purchase-orders"
            className="text-sm text-campus-600 hover:underline"
          >
            ← Back
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${PO_STATUS_PILL[p.status]}`}
        >
          {PO_STATUS_LABELS[p.status]}
        </span>
        {p.requisitionId && (
          <Link
            href={`/procurement/requisitions/${p.requisitionId}`}
            className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-200"
          >
            ← From requisition
          </Link>
        )}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-4">
        <Card label="Total">{formatCurrency(p.totalAmount)}</Card>
        <Card label="Expected delivery">{formatDate(p.expectedDeliveryDate)}</Card>
        <Card label="Payment terms">{p.paymentTerms ?? '—'}</Card>
        <Card label="Issued">{formatDateTime(p.issuedAt)}</Card>
      </div>

      {transitions.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2 rounded-card border border-gray-200 bg-white p-3 shadow-sm">
          {transitions.map((t) => (
            <button
              key={t.action}
              onClick={() => {
                if (t.action === 'ISSUE') setIssueOpen(true);
                else if (t.action === 'CANCEL') setCancelOpen(true);
                else void onTransition(t.action);
              }}
              disabled={transition.isPending}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${t.tone} disabled:opacity-50`}
            >
              {t.label}
            </button>
          ))}
          {(p.status === 'ISSUED' ||
            p.status === 'ACKNOWLEDGED' ||
            p.status === 'SHIPPED' ||
            p.status === 'PARTIALLY_RECEIVED') && (
            <Link
              href={`/procurement/receiving?poId=${p.id}`}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Receive goods →
            </Link>
          )}
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Delivery address</h2>
        <div className="whitespace-pre-wrap rounded-card border border-gray-200 bg-white p-4 text-sm text-gray-800 shadow-sm">
          {p.deliveryAddress}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Lines</h2>
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Description</Th>
                <Th className="text-right">Ordered</Th>
                <Th className="text-right">Received</Th>
                <Th className="text-right">Unit cost</Th>
                <Th className="text-right">Line total</Th>
                <Th>GL</Th>
                <Th>Destination</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {p.lines.map((l) => (
                <tr key={l.id}>
                  <Td>{l.itemDescription}</Td>
                  <Td className="text-right">{l.quantityOrdered}</Td>
                  <Td className="text-right">{l.quantityReceived}</Td>
                  <Td className="text-right">{formatCurrency(l.unitCost)}</Td>
                  <Td className="text-right">{formatCurrency(l.lineTotal)}</Td>
                  <Td>{l.glAccountCode ?? '—'}</Td>
                  <Td>{DEST_MODULE_LABELS[l.destinationModule]}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {p.commitments.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Budget commitments</h2>
          <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  <Th>Account</Th>
                  <Th className="text-right">Committed</Th>
                  <Th className="text-right">Released</Th>
                  <Th>Status</Th>
                  <Th>Released at</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {p.commitments.map((c) => (
                  <tr key={c.id}>
                    <Td>{c.budgetAccountCode ?? '—'}</Td>
                    <Td className="text-right">{formatCurrency(c.committedAmount)}</Td>
                    <Td className="text-right">{formatCurrency(c.releasedAmount)}</Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${COMMITMENT_PILL[c.status]}`}
                      >
                        {COMMITMENT_LABELS[c.status]}
                      </span>
                    </Td>
                    <Td>{formatDateTime(c.releasedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Receipts</h2>
        {receipts.isLoading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (receipts.data ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
            No receipts logged yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {(receipts.data ?? []).map((r) => (
              <li
                key={r.id}
                className="rounded-card border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-900">
                      Received by {r.receivedByName ?? '—'} · {formatDateTime(r.receivedAt)}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Inspection: <strong>{r.inspectionOutcome}</strong> · {r.lines.length} line
                      {r.lines.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <Link
                    href={`/procurement/receipts/${r.id}?poId=${p.id}`}
                    className="text-sm text-campus-700 hover:underline"
                  >
                    View receipt →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        title="Issue purchase order"
        footer={
          <>
            <button
              onClick={() => setIssueOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => void onTransition('ISSUE', undefined, budgetLineId || undefined)}
              disabled={transition.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Issue PO
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            <strong>Budget commitment keystone.</strong> Issuing this PO will commit{' '}
            <strong>{formatCurrency(p.totalAmount)}</strong> against its budget line and bump{' '}
            <code>fin_budget_lines.encumbered_amount</code> in one tenant transaction.
          </div>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Override budget line ID (optional)</div>
            <input
              value={budgetLineId}
              onChange={(e) => setBudgetLineId(e.target.value)}
              placeholder="UUID — leave blank to use parent requisition's budget line"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel purchase order"
        footer={
          <>
            <button
              onClick={() => setCancelOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Keep PO
            </button>
            <button
              onClick={() => void onTransition('CANCEL', cancelReason)}
              disabled={transition.isPending}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Cancel PO
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md bg-rose-50 p-3 text-xs text-rose-800">
            Cancelling this PO will release any active budget commitment back to the budget line.
          </div>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Reason</div>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
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
