'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui';
import { useErasures, usePseudonymisations, usePseudonymise } from '@/hooks/use-governance';
import {
  ERASURE_STATUS_LABELS,
  ERASURE_STATUS_PILL,
  formatDateTime,
} from '@/lib/governance-format';

export default function ErasuresPage() {
  const erasures = useErasures();
  const pseudoLog = usePseudonymisations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  return (
    <div>
      <PageHeader
        title="Erasure & pseudonymisation"
        description="GDPR Article 17 Right to Erasure. Audit log fields can be pseudonymised in place via the IMMUTABLE pseudonymisation log keystone (ADR-052)."
      />

      <Link
        href="/governance"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-campus-700"
      >
        ← Back to compliance dashboard
      </Link>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
          Erasure requests
        </h2>
        {erasures.isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : !erasures.data || erasures.data.length === 0 ? (
          <p className="text-sm text-gray-500">No erasure requests.</p>
        ) : (
          <ul className="space-y-3">
            {erasures.data.map((e) => (
              <li key={e.id} className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-gray-900">
                      Subject {e.dataSubjectId.slice(0, 8)}…
                    </div>
                    {e.requestDetails && (
                      <div className="mt-1 text-xs text-gray-600">{e.requestDetails}</div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {e.categoriesErased.length > 0 && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">
                          {e.categoriesErased.length} erased
                        </span>
                      )}
                      {e.categoriesRetained.length > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">
                          {e.categoriesRetained.length} retained
                        </span>
                      )}
                      {e.categoriesPseudonymised.length > 0 && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-700">
                          {e.categoriesPseudonymised.length} pseudonymised
                        </span>
                      )}
                    </div>
                    {e.notes && <div className="mt-2 text-xs text-gray-500">{e.notes}</div>}
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      ERASURE_STATUS_PILL[e.status] ?? 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {ERASURE_STATUS_LABELS[e.status] ?? e.status}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <button
                    onClick={() => setActiveId(activeId === e.id ? null : e.id)}
                    className="text-xs text-campus-700 hover:underline"
                  >
                    {activeId === e.id ? 'Hide' : 'Show'} audit pseudonymisation log
                  </button>
                  {e.status !== 'COMPLETED' && e.status !== 'DENIED' && (
                    <PseudoButton erasureId={e.id} running={running} setRunning={setRunning} />
                  )}
                </div>
                {activeId === e.id && (
                  <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 p-3">
                    <PseudoLogList erasureId={e.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
          Recent pseudonymisations (IMMUTABLE log)
        </h2>
        {pseudoLog.isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : !pseudoLog.data || pseudoLog.data.length === 0 ? (
          <p className="text-sm text-gray-500">No pseudonymisation events recorded yet.</p>
        ) : (
          <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
                <tr>
                  <th className="px-4 py-2">Token</th>
                  <th className="px-4 py-2">Target</th>
                  <th className="px-4 py-2">Rows</th>
                  <th className="px-4 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {pseudoLog.data.map((row) => (
                  <tr key={row.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 font-mono text-xs text-violet-700">
                      {row.pseudonymisationToken}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {row.targetTable}.{row.targetField}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                      {row.rowsPseudonymised.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDateTime(row.pseudonymisedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PseudoButton({
  erasureId,
  running,
  setRunning,
}: {
  erasureId: string;
  running: boolean;
  setRunning: (v: boolean) => void;
}) {
  const mutate = usePseudonymise(erasureId);
  const { toast } = useToast();
  return (
    <button
      onClick={async () => {
        if (
          !confirm(
            'Pseudonymise platform_audit_log.metadata for this data subject? This action is irreversible — the IMMUTABLE pseudonymisation log will record the operation.',
          )
        )
          return;
        setRunning(true);
        try {
          const log = await mutate.mutateAsync({
            targetTable: 'platform_audit_log',
            targetField: 'metadata',
          });
          toast(
            `Pseudonymised ${log.rowsPseudonymised} audit log rows. Token ${log.pseudonymisationToken}.`,
            'success',
          );
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Pseudonymisation failed.', 'error');
        } finally {
          setRunning(false);
        }
      }}
      disabled={running || mutate.isPending}
      className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700 hover:border-violet-400 disabled:opacity-50"
    >
      Pseudonymise audit log
    </button>
  );
}

function PseudoLogList({ erasureId }: { erasureId: string }) {
  const log = usePseudonymisations(erasureId);
  if (log.isLoading) return <p className="text-xs text-gray-500">Loading log…</p>;
  if (!log.data || log.data.length === 0)
    return <p className="text-xs text-gray-500">No log entries for this erasure yet.</p>;
  return (
    <ul className="space-y-2 text-xs">
      {log.data.map((row) => (
        <li key={row.id} className="rounded-md border border-gray-200 bg-white p-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-violet-700">{row.pseudonymisationToken}</span>
            <span className="text-gray-500">{formatDateTime(row.pseudonymisedAt)}</span>
          </div>
          <div className="mt-1 text-gray-700">
            {row.targetTable}.{row.targetField} · {row.rowsPseudonymised} rows
          </div>
        </li>
      ))}
    </ul>
  );
}
