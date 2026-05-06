'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import {
  formatCurrency,
  isOpenPo,
  isOpenReq,
  PO_STATUS_LABELS,
  PO_STATUS_PILL,
  REQ_STATUS_LABELS,
  REQ_STATUS_PILL,
  RETURN_STATUS_PILL,
} from '@/lib/procurement-format';
import {
  usePurchaseOrders,
  useRequisitions,
  useReturns,
  useVendorPerformance,
} from '@/hooks/use-procurement';

export default function ProcurementDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isOfficer = user ? hasAnyPermission(user, ['prc-002:read']) : false;

  const reqs = useRequisitions();
  const pos = usePurchaseOrders();
  const returns = useReturns();
  const vendors = useVendorPerformance();

  const stats = useMemo(() => {
    const reqList = reqs.data ?? [];
    const poList = pos.data ?? [];
    const retList = returns.data ?? [];
    const vendList = vendors.data ?? [];
    const openReqs = reqList.filter((r) => isOpenReq(r.status));
    const openPos = poList.filter((p) => isOpenPo(p.status));
    const totalEncumbered = poList
      .filter((p) => p.status !== 'CANCELLED' && p.status !== 'CLOSED')
      .reduce((sum, p) => sum + Number(p.totalAmount), 0);
    const openReturns = retList.filter(
      (r) => r.status === 'INITIATED' || r.status === 'SHIPPED_TO_VENDOR',
    );
    return {
      openReqsCount: openReqs.length,
      openPosCount: openPos.length,
      openReturnsCount: openReturns.length,
      totalEncumbered,
      vendorsCount: vendList.length,
    };
  }, [reqs.data, pos.data, returns.data, vendors.data]);

  return (
    <div>
      <PageHeader
        title="Procurement"
        description={
          isOfficer
            ? 'Requisitions, purchase orders, receiving, distribution, and vendor performance'
            : 'Submit and track your requisitions'
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open requisitions" value={String(stats.openReqsCount)} tone="amber" />
        {isOfficer && <StatCard label="Open POs" value={String(stats.openPosCount)} tone="sky" />}
        {isOfficer && (
          <StatCard
            label="Active commitments"
            value={formatCurrency(stats.totalEncumbered)}
            tone="violet"
          />
        )}
        {isOfficer && (
          <StatCard label="Open returns" value={String(stats.openReturnsCount)} tone="rose" />
        )}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <NavChip href="/procurement/requisitions" label="Requisitions" />
        {isOfficer && <NavChip href="/procurement/purchase-orders" label="Purchase orders" />}
        {isOfficer && <NavChip href="/procurement/receiving" label="Receiving" />}
        {isOfficer && <NavChip href="/procurement/distribution" label="Distribution" />}
        {isOfficer && <NavChip href="/procurement/returns" label="Returns" />}
        {isOfficer && <NavChip href="/procurement/vendors" label="Vendor performance" />}
        {isOfficer && <NavChip href="/procurement/commitments" label="Commitments" />}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Recent requisitions</h2>
          {reqs.isLoading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (reqs.data ?? []).length === 0 ? (
            <EmptyState
              title="No requisitions yet"
              description="Submit your first requisition to start the procurement workflow."
              action={
                <Link
                  href="/procurement/requisitions/new"
                  className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
                >
                  New requisition
                </Link>
              }
            />
          ) : (
            <ul className="space-y-2">
              {(reqs.data ?? []).slice(0, 8).map((r) => (
                <li
                  key={r.id}
                  className="rounded-md border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/procurement/requisitions/${r.id}`}
                      className="font-medium text-campus-700 hover:underline"
                    >
                      {r.justification.slice(0, 70)}
                      {r.justification.length > 70 ? '…' : ''}
                    </Link>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${REQ_STATUS_PILL[r.status]}`}
                    >
                      {REQ_STATUS_LABELS[r.status]}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {r.requestingPersonName ?? 'Unknown'} · {r.lines.length} item
                    {r.lines.length === 1 ? '' : 's'} · {formatCurrency(r.totalEstimatedCost)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {isOfficer && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Open purchase orders</h2>
            {pos.isLoading ? (
              <div className="text-sm text-gray-500">Loading…</div>
            ) : (pos.data ?? []).filter((p) => isOpenPo(p.status)).length === 0 ? (
              <div className="rounded-md border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
                No open POs.
              </div>
            ) : (
              <ul className="space-y-2">
                {(pos.data ?? [])
                  .filter((p) => isOpenPo(p.status))
                  .slice(0, 8)
                  .map((p) => (
                    <li
                      key={p.id}
                      className="rounded-md border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <Link
                          href={`/procurement/purchase-orders/${p.id}`}
                          className="font-medium text-campus-700 hover:underline"
                        >
                          {p.poNumber}
                        </Link>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PO_STATUS_PILL[p.status]}`}
                        >
                          {PO_STATUS_LABELS[p.status]}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {p.vendorName ?? 'Unknown vendor'} · {formatCurrency(p.totalAmount)}
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        )}

        {isOfficer && (returns.data ?? []).length > 0 && (
          <section className="lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Open returns</h2>
            <ul className="space-y-2">
              {(returns.data ?? [])
                .filter((r) => r.status === 'INITIATED' || r.status === 'SHIPPED_TO_VENDOR')
                .slice(0, 6)
                .map((r) => (
                  <li
                    key={r.id}
                    className="rounded-md border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-campus-700">
                        {r.returnType} — {r.quantityReturned} unit
                        {r.quantityReturned === 1 ? '' : 's'}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RETURN_STATUS_PILL[r.status]}`}
                      >
                        {r.status}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {r.initiatedByName ?? 'Unknown'} ·{' '}
                      {r.vendorRmaNumber ? `RMA ${r.vendorRmaNumber}` : 'No RMA yet'}
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'amber' | 'sky' | 'violet' | 'rose' | 'emerald';
}) {
  const toneClass = {
    amber: 'bg-amber-50 text-amber-700',
    sky: 'bg-sky-50 text-sky-700',
    violet: 'bg-violet-50 text-violet-700',
    rose: 'bg-rose-50 text-rose-700',
    emerald: 'bg-emerald-50 text-emerald-700',
  }[tone];
  return (
    <div className={`rounded-card border border-transparent px-4 py-3 ${toneClass}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function NavChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:border-campus-400 hover:text-campus-700"
    >
      {label}
    </Link>
  );
}
