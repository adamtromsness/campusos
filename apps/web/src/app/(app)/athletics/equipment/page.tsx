'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useEquipment,
  useEquipmentCheckouts,
  useOverdueCheckouts,
  useReturnCheckout,
  type EquipmentCondition,
} from '@/hooks/use-athletics-advanced';

const CONDITION_PILL: Record<EquipmentCondition, string> = {
  EXCELLENT: 'bg-emerald-100 text-emerald-700',
  GOOD: 'bg-emerald-50 text-emerald-700',
  FAIR: 'bg-amber-100 text-amber-700',
  POOR: 'bg-rose-100 text-rose-700',
  RETIRED: 'bg-gray-100 text-gray-700',
};

export default function EquipmentManagerPage() {
  const user = useAuthStore((s) => s.user);
  const isAd =
    hasAnyPermission(user, ['sch-001:admin']) ||
    (user?.personType === 'STAFF' && hasAnyPermission(user, ['ath-004:write']));

  const [tab, setTab] = useState<'inventory' | 'active' | 'overdue'>('inventory');
  const equipmentQ = useEquipment();
  const activeCheckoutsQ = useEquipmentCheckouts({ activeOnly: true });
  const overdueQ = useOverdueCheckouts();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Equipment Manager"
        description="Inventory, checkouts, and damage tracking for the AD"
      />

      <div className="flex gap-2 border-b border-gray-200">
        <button
          type="button"
          onClick={() => setTab('inventory')}
          className={`px-4 py-2 text-sm font-medium ${tab === 'inventory' ? 'border-b-2 border-campus-700 text-campus-700' : 'text-gray-500'}`}
        >
          Inventory ({equipmentQ.data?.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setTab('active')}
          className={`px-4 py-2 text-sm font-medium ${tab === 'active' ? 'border-b-2 border-campus-700 text-campus-700' : 'text-gray-500'}`}
        >
          Active checkouts ({activeCheckoutsQ.data?.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setTab('overdue')}
          className={`px-4 py-2 text-sm font-medium ${tab === 'overdue' ? 'border-b-2 border-rose-700 text-rose-700' : 'text-gray-500'}`}
        >
          Overdue ({overdueQ.data?.length ?? 0})
        </button>
      </div>

      {tab === 'inventory' && (
        <section>
          {equipmentQ.isLoading ? (
            <LoadingSpinner />
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">
                      Item
                    </th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">
                      Programme
                    </th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">
                      Type
                    </th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">Qty</th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">
                      Condition
                    </th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">
                      Unit cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {equipmentQ.data?.map((row) => (
                    <tr key={row.id} className="border-t border-gray-100">
                      <td className="px-4 py-3 font-medium text-gray-900">{row.itemName}</td>
                      <td className="px-4 py-3 text-gray-700">{row.programmeName ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{row.itemType}</td>
                      <td className="px-4 py-3 text-gray-700">{row.quantity}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${CONDITION_PILL[row.condition]}`}
                        >
                          {row.condition}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {row.unitCost === null ? '—' : `$${row.unitCost.toFixed(2)}`}
                      </td>
                    </tr>
                  ))}
                  {(equipmentQ.data?.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                        No equipment.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'active' && (
        <CheckoutsTable
          rows={activeCheckoutsQ.data ?? []}
          loading={activeCheckoutsQ.isLoading}
          isAd={isAd}
        />
      )}
      {tab === 'overdue' && (
        <CheckoutsTable rows={overdueQ.data ?? []} loading={overdueQ.isLoading} isAd={isAd} />
      )}
    </div>
  );
}

function CheckoutsTable({
  rows,
  loading,
  isAd,
}: {
  rows: ReturnType<typeof useEquipmentCheckouts>['data'];
  loading: boolean;
  isAd: boolean;
}) {
  if (loading) return <LoadingSpinner />;
  if (!rows || rows.length === 0)
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500">
        No checkouts.
      </div>
    );
  return (
    <div className="space-y-2">
      {rows.map((c) => (
        <CheckoutRow key={c.id} row={c} isAd={isAd} />
      ))}
    </div>
  );
}

function CheckoutRow({
  row,
  isAd,
}: {
  row: NonNullable<ReturnType<typeof useEquipmentCheckouts>['data']>[number];
  isAd: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded-lg border p-4 ${row.isOverdue ? 'border-rose-300 bg-rose-50' : 'border-gray-200 bg-white'}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="font-medium text-gray-900">{row.equipmentName ?? 'Equipment'}</div>
          <div className="text-sm text-gray-600">
            {row.assignedToName ?? 'Unknown'} · {row.itemIdentifier ?? '(no identifier)'} · checked
            out {row.checkedOutAt}
          </div>
          {row.expectedReturnDate && (
            <div className="text-xs text-gray-500">
              Expected return {row.expectedReturnDate}
              {row.isOverdue && <span className="ml-2 text-rose-700 font-medium">(overdue)</span>}
            </div>
          )}
          {row.returnedAt && (
            <div className="text-xs text-gray-700">
              Returned {row.returnedAt} — {row.conditionAtReturn}
              {row.replacementCharge !== null && row.replacementCharge > 0 && (
                <span className="ml-2 text-rose-700">
                  ${row.replacementCharge.toFixed(2)} charge
                </span>
              )}
            </div>
          )}
        </div>
        {isAd && row.returnedAt === null && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
          >
            Record return
          </button>
        )}
      </div>
      {open && <ReturnFormInline checkoutId={row.id} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ReturnFormInline({ checkoutId, onClose }: { checkoutId: string; onClose: () => void }) {
  const returnMut = useReturnCheckout(checkoutId);
  const [condition, setCondition] = useState<'GOOD' | 'DAMAGED' | 'LOST'>('GOOD');
  const [damageNotes, setDamageNotes] = useState('');
  const [replacementCharge, setReplacementCharge] = useState('');

  async function submit() {
    await returnMut.mutateAsync({
      conditionAtReturn: condition,
      damageNotes: damageNotes || undefined,
      replacementCharge: replacementCharge ? Number(replacementCharge) : undefined,
    });
    onClose();
  }

  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 space-y-2">
      <div className="flex gap-2">
        {(['GOOD', 'DAMAGED', 'LOST'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCondition(c)}
            className={`rounded-md border px-3 py-1 text-sm ${
              condition === c
                ? 'border-campus-700 bg-campus-50 text-campus-700'
                : 'border-gray-300 bg-white'
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      {(condition === 'DAMAGED' || condition === 'LOST') && (
        <>
          <textarea
            value={damageNotes}
            onChange={(e) => setDamageNotes(e.target.value)}
            placeholder="Damage notes"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={2}
          />
          <input
            type="number"
            value={replacementCharge}
            onChange={(e) => setReplacementCharge(e.target.value)}
            placeholder="Replacement charge (USD; defaults to unit cost)"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            step="0.01"
          />
        </>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={returnMut.isPending}
          className="rounded-md bg-campus-700 px-3 py-1 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
        >
          {returnMut.isPending ? 'Saving…' : 'Submit'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
