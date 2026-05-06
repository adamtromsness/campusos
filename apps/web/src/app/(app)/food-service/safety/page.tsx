'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useFdsCreateTemperatureLog, useFdsTemperatureLogs } from '@/hooks/use-food-service';
import { FDS_TEMP_LOCATION_LABEL } from '@/lib/food-service-format';
import type { FdsTempCheckLocation } from '@/lib/types';

const SAFE_RANGE: Record<FdsTempCheckLocation, { min: number; max: number }> = {
  DELIVERY: { min: 0, max: 5 },
  REFRIGERATOR: { min: 0, max: 5 },
  FREEZER: { min: -25, max: -18 },
  SERVING_LINE: { min: 60, max: 80 },
  HOT_HOLD: { min: 63, max: 74 },
  COLD_HOLD: { min: 0, max: 5 },
  COOK_TEMP: { min: 74, max: 100 },
};

export default function FoodSafetyPage() {
  const logsQ = useFdsTemperatureLogs({});
  const create = useFdsCreateTemperatureLog();
  const { toast } = useToast();

  const [location, setLocation] = useState<FdsTempCheckLocation>('REFRIGERATOR');
  const [locationName, setLocationName] = useState('Walk-in Fridge');
  const [tempC, setTempC] = useState<string>('3.2');
  const [corrective, setCorrective] = useState('');
  const range = SAFE_RANGE[location];
  const numeric = Number(tempC);
  const willBeCompliant = !Number.isNaN(numeric) && numeric >= range.min && numeric <= range.max;

  return (
    <div>
      <PageHeader
        title="Food safety"
        description="HACCP temperature logs with auto-compliance check"
        actions={
          <Link
            href="/food-service"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Food Service
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Log a temperature check</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Location type</span>
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value as FdsTempCheckLocation)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {(Object.keys(FDS_TEMP_LOCATION_LABEL) as FdsTempCheckLocation[]).map((loc) => (
                <option key={loc} value={loc}>
                  {FDS_TEMP_LOCATION_LABEL[loc]} ({SAFE_RANGE[loc].min}–{SAFE_RANGE[loc].max}°C)
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Location name</span>
            <input
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Temperature (°C)</span>
            <input
              type="number"
              step="0.1"
              value={tempC}
              onChange={(e) => setTempC(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="text-sm">
            <span className="block font-medium text-gray-700">Auto-check</span>
            <div
              className={`mt-1 rounded-lg px-3 py-2 ${
                willBeCompliant
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border border-rose-200 bg-rose-50 text-rose-800'
              }`}
            >
              {willBeCompliant
                ? `Compliant (${numeric}°C in range ${range.min}–${range.max})`
                : `NON-COMPLIANT (${numeric}°C outside range ${range.min}–${range.max})`}
            </div>
          </div>
        </div>
        {!willBeCompliant && (
          <label className="mt-3 block text-sm">
            <span className="block font-medium text-rose-800">Corrective action (required)</span>
            <textarea
              rows={2}
              value={corrective}
              onChange={(e) => setCorrective(e.target.value)}
              placeholder="Describe the corrective action taken"
              className="mt-1 w-full rounded-lg border border-rose-300 px-3 py-2 text-sm"
            />
          </label>
        )}
        <button
          type="button"
          onClick={async () => {
            if (!willBeCompliant && !corrective) {
              toast('Corrective action required for non-compliant readings', 'error');
              return;
            }
            try {
              await create.mutateAsync({
                checkLocation: location,
                locationName,
                temperatureCelsius: numeric,
                safeRangeMin: range.min,
                safeRangeMax: range.max,
                correctiveAction: !willBeCompliant ? corrective : undefined,
              });
              toast('Temperature log recorded', 'success');
              setCorrective('');
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={create.isPending || !locationName}
          className="mt-3 rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {create.isPending ? 'Recording…' : 'Record temperature'}
        </button>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Recent logs</h2>
        {logsQ.isLoading ? (
          <LoadingSpinner />
        ) : logsQ.data && logsQ.data.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {logsQ.data.map((l) => (
              <li
                key={l.id}
                className={`rounded-lg p-3 text-sm ${
                  l.isCompliant
                    ? 'border border-gray-100 bg-gray-50'
                    : 'border border-rose-200 bg-rose-50'
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">
                      {FDS_TEMP_LOCATION_LABEL[l.checkLocation]} · {l.locationName}
                    </div>
                    <div className="text-xs text-gray-500">
                      {l.temperatureCelsius}°C · range {l.safeRangeMin}–{l.safeRangeMax} ·{' '}
                      {new Date(l.loggedAt).toLocaleString()}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      l.isCompliant
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-rose-100 text-rose-700'
                    }`}
                  >
                    {l.isCompliant ? 'Compliant' : 'NON-COMPLIANT'}
                  </span>
                </div>
                {l.correctiveAction && (
                  <p className="mt-1 text-xs italic text-rose-800">
                    Corrective action: {l.correctiveAction}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No temperature logs yet.</p>
        )}
      </section>
    </div>
  );
}
