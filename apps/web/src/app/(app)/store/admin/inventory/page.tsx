'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  useAdjustInventory,
  useInventoryDashboard,
  useProducts,
  useStores,
} from '@/hooks/use-store';

export default function AdminInventoryPage() {
  const { toast } = useToast();
  const inventory = useInventoryDashboard();
  const stores = useStores();
  const adjust = useAdjustInventory();
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [newQty, setNewQty] = useState(0);
  const [newReorderPoint, setNewReorderPoint] = useState(0);

  // Inventory rows are keyed by product. To get the inventory_row id we
  // need to read the product's inventory array.
  const adjustingStore = stores.data?.find((s) =>
    inventory.data?.find((i) => i.productId === activeProductId && i.storeName === s.name),
  );
  const productsForAdjust = useProducts(adjustingStore?.id ?? null, { includeInactive: true });
  const adjustingProduct = productsForAdjust.data?.find((p) => p.id === activeProductId);
  const adjustingRow = adjustingProduct?.inventory[0];

  const onAdjust = async () => {
    if (!adjustingRow) {
      toast('No inventory row found', 'error');
      return;
    }
    try {
      await adjust.mutateAsync({
        id: adjustingRow.id,
        payload: {
          quantityOnHand: newQty,
          reorderPoint: newReorderPoint,
        },
      });
      toast('Inventory adjusted', 'success');
      setAdjustOpen(false);
      setActiveProductId(null);
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Adjust failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Inventory dashboard"
        description="Stock + reservations + reorder thresholds across both stores. Adjusting below reorder fires str.inventory.reorder_needed."
        actions={
          <Link href="/store" className="text-sm text-campus-600 hover:underline">
            ← Store
          </Link>
        }
      />

      {inventory.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (inventory.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No inventory rows. Add products + initial stock under Manage products.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Product</Th>
                <Th>SKU</Th>
                <Th>Store</Th>
                <Th>Location</Th>
                <Th className="text-right">On hand</Th>
                <Th className="text-right">Reserved</Th>
                <Th className="text-right">Available</Th>
                <Th className="text-right">Reorder</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(inventory.data ?? []).map((r) => (
                <tr
                  key={r.productId + r.locationId}
                  className={r.atOrBelowReorder ? 'bg-amber-50' : 'hover:bg-gray-50'}
                >
                  <Td>{r.productName}</Td>
                  <Td>{r.sku ?? '—'}</Td>
                  <Td>
                    {r.storeName} · {r.storeType}
                  </Td>
                  <Td>{r.locationType}</Td>
                  <Td className="text-right">{r.quantityOnHand}</Td>
                  <Td className="text-right text-amber-700">{r.quantityReserved}</Td>
                  <Td className="text-right font-semibold">
                    {Math.max(r.quantityOnHand - r.quantityReserved, 0)}
                  </Td>
                  <Td className="text-right">{r.reorderPoint}</Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        r.atOrBelowReorder
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {r.atOrBelowReorder ? 'Reorder' : 'OK'}
                    </span>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveProductId(r.productId);
                        setNewQty(r.quantityOnHand);
                        setNewReorderPoint(r.reorderPoint);
                        setAdjustOpen(true);
                      }}
                      className="text-sm text-campus-700 hover:underline"
                    >
                      Adjust
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="Adjust inventory"
        footer={
          <>
            <button
              onClick={() => setAdjustOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onAdjust}
              disabled={adjust.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Save
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            <strong>Reorder signal.</strong> If you set quantity_on_hand at or below reorder_point
            and we&apos;re crossing the threshold, str.inventory.reorder_needed fires for the
            procurement consumer.
          </div>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">New quantity_on_hand</div>
            <input
              type="number"
              min={0}
              value={newQty}
              onChange={(e) => setNewQty(Math.max(0, Number(e.target.value)))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Reorder point</div>
            <input
              type="number"
              min={0}
              value={newReorderPoint}
              onChange={(e) => setNewReorderPoint(Math.max(0, Number(e.target.value)))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
