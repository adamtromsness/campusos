'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  formatRemaining,
  useActiveTenantAccess,
  useGrantTenantAccess,
  useOpsEmployees,
  useRevokeTenantAccess,
  useTenantAccessAuditLog,
  type TenantAccessType,
} from '@/hooks/use-ops';

/**
 * P2-21b — Internal Ops dashboard.
 *
 * Platform Admin only. Shows the CampusOS employee directory and the
 * FERPA/GDPR-audited tenant access surface: request a grant
 * (mandatory >= 20 char justification, 4-hour max), see active grants
 * with countdown, view full audit log, revoke manually.
 */
export default function InternalOpsPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['ops-001:read', 'ops-003:read']);
  const canWrite = !!user && hasAnyPermission(user, ['ops-003:write']);

  const employees = useOpsEmployees();
  const active = useActiveTenantAccess();
  const audit = useTenantAccessAuditLog();
  const grant = useGrantTenantAccess();
  const revoke = useRevokeTenantAccess();

  const [form, setForm] = useState({
    employeeId: '',
    approvedBy: '',
    tenantSchema: '',
    justification: '',
    accessType: 'READ_ONLY' as TenantAccessType,
    durationHours: 4,
  });
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!user) return <LoadingSpinner />;
  if (!canRead) {
    return (
      <EmptyState
        title="Not available"
        description="This surface is restricted to CampusOS operators with OPS-001/003 read permissions at the PLATFORM scope."
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Internal Ops"
        description="CampusOS employee directory + FERPA/GDPR-audited tenant access grants."
      />

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Employees</h2>
        {employees.isLoading ? (
          <LoadingSpinner />
        ) : (employees.data ?? []).length === 0 ? (
          <EmptyState title="No employees yet" description="Seed ops_employees to populate." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Name (person id)
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Department
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Role
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Hired
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {(employees.data ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{e.personId}</td>
                    <td className="px-4 py-2 text-sm">{e.department}</td>
                    <td className="px-4 py-2 text-sm">{e.role}</td>
                    <td className="px-4 py-2 text-sm text-gray-600">{e.hireDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canWrite ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-6">
          <h2 className="mb-2 text-lg font-semibold text-amber-900">
            Request tenant access (FERPA/GDPR)
          </h2>
          <p className="mb-4 text-sm text-amber-800">
            Hard 4-hour maximum. Justification must be at least 20 characters. Approver must hold
            the INTERNAL_ADMIN ops_permissions scope; you cannot self-approve.
          </p>
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            onSubmit={async (ev) => {
              ev.preventDefault();
              setSubmitError(null);
              try {
                await grant.mutateAsync(form);
                setForm({ ...form, justification: '' });
              } catch (e) {
                setSubmitError((e as Error).message);
              }
            }}
          >
            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700">Employee ID</span>
              <input
                value={form.employeeId}
                onChange={(ev) => setForm({ ...form, employeeId: ev.target.value })}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700">Approver ID</span>
              <input
                value={form.approvedBy}
                onChange={(ev) => setForm({ ...form, approvedBy: ev.target.value })}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700">Tenant schema</span>
              <input
                value={form.tenantSchema}
                onChange={(ev) => setForm({ ...form, tenantSchema: ev.target.value })}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                placeholder="tenant_demo"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700">Duration (hours, 1–4)</span>
              <input
                type="number"
                min={1}
                max={4}
                value={form.durationHours}
                onChange={(ev) => setForm({ ...form, durationHours: Number(ev.target.value) })}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-gray-700">
                Justification (≥ 20 chars)
              </span>
              <textarea
                value={form.justification}
                onChange={(ev) => setForm({ ...form, justification: ev.target.value })}
                required
                minLength={20}
                rows={3}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700">Access type</span>
              <select
                value={form.accessType}
                onChange={(ev) =>
                  setForm({ ...form, accessType: ev.target.value as TenantAccessType })
                }
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="READ_ONLY">READ_ONLY</option>
                <option value="READ_WRITE">READ_WRITE</option>
              </select>
            </label>
            <div className="flex items-end justify-start sm:col-span-2">
              <button
                type="submit"
                disabled={grant.isPending}
                className="rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50"
              >
                {grant.isPending ? 'Submitting…' : 'Request access'}
              </button>
            </div>
            {submitError ? (
              <p className="text-sm text-rose-700 sm:col-span-2">{submitError}</p>
            ) : null}
          </form>
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Active grants</h2>
        {(active.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">No active grants.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs uppercase">Employee</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Tenant</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Access</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Remaining</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Justification</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {(active.data ?? []).map((g) => (
                  <tr key={g.id}>
                    <td className="px-4 py-2 font-mono text-xs">{g.employeeId}</td>
                    <td className="px-4 py-2 text-sm">{g.tenantSchema}</td>
                    <td className="px-4 py-2 text-sm">{g.accessType}</td>
                    <td className="px-4 py-2 text-sm font-medium text-amber-700">
                      {formatRemaining(g.remainingMinutes)}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-600">{g.justification}</td>
                    <td className="px-4 py-2 text-right">
                      {canWrite ? (
                        <button
                          type="button"
                          onClick={() => revoke.mutate(g.id)}
                          disabled={revoke.isPending}
                          className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Audit log (newest first)</h2>
        {(audit.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">No grants on record.</p>
        ) : (
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
            {(audit.data ?? []).slice(0, 50).map((g) => (
              <li key={g.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-gray-600">
                    {new Date(g.grantedAt).toLocaleString()}
                  </span>
                  <span className="text-xs text-gray-500">
                    {g.tenantSchema} • {g.accessType}
                  </span>
                </div>
                <p className="mt-1 text-gray-700">{g.justification}</p>
                <div className="mt-1 text-xs text-gray-500">
                  emp <span className="font-mono">{g.employeeId}</span> • approved-by{' '}
                  <span className="font-mono">{g.approvedBy}</span>
                  {g.revokedAt ? (
                    <>
                      {' '}
                      • revoked{' '}
                      <span className="text-rose-700">
                        {new Date(g.revokedAt).toLocaleString()}
                      </span>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
