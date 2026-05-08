'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { usePositionTree, type PositionTreeNode } from '@/hooks/use-configuration';

/**
 * Step 4 — Position Structure Manager.
 *
 * Org-chart view of the reports-to hierarchy + list-view toggle +
 * vacancy dashboard. Render-only — drag-reassign is a polish item
 * deferred until the Wave 2 HR cycle ships its position editor.
 *
 * Per docs/campusos-school-configuration-admin.html step 04. Gated
 * on sys-001:admin.
 */

export default function PositionsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const tree = usePositionTree(isAdmin);
  const [view, setView] = useState<'chart' | 'list'>('chart');

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Position Structure" />
        <EmptyState
          title="Admin access required"
          description="The Position Manager is gated on the SYS-001:admin permission."
        />
      </div>
    );
  }

  const data = tree.data;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageHeader title="Position Structure" />
          <p className="-mt-1 text-sm text-gray-600">
            <Link href="/admin/configuration" className="text-campus-700 hover:underline">
              ← Configuration
            </Link>
            {' · '}Positions, departments, and reports-to chains.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setView('chart')}
            className={`rounded-md px-3 py-1.5 text-sm ${
              view === 'chart'
                ? 'bg-campus-700 text-white'
                : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Org chart
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            className={`rounded-md px-3 py-1.5 text-sm ${
              view === 'list'
                ? 'bg-campus-700 text-white'
                : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            List
          </button>
        </div>
      </div>

      {tree.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading positions…
        </div>
      )}

      {tree.isError && <p className="text-sm text-rose-600">Failed to load positions.</p>}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            <Stat label="Total positions" value={data.totalPositions} tone="campus" />
            <Stat label="Filled" value={data.filledCount} tone="emerald" />
            <Stat
              label="Vacant"
              value={data.vacantCount}
              tone={data.vacantCount > 0 ? 'amber' : 'gray'}
            />
          </section>

          {data.vacantPositions.length > 0 && (
            <section className="rounded-card border border-amber-300 bg-amber-50 p-4">
              <h2 className="mb-2 text-sm font-semibold text-amber-900">
                Vacant positions ({data.vacantPositions.length})
              </h2>
              <ul className="space-y-1 text-sm text-amber-900">
                {data.vacantPositions.map((p) => (
                  <li key={p.id} className="flex items-center justify-between">
                    <span>
                      <strong>{p.title}</strong>
                      {p.departmentName && (
                        <span className="ml-2 text-amber-700">· {p.departmentName}</span>
                      )}
                    </span>
                    <span className="text-xs uppercase tracking-wide text-amber-700">vacant</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view === 'chart' ? (
            <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-600">
                Reports-to chart
              </h2>
              {data.roots.length === 0 ? (
                <p className="text-sm text-gray-500">No positions configured yet.</p>
              ) : (
                <div className="space-y-3">
                  {data.roots.map((r) => (
                    <PositionTreeBranch key={r.id} node={r} depth={0} />
                  ))}
                </div>
              )}
            </section>
          ) : (
            <section className="rounded-card border border-gray-200 bg-white shadow-card">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200 text-left">
                    <th className="px-4 py-2 font-semibold text-gray-700">Title</th>
                    <th className="px-4 py-2 font-semibold text-gray-700">Department</th>
                    <th className="px-4 py-2 font-semibold text-gray-700">Filled by</th>
                    <th className="px-4 py-2 font-semibold text-gray-700">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.flatList.map((p) => (
                    <tr key={p.id} className="border-b border-gray-100">
                      <td className="px-4 py-2">{p.title}</td>
                      <td className="px-4 py-2 text-gray-700">{p.departmentName ?? '—'}</td>
                      <td className="px-4 py-2 text-gray-700">{p.filledByName ?? '—'}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-semibold ${
                            p.filledByEmployeeId
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {p.filledByEmployeeId ? 'Filled' : 'Vacant'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function PositionTreeBranch({ node, depth }: { node: PositionTreeNode; depth: number }) {
  return (
    <div style={{ paddingLeft: `${depth * 24}px` }}>
      <div
        className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${
          node.filledByEmployeeId ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50'
        }`}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{node.title}</p>
          <p className="text-xs text-gray-500">
            {node.departmentName ?? 'No department'}
            {node.isTeachingRole && ' · Teaching role'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-sm ${node.filledByEmployeeId ? 'text-gray-900' : 'text-amber-700'}`}>
            {node.filledByName ?? 'Vacant'}
          </p>
        </div>
      </div>
      {node.children.length > 0 && (
        <div className="mt-2 space-y-2">
          {node.children.map((c) => (
            <PositionTreeBranch key={c.id} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
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
  tone: 'campus' | 'emerald' | 'amber' | 'gray';
}) {
  const map: Record<typeof tone, string> = {
    campus: 'text-campus-700',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    gray: 'text-gray-700',
  };
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
      <p className="text-xs uppercase tracking-wide text-gray-600">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${map[tone]}`}>{value}</p>
    </div>
  );
}
