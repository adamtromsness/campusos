'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useGateScan } from '@/hooks/use-events';
import { EVT_SCAN_RESULT_LABELS, EVT_SCAN_RESULT_PILL, formatDateTime } from '@/lib/events-format';
import type { EvtGateScanResultDto, EvtScanResult } from '@/lib/types';
import { ApiError } from '@/lib/api-client';

interface ScanRow {
  at: string;
  token: string;
  result: EvtScanResult;
  holder?: string | null;
  tier?: string | null;
  event?: string | null;
  message: string;
}

export default function GateScannerPage() {
  const user = useAuthStore((s) => s.user);
  const allowed = user ? hasAnyPermission(user, ['evt-001:write', 'sch-001:admin']) : false;

  const [token, setToken] = useState('');
  const scan = useGateScan();
  const [history, setHistory] = useState<ScanRow[]>([]);
  const [last, setLast] = useState<EvtGateScanResultDto | null>(null);

  const stats = useMemo(() => {
    const total = history.length;
    const valid = history.filter((r) => r.result === 'VALID').length;
    const already = history.filter((r) => r.result === 'ALREADY_SCANNED').length;
    const invalid = history.filter((r) => r.result === 'INVALID').length;
    const expired = history.filter((r) => r.result === 'EXPIRED').length;
    return { total, valid, already, invalid, expired };
  }, [history]);

  if (!allowed) {
    return (
      <div>
        <PageHeader title="Gate scanner" description="" />
        <p className="text-sm text-gray-600">
          Gate scanning requires evt-001:write (school admin or event manager).
        </p>
      </div>
    );
  }

  async function doScan() {
    const t = token.trim();
    if (t.length === 0) return;
    try {
      const result = await scan.mutateAsync({ qrCodeToken: t, scanSource: 'WEB_GATE' });
      setLast(result);
      setHistory((h) =>
        [
          {
            at: result.scannedAt,
            token: t,
            result: result.scanResult,
            holder: result.holderName,
            tier: result.tierName,
            event: result.eventTitle,
            message: result.message,
          },
          ...h,
        ].slice(0, 50),
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setLast({
        scanResult: 'INVALID',
        ticketId: null,
        holderName: null,
        tierName: null,
        eventTitle: null,
        scannedAt: new Date().toISOString(),
        message: msg,
      });
    }
    setToken('');
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Gate scanner"
        description="Atomic scan — every attempt is logged. Paste or scan a QR token, then press Enter."
        actions={
          <Link href="/events" className="text-sm text-blue-700 hover:underline">
            ← Back to events
          </Link>
        }
      />

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Scans" value={stats.total} />
        <Stat label="Admitted" value={stats.valid} tone="emerald" />
        <Stat label="Already scanned" value={stats.already} tone="amber" />
        <Stat label="Invalid" value={stats.invalid} tone="rose" />
        <Stat label="Expired" value={stats.expired} tone="gray" />
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void doScan();
          }}
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
        >
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="QR token — paste or scan"
            autoFocus
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
          />
          <button
            type="submit"
            disabled={scan.isPending || token.trim().length === 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-gray-300"
          >
            {scan.isPending ? 'Scanning…' : 'Scan'}
          </button>
        </form>

        {last && (
          <div
            className={`mt-4 flex flex-col items-center gap-2 rounded-md p-6 text-center ${
              EVT_SCAN_RESULT_PILL[last.scanResult]
            }`}
          >
            <div className="text-3xl font-bold uppercase tracking-wide">
              {EVT_SCAN_RESULT_LABELS[last.scanResult]}
            </div>
            <div className="text-sm">{last.message}</div>
            {last.eventTitle && <div className="text-xs opacity-90">{last.eventTitle}</div>}
            {(last.holderName || last.tierName) && (
              <div className="text-xs opacity-90">
                {[last.tierName, last.holderName].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold uppercase text-gray-600">Recent scans</h3>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500">No scans this session.</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    When
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Result
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Token
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Event / holder
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((r, idx) => (
                  <tr key={`${r.token}-${idx}`}>
                    <td className="px-3 py-2 text-gray-600">{formatDateTime(r.at)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          EVT_SCAN_RESULT_PILL[r.result]
                        }`}
                      >
                        {EVT_SCAN_RESULT_LABELS[r.result]}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-500">
                      {r.token.slice(0, 16)}…
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {[r.event, r.tier, r.holder].filter(Boolean).join(' · ') || r.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'emerald' | 'amber' | 'rose' | 'gray';
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'rose'
          ? 'text-rose-700'
          : tone === 'gray'
            ? 'text-gray-600'
            : 'text-gray-900';
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 text-center shadow-sm">
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
