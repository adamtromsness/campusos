'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateInspection, useVehicles } from '@/hooks/use-transport';
import { INSPECTION_ITEM_LABEL } from '@/lib/transport-format';
import type { InspectionItemStatus } from '@/lib/types';

const DEFAULT_ITEMS = ['Tyres', 'Brakes', 'Lights', 'Mirrors', 'Emergency exit', 'First aid kit'];

export default function NewInspectionPage() {
  const vehiclesQ = useVehicles({ status: 'ACTIVE' });
  const [vehicleId, setVehicleId] = useState<string>('');
  const create = useCreateInspection(vehicleId);
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [items, setItems] = useState<
    { name: string; status: InspectionItemStatus; notes: string }[]
  >(() => DEFAULT_ITEMS.map((name) => ({ name, status: 'PASS', notes: '' })));
  const [notes, setNotes] = useState('');

  function setItem(idx: number, patch: Partial<(typeof items)[number]>) {
    setItems((curr) => curr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  async function submit() {
    if (!vehicleId) {
      toast('Select a vehicle', 'error');
      return;
    }
    try {
      const res = await create.mutateAsync({
        inspectionDate: date,
        notes: notes || undefined,
        items: items.map((it) => ({
          itemName: it.name,
          status: it.status,
          notes: it.notes || undefined,
        })),
      });
      toast(
        res.overallStatus === 'PASS'
          ? 'Inspection passed'
          : 'Inspection submitted (FAIL — vehicle blocked from service)',
        res.overallStatus === 'PASS' ? 'success' : 'error',
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title="Pre-trip inspection"
        description="Daily safety check — any FAIL item blocks the vehicle from service"
        actions={
          <Link
            href="/transport"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Transportation
          </Link>
        }
      />

      <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Vehicle</span>
            <select
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select a vehicle</option>
              {(vehiclesQ.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.registration} ({v.vehicleType})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Inspection date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div>
          <h3 className="text-sm font-medium text-gray-700">Checklist</h3>
          <ul className="mt-2 space-y-2">
            {items.map((it, idx) => (
              <li
                key={it.name}
                className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 font-medium text-gray-900">{it.name}</div>
                  <div className="flex gap-1.5">
                    {(['PASS', 'FAIL', 'NOT_APPLICABLE'] as InspectionItemStatus[]).map((s) => {
                      const active = it.status === s;
                      const col =
                        s === 'PASS'
                          ? active
                            ? 'bg-emerald-700 text-white border-emerald-700'
                            : 'bg-white text-emerald-700 border-emerald-300'
                          : s === 'FAIL'
                            ? active
                              ? 'bg-rose-700 text-white border-rose-700'
                              : 'bg-white text-rose-700 border-rose-300'
                            : active
                              ? 'bg-gray-700 text-white border-gray-700'
                              : 'bg-white text-gray-700 border-gray-300';
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setItem(idx, { status: s })}
                          className={`rounded-lg border px-2.5 py-1 text-xs ${col}`}
                        >
                          {INSPECTION_ITEM_LABEL[s]}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {it.status !== 'PASS' && (
                  <input
                    placeholder="Note"
                    value={it.notes}
                    onChange={(e) => setItem(idx, { notes: e.target.value })}
                    className="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs"
                  />
                )}
              </li>
            ))}
          </ul>
        </div>

        <label className="block text-sm">
          <span className="block font-medium text-gray-700">Overall notes</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={create.isPending || !vehicleId}
          className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {create.isPending ? 'Submitting…' : 'Submit inspection'}
        </button>
      </div>
    </div>
  );
}
