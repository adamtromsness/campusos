'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useFacAdjustSupply, useFacBuildingSupply, useFacBuildings } from '@/hooks/use-facilities';
import type { FacSupplyDto } from '@/lib/types';

export default function SupplyPage() {
  const buildingsQ = useFacBuildings();
  const [buildingId, setBuildingId] = useState<string | null>(null);
  useEffect(() => {
    if (!buildingId && (buildingsQ.data?.length ?? 0) > 0) {
      setBuildingId(buildingsQ.data![0]!.id);
    }
  }, [buildingId, buildingsQ.data]);
  const supplyQ = useFacBuildingSupply(buildingId);
  const items = supplyQ.data ?? [];
  const belowCount = items.filter((s) => s.belowThreshold).length;

  return (
    <div>
      <PageHeader
        title="Supply inventory"
        description="Below-threshold items emit fac.supply.reorder_needed on every quantity drop that crosses the line"
        actions={
          <Link
            href="/facilities"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Facilities
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <label className="block text-sm">
          <span className="block font-medium text-gray-700">Building</span>
          <select
            value={buildingId ?? ''}
            onChange={(e) => setBuildingId(e.target.value || null)}
            className="mt-1 w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {(buildingsQ.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {belowCount > 0 && (
        <section className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>{belowCount}</strong> item{belowCount === 1 ? ' is' : 's are'} below the reorder
          threshold. Reorder alerts have been emitted on
          <code className="mx-1 rounded bg-amber-100 px-1 py-0.5 text-xs">
            fac.supply.reorder_needed
          </code>
          for downstream consumers.
        </section>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        {supplyQ.isLoading ? (
          <LoadingSpinner />
        ) : items.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {items.map((s) => (
              <SupplyRow key={s.id} item={s} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No supply items in this building.</p>
        )}
      </section>
    </div>
  );
}

function SupplyRow({ item }: { item: FacSupplyDto }) {
  const adjust = useFacAdjustSupply(item.id);
  const { toast } = useToast();
  const [showAdj, setShowAdj] = useState(false);
  const [qty, setQty] = useState<string>(String(item.currentQuantity));

  return (
    <li
      className={`flex items-baseline justify-between gap-2 rounded-lg border p-3 ${
        item.belowThreshold ? 'border-amber-300 bg-amber-50' : 'border-gray-100 bg-gray-50'
      }`}
    >
      <div>
        <div className="font-medium text-gray-900">{item.itemName}</div>
        <div className="text-xs text-gray-600">
          {item.currentQuantity} {item.unit} · threshold {item.reorderThreshold ?? '—'}
          {item.belowThreshold && (
            <span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-amber-900">
              Below threshold
            </span>
          )}
        </div>
        {item.preferredSupplier && (
          <div className="text-xs text-gray-500">Supplier: {item.preferredSupplier}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setShowAdj(true)}
        className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-100"
      >
        Adjust
      </button>

      {showAdj && (
        <Modal
          open
          onClose={() => setShowAdj(false)}
          title={`Adjust ${item.itemName}`}
          footer={
            <button
              type="button"
              onClick={async () => {
                const v = Number(qty);
                if (Number.isNaN(v)) {
                  toast('Enter a number', 'error');
                  return;
                }
                try {
                  await adjust.mutateAsync({ currentQuantity: v });
                  toast('Adjusted', 'success');
                  setShowAdj(false);
                } catch (err) {
                  toast((err as Error).message, 'error');
                }
              }}
              disabled={adjust.isPending}
              className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
            >
              {adjust.isPending ? 'Saving…' : 'Save'}
            </button>
          }
        >
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">New quantity ({item.unit})</span>
            <input
              type="number"
              step="0.01"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </Modal>
      )}
    </li>
  );
}
