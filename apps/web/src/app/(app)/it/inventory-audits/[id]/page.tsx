'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCompleteItInventoryAudit,
  useItInventoryAudit,
  useItInventoryAuditItems,
  useItInventoryAuditReport,
  useScanItInventoryAudit,
} from '@/hooks/use-it-advanced';
import {
  IT_AUDIT_STATUS_LABELS,
  IT_AUDIT_STATUS_PILL,
  formatItDate,
  formatItDateTime,
} from '@/lib/it-advanced-format';
import type { ItInventoryConditionObserved } from '@/lib/types';

const CONDITIONS: ItInventoryConditionObserved[] = ['EXCELLENT', 'GOOD', 'FAIR', 'DAMAGED'];

export default function InventoryAuditDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const audit = useItInventoryAudit(id);
  const items = useItInventoryAuditItems(id);
  const report = useItInventoryAuditReport(id);
  const scan = useScanItInventoryAudit(id);
  const complete = useCompleteItInventoryAudit();
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const canWrite = hasAnyPermission(user, ['it-002:write']);

  const [tag, setTag] = useState('');
  const [condition, setCondition] = useState<ItInventoryConditionObserved>('GOOD');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');

  if (audit.isLoading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (!audit.data) {
    return <div className="p-6 text-sm text-rose-700">Audit not found.</div>;
  }
  const a = audit.data;
  const isInProgress = a.status === 'IN_PROGRESS';

  const scanFound = async () => {
    if (!tag.trim()) {
      toast('Scan an asset tag.', 'warning');
      return;
    }
    try {
      const result = await scan.mutateAsync({
        assetTag: tag.trim(),
        found: true,
        conditionObserved: condition,
        locationObserved: location.trim() || undefined,
        discrepancyNotes: notes.trim() || undefined,
      });
      if (result.assetId === null) {
        toast(`Unknown tag ${tag.trim()} — counted as unrecorded.`, 'warning');
      } else {
        toast(`${tag.trim()} found.`, 'success');
      }
      setTag('');
      setNotes('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Scan failed', 'error');
    }
  };

  const scanMissing = async () => {
    if (!tag.trim()) {
      toast('Asset tag required.', 'warning');
      return;
    }
    try {
      await scan.mutateAsync({
        assetTag: tag.trim(),
        found: false,
        discrepancyNotes: notes.trim() || undefined,
      });
      toast(`${tag.trim()} recorded missing.`, 'info');
      setTag('');
      setNotes('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not mark missing', 'error');
    }
  };

  const finalize = async () => {
    try {
      const result = await complete.mutateAsync(id);
      toast(
        `Audit completed — ${result.totalAssetsFound} found, ${result.totalAssetsMissing} missing, ${result.totalAssetsUnrecorded} unrecorded.`,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not complete audit', 'error');
    }
  };

  const scannedCount = items.data?.length ?? 0;
  const foundKnown = (items.data ?? []).filter((it) => it.found && it.assetId !== null).length;
  const unrecorded = (items.data ?? []).filter((it) => it.found && it.assetId === null).length;
  const missing = (items.data ?? []).filter((it) => !it.found).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <PageHeader
        title={a.auditName}
        description={a.building ? `Building ${a.building}` : 'School-wide'}
      />

      <div className="rounded-md border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <span className={`rounded px-2 py-0.5 text-xs ${IT_AUDIT_STATUS_PILL[a.status]}`}>
            {IT_AUDIT_STATUS_LABELS[a.status]}
          </span>
          <p className="text-xs text-gray-500">
            Started {formatItDate(a.auditDate)} by {a.conductedByName ?? '—'}
            {a.completedAt ? ` · Completed ${formatItDateTime(a.completedAt)}` : ''}
          </p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Stat label="Expected" value={a.totalAssetsExpected} />
          <Stat
            label="Found"
            value={isInProgress ? foundKnown : a.totalAssetsFound}
            tone="emerald"
          />
          <Stat
            label="Missing"
            value={
              isInProgress
                ? Math.max(a.totalAssetsExpected - foundKnown - unrecorded, missing)
                : a.totalAssetsMissing
            }
            tone={a.totalAssetsMissing > 0 || missing > 0 ? 'rose' : undefined}
          />
          <Stat
            label="Unrecorded"
            value={isInProgress ? unrecorded : a.totalAssetsUnrecorded}
            tone={(isInProgress ? unrecorded : a.totalAssetsUnrecorded) > 0 ? 'amber' : undefined}
          />
        </div>
      </div>

      {isInProgress && canWrite ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-4">
          <h2 className="text-sm font-semibold text-sky-900">Scan an asset</h2>
          <p className="mt-1 text-xs text-sky-700">
            Type or paste the asset tag. Unknown tags land as unrecorded so the discrepancy report
            picks them up.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium uppercase text-sky-900">Asset tag</label>
              <input
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                autoFocus
                className="mt-1 w-full rounded-md border border-sky-300 bg-white px-3 py-2 text-sm font-mono"
                placeholder="IT-CB-001"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') scanFound();
                }}
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-sky-900">Condition</label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as ItInventoryConditionObserved)}
                className="mt-1 w-full rounded-md border border-sky-300 bg-white px-3 py-2 text-sm"
              >
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-sky-900">
                Location observed
              </label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="mt-1 w-full rounded-md border border-sky-300 bg-white px-3 py-2 text-sm"
                placeholder="Room 101"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs font-medium uppercase text-sky-900">Notes (optional)</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-1 w-full rounded-md border border-sky-300 bg-white px-3 py-2 text-sm"
                placeholder="Screen cracked but powers on"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={scanFound}
              disabled={scan.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Mark found
            </button>
            <button
              type="button"
              onClick={scanMissing}
              disabled={scan.isPending}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
            >
              Mark missing
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={finalize}
              disabled={complete.isPending || scannedCount === 0}
              className="rounded-md border border-campus-600 bg-white px-3 py-1.5 text-sm font-medium text-campus-700 disabled:opacity-50 hover:bg-campus-50"
            >
              Complete audit
            </button>
          </div>
        </div>
      ) : null}

      <Section title={`Scanned items (${scannedCount})`}>
        {scannedCount === 0 ? (
          <p className="text-sm text-gray-500">No scans yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items.data?.map((it) => (
              <li key={it.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-mono text-xs font-semibold">{it.assetTag}</p>
                  <p className="text-xs text-gray-500">
                    {it.locationObserved ?? '—'}
                    {it.discrepancyNotes ? ` · ${it.discrepancyNotes}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {it.conditionObserved ? (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">
                      {it.conditionObserved}
                    </span>
                  ) : null}
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      it.found
                        ? it.assetId === null
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-100 text-emerald-700'
                        : 'bg-rose-100 text-rose-700'
                    }`}
                  >
                    {it.found ? (it.assetId === null ? 'Unrecorded' : 'Found') : 'Missing'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {!isInProgress && report.data ? (
        <Section title="Discrepancy report">
          <ReportPanel report={report.data} />
        </Section>
      ) : null}
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
  tone?: 'amber' | 'rose' | 'emerald';
}) {
  const tones: Record<NonNullable<typeof tone>, string> = {
    amber: 'text-amber-700',
    rose: 'text-rose-700',
    emerald: 'text-emerald-700',
  };
  const cls = tone ? tones[tone] : 'text-gray-900';
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-semibold ${cls}`}>{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">{title}</h2>
      {children}
    </div>
  );
}

function ReportPanel({
  report,
}: {
  report: ReturnType<typeof useItInventoryAuditReport>['data'] extends infer T
    ? T extends { audit: unknown }
      ? T
      : never
    : never;
}) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-xs font-semibold uppercase text-rose-700">
          Missing assets ({report.missingAssets.length})
        </p>
        {report.missingAssets.length === 0 ? (
          <p className="mt-1 text-xs text-gray-500">None — every expected asset was found.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {report.missingAssets.map((m) => (
              <li key={m.assetId} className="rounded border border-rose-200 bg-rose-50 p-2 text-xs">
                <p className="font-mono font-semibold">{m.assetTag}</p>
                <p className="text-gray-600">
                  Last known location: {m.lastKnownLocation ?? 'unknown'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase text-amber-700">
          Unrecorded assets ({report.unrecordedAssets.length})
        </p>
        {report.unrecordedAssets.length === 0 ? (
          <p className="mt-1 text-xs text-gray-500">No surprise devices.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {report.unrecordedAssets.map((u, idx) => (
              <li key={idx} className="rounded border border-amber-200 bg-amber-50 p-2 text-xs">
                <p className="font-mono font-semibold">{u.assetTag}</p>
                <p className="text-gray-600">
                  {u.locationObserved ?? '—'}
                  {u.notes ? ` · ${u.notes}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase text-gray-700">
          Condition observations ({report.conditionChanges.length})
        </p>
        {report.conditionChanges.length === 0 ? (
          <p className="mt-1 text-xs text-gray-500">No condition data recorded.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {report.conditionChanges.map((c) => (
              <li key={c.assetId} className="rounded border border-gray-200 p-2 text-xs">
                <p className="font-mono font-semibold">{c.assetTag}</p>
                <p className="text-gray-600">Observed condition: {c.conditionObserved}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
