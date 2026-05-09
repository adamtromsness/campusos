'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useProcedures } from '@/hooks/use-incidents';
import { PROCEDURE_LABEL, PROCEDURE_TYPES } from '@/lib/incidents-format';

/**
 * Read-only procedure viewer for everyone with saf-001:read.
 * Admins see edit + create links — admin CRUD lives at the root
 * /emergency/procedures route since the cycle is shipping the
 * minimum admin surface (the form is intentionally simple).
 */
export default function ProceduresPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['saf-001:admin']);
  const procedures = useProcedures(isAdmin);
  const [filterType, setFilterType] = useState<string>('');

  const rows = (procedures.data ?? []).filter((p) =>
    filterType ? p.procedureType === filterType : true,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Emergency Procedures</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/emergency">
          ← Back to dashboard
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">Filter:</label>
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="">All types</option>
          {PROCEDURE_TYPES.map((t) => (
            <option key={t} value={t}>
              {PROCEDURE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      {procedures.isLoading ? <p className="text-slate-500">Loading…</p> : null}

      <div className="space-y-4">
        {rows.map((p) => (
          <article key={p.id} className="rounded border border-slate-200 bg-white p-5">
            <header className="mb-3 flex items-baseline justify-between">
              <div>
                <h2 className="text-lg font-semibold">{p.title}</h2>
                <p className="text-sm text-slate-500">
                  {PROCEDURE_LABEL[p.procedureType]} · last reviewed {p.lastReviewedAt} · next
                  review {p.nextReviewDate}
                </p>
              </div>
              {!p.isActive ? (
                <span className="rounded bg-slate-200 px-2 py-1 text-xs">INACTIVE</span>
              ) : null}
            </header>

            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Steps</h3>
            <ol className="mb-4 space-y-1 text-sm">
              {p.procedureSteps.map((s) => (
                <li key={s.stepNumber} className="flex gap-3">
                  <span className="font-mono text-xs text-slate-500">{s.stepNumber}.</span>
                  <div className="flex-1">
                    <div>{s.action}</div>
                    {s.responsibleRole || s.timeTargetSeconds ? (
                      <div className="text-xs text-slate-500">
                        {s.responsibleRole ? `Owner: ${s.responsibleRole}` : ''}
                        {s.responsibleRole && s.timeTargetSeconds ? ' · ' : ''}
                        {s.timeTargetSeconds ? `Target: ${s.timeTargetSeconds}s` : ''}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>

            <div className="grid gap-3 text-sm md:grid-cols-2">
              {p.assemblyPoints && p.assemblyPoints.length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Assembly points
                  </h3>
                  <ul className="space-y-1">
                    {p.assemblyPoints.map((a, i) => (
                      <li key={i}>
                        <span className="font-medium">#{a.priority}</span> {a.name}
                        {a.capacity ? ` (cap ${a.capacity})` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {p.externalContacts && p.externalContacts.length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    External contacts
                  </h3>
                  <ul className="space-y-1">
                    {p.externalContacts.map((c, i) => (
                      <li key={i}>
                        <span className="font-medium">{c.agency}</span> · {c.phone}
                        {c.notes ? ` — ${c.notes}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {(procedures.data ?? []).length === 0 && !procedures.isLoading ? (
        <p className="rounded border border-slate-200 bg-white p-5 text-sm text-slate-500">
          No procedures configured. {isAdmin ? 'Use the API to seed your school’s procedures.' : ''}
        </p>
      ) : null}
    </div>
  );
}
