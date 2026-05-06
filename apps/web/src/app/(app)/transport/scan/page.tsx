'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useScanRidership,
  useTransportRouteStops,
  useTransportRoutes,
} from '@/hooks/use-transport';
import { SCAN_DIRECTION_LABEL } from '@/lib/transport-format';
import type { ScanDirection } from '@/lib/types';

export default function ScanPage() {
  const routesQ = useTransportRoutes({ status: 'ACTIVE' });
  const [routeId, setRouteId] = useState<string | null>(null);
  const stopsQ = useTransportRouteStops(routeId);
  const [stopId, setStopId] = useState<string>('');
  const [direction, setDirection] = useState<ScanDirection>('BOARDING');
  const [token, setToken] = useState('');
  const scan = useScanRidership();
  const { toast } = useToast();
  const [lastScan, setLastScan] = useState<string | null>(null);

  async function submit() {
    if (!stopId || !token) {
      toast('Pick a stop and enter a QR token', 'error');
      return;
    }
    try {
      const res = await scan.mutateAsync({
        qrCodeToken: token.trim(),
        stopId,
        scanDirection: direction,
      });
      const name = res.studentName ?? 'student';
      toast(`${SCAN_DIRECTION_LABEL[direction]} recorded for ${name}`, 'success');
      setLastScan(
        `${name} · ${res.stopName ?? '—'} · ${new Date(res.scannedAt).toLocaleTimeString()}`,
      );
      setToken('');
    } catch (err) {
      const message = (err as Error).message ?? 'Scan failed';
      toast(message, 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title="Ridership scanner"
        description="Scan QR-coded bus passes for boarding or alighting"
        actions={
          <Link
            href="/transport"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Transportation
          </Link>
        }
      />

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="grid gap-3">
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Route</span>
            <select
              value={routeId ?? ''}
              onChange={(e) => {
                setRouteId(e.target.value || null);
                setStopId('');
              }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select a route</option>
              {(routesQ.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.direction})
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Stop</span>
            <select
              value={stopId}
              onChange={(e) => setStopId(e.target.value)}
              disabled={!routeId}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
            >
              <option value="">Select a stop</option>
              {(stopsQ.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  #{s.sequenceOrder} · {s.name}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="text-sm">
            <legend className="block font-medium text-gray-700">Direction</legend>
            <div className="mt-1 flex gap-2">
              {(['BOARDING', 'ALIGHTING'] as ScanDirection[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDirection(d)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
                    direction === d
                      ? 'border-campus-700 bg-campus-700 text-white'
                      : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {SCAN_DIRECTION_LABEL[d]}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block text-sm">
            <span className="block font-medium text-gray-700">QR token</span>
            <input
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="Scan or paste the QR token from the bus pass"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={scan.isPending || !routeId || !stopId || !token}
            className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {scan.isPending ? 'Scanning…' : 'Record scan'}
          </button>

          {lastScan && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Last scan: {lastScan}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
