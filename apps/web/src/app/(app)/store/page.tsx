'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import {
  formatCurrency,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_PILL,
  stockBadge,
} from '@/lib/store-format';
import {
  useApprovals,
  useInventoryDashboard,
  useOrders,
  useProducts,
  useStores,
} from '@/hooks/use-store';

export default function StoreHomePage() {
  const user = useAuthStore((s) => s.user);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const isAdmin = user ? hasAnyPermission(user, ['sch-001:admin']) : false;
  const isManager = isStaff || isAdmin;
  const stores = useStores();
  const approvals = useApprovals();
  const orders = useOrders();
  const inventory = useInventoryDashboard();

  const studentStore = useMemo(
    () => (stores.data ?? []).find((s) => s.storeType === 'STUDENT') ?? null,
    [stores.data],
  );
  const publicStore = useMemo(
    () => (stores.data ?? []).find((s) => s.storeType === 'PUBLIC') ?? null,
    [stores.data],
  );

  const [previewStoreId, setPreviewStoreId] = useState<string | null>(null);
  const previewStore = previewStoreId ?? studentStore?.id ?? null;
  const products = useProducts(previewStore);

  const pendingApprovals = (approvals.data ?? []).filter((a) => a.status === 'PENDING');
  const openOrders = (orders.data ?? []).filter(
    (o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED',
  );
  const lowStock = (inventory.data ?? []).filter((i) => i.atOrBelowReorder);

  return (
    <div>
      <PageHeader
        title="School Store"
        description={
          isManager
            ? 'Products, orders, fulfilment, parent approvals, revenue.'
            : 'Browse the catalogue. Student orders require parent approval.'
        }
        actions={
          isManager && (
            <div className="flex gap-2">
              <Link
                href="/store/admin/products"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Products
              </Link>
              <Link
                href="/store/admin/orders"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Orders
              </Link>
              <Link
                href="/store/admin/inventory"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Inventory
              </Link>
              <Link
                href="/store/admin/revenue"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Revenue
              </Link>
            </div>
          )
        }
      />

      {pendingApprovals.length > 0 && (
        <div className="mb-6 rounded-card border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-amber-800">
                {pendingApprovals.length} order{pendingApprovals.length === 1 ? '' : 's'} awaiting
                your approval
              </div>
              <div className="mt-1 text-xs text-amber-700">
                Review pending student orders before payment is charged.
              </div>
            </div>
            <Link
              href="/store/approvals"
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Review approvals →
            </Link>
          </div>
        </div>
      )}

      {isManager && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Open orders" value={String(openOrders.length)} tone="sky" />
          <StatCard
            label="Pending approvals"
            value={String(pendingApprovals.length)}
            tone="amber"
          />
          <StatCard label="Low-stock items" value={String(lowStock.length)} tone="rose" />
          <StatCard label="Stores" value={`${stores.data?.length ?? 0}`} tone="emerald" />
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {studentStore && (
          <button
            type="button"
            onClick={() => setPreviewStoreId(studentStore.id)}
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              previewStore === studentStore.id
                ? 'bg-campus-600 text-white'
                : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:ring-campus-400'
            }`}
          >
            {studentStore.name}
          </button>
        )}
        {publicStore && (
          <button
            type="button"
            onClick={() => setPreviewStoreId(publicStore.id)}
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              previewStore === publicStore.id
                ? 'bg-campus-600 text-white'
                : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:ring-campus-400'
            }`}
          >
            {publicStore.name}
          </button>
        )}
      </div>

      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Catalogue</h2>
          {previewStore && (
            <Link
              href={`/store/checkout?storeId=${previewStore}`}
              className="text-sm text-campus-700 hover:underline"
            >
              Open checkout →
            </Link>
          )}
        </div>
        {products.isLoading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (products.data ?? []).length === 0 ? (
          <EmptyState
            title="No products yet"
            description="Admins can add products under Manage products."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(products.data ?? []).map((p) => {
              const badge = stockBadge(p.totalAvailable, p.inventory[0]?.reorderPoint ?? 0);
              return (
                <div
                  key={p.id}
                  className="rounded-card border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-gray-900">{p.name}</div>
                      {p.category && <div className="text-xs text-gray-500">{p.category}</div>}
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </div>
                  {p.description && (
                    <p className="mb-2 text-xs text-gray-600 line-clamp-2">{p.description}</p>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="text-lg font-semibold text-campus-700">
                      {formatCurrency(p.price)}
                    </div>
                    {p.sku && <div className="text-xs text-gray-400">{p.sku}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {!isManager && orders.data && orders.data.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">My orders</h2>
          <ul className="space-y-2">
            {orders.data.slice(0, 8).map((o) => (
              <li
                key={o.id}
                className="rounded-card border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-gray-900">{o.orderNumber}</div>
                    <div className="mt-1 text-xs text-gray-500">
                      {o.lines.length} item{o.lines.length === 1 ? '' : 's'} ·{' '}
                      {formatCurrency(o.total)}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ORDER_STATUS_PILL[o.status]}`}
                  >
                    {ORDER_STATUS_LABELS[o.status]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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
  tone: 'amber' | 'sky' | 'rose' | 'emerald';
}) {
  const cls = {
    amber: 'bg-amber-50 text-amber-700',
    sky: 'bg-sky-50 text-sky-700',
    rose: 'bg-rose-50 text-rose-700',
    emerald: 'bg-emerald-50 text-emerald-700',
  }[tone];
  return (
    <div className={`rounded-card border border-transparent px-4 py-3 ${cls}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}
