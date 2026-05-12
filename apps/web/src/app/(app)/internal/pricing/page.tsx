'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  formatCents,
  useCreatePricingBand,
  usePricingBands,
  usePricingHistory,
  useSupportTiers,
  useUpdatePricingBand,
} from '@/hooks/use-ops';

/**
 * P2-21b — Pricing admin.
 *
 * Edit bands, see price history audit trail per band, view support
 * tiers. Price changes require changedBy (employee id) — the service
 * writes a platform_pricing_history row inside the same tx as the
 * UPDATE so audit can never desync.
 */
export default function InternalPricingPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['ops-005:read']);
  const canWrite = !!user && hasAnyPermission(user, ['ops-005:write']);

  const bands = usePricingBands();
  const tiers = useSupportTiers();
  const create = useCreatePricingBand();

  const [selectedBandId, setSelectedBandId] = useState<string | null>(null);
  const history = usePricingHistory(selectedBandId);
  const update = useUpdatePricingBand(selectedBandId ?? '');

  const [createForm, setCreateForm] = useState({
    name: '',
    studentRangeMin: 0,
    studentRangeMax: 100,
    monthlyPriceCents: 9900,
    annualPriceCents: 99000,
  });
  const [updateForm, setUpdateForm] = useState({
    monthlyPriceCents: '',
    annualPriceCents: '',
    changedBy: '',
  });
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedBand = useMemo(
    () => (bands.data ?? []).find((b) => b.id === selectedBandId) ?? null,
    [bands.data, selectedBandId],
  );

  if (!user) return <LoadingSpinner />;
  if (!canRead) {
    return (
      <EmptyState
        title="Not available"
        description="Pricing admin requires OPS-005:read at the PLATFORM scope."
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Pricing admin"
        description="Pricing bands by school size. Price changes write an audit row inside the same tx as the UPDATE."
      />

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Pricing bands</h2>
        {bands.isLoading ? (
          <LoadingSpinner />
        ) : (bands.data ?? []).length === 0 ? (
          <EmptyState
            title="No bands"
            description="Use the form below to create the first pricing band."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs uppercase">Name</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Students</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Monthly</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Annual</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Active</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {(bands.data ?? []).map((b) => (
                  <tr key={b.id}>
                    <td className="px-4 py-2 text-sm">{b.name}</td>
                    <td className="px-4 py-2 text-sm">
                      {b.studentRangeMin}–{b.studentRangeMax ?? '∞'}
                    </td>
                    <td className="px-4 py-2 text-sm">{formatCents(b.monthlyPriceCents)}</td>
                    <td className="px-4 py-2 text-sm">{formatCents(b.annualPriceCents)}</td>
                    <td className="px-4 py-2 text-sm">
                      {b.isActive ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                          Active
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedBandId(b.id)}
                        className="text-sm text-blue-700 hover:underline"
                      >
                        Edit / history
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canWrite ? (
        <section className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="mb-3 text-sm font-semibold">Create band</h3>
          <form
            className="grid grid-cols-2 gap-3 sm:grid-cols-5"
            onSubmit={async (ev) => {
              ev.preventDefault();
              setSubmitError(null);
              try {
                await create.mutateAsync(createForm);
                setCreateForm({ ...createForm, name: '' });
              } catch (e) {
                setSubmitError((e as Error).message);
              }
            }}
          >
            <input
              placeholder="Name"
              value={createForm.name}
              required
              onChange={(ev) => setCreateForm({ ...createForm, name: ev.target.value })}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              placeholder="min students"
              value={createForm.studentRangeMin}
              onChange={(ev) =>
                setCreateForm({ ...createForm, studentRangeMin: Number(ev.target.value) })
              }
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              placeholder="max students"
              value={createForm.studentRangeMax}
              onChange={(ev) =>
                setCreateForm({ ...createForm, studentRangeMax: Number(ev.target.value) })
              }
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              placeholder="monthly cents"
              value={createForm.monthlyPriceCents}
              onChange={(ev) =>
                setCreateForm({ ...createForm, monthlyPriceCents: Number(ev.target.value) })
              }
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              placeholder="annual cents"
              value={createForm.annualPriceCents}
              onChange={(ev) =>
                setCreateForm({ ...createForm, annualPriceCents: Number(ev.target.value) })
              }
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50 sm:col-span-5"
            >
              {create.isPending ? 'Creating…' : 'Create band'}
            </button>
            {submitError ? (
              <p className="text-sm text-rose-700 sm:col-span-5">{submitError}</p>
            ) : null}
          </form>
        </section>
      ) : null}

      {selectedBand ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="mb-3 text-sm font-semibold">
            Update prices on “{selectedBand.name}” (writes audit row)
          </h3>
          {canWrite ? (
            <form
              className="grid grid-cols-1 gap-3 sm:grid-cols-3"
              onSubmit={async (ev) => {
                ev.preventDefault();
                setSubmitError(null);
                const body: {
                  monthlyPriceCents?: number;
                  annualPriceCents?: number;
                  changedBy?: string;
                } = {};
                if (updateForm.monthlyPriceCents)
                  body.monthlyPriceCents = Number(updateForm.monthlyPriceCents);
                if (updateForm.annualPriceCents)
                  body.annualPriceCents = Number(updateForm.annualPriceCents);
                if (updateForm.changedBy) body.changedBy = updateForm.changedBy;
                try {
                  await update.mutateAsync(body);
                  setUpdateForm({ monthlyPriceCents: '', annualPriceCents: '', changedBy: '' });
                } catch (e) {
                  setSubmitError((e as Error).message);
                }
              }}
            >
              <input
                type="number"
                placeholder="New monthly cents"
                value={updateForm.monthlyPriceCents}
                onChange={(ev) =>
                  setUpdateForm({ ...updateForm, monthlyPriceCents: ev.target.value })
                }
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                type="number"
                placeholder="New annual cents"
                value={updateForm.annualPriceCents}
                onChange={(ev) =>
                  setUpdateForm({ ...updateForm, annualPriceCents: ev.target.value })
                }
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                placeholder="Changed-by employee id"
                value={updateForm.changedBy}
                onChange={(ev) => setUpdateForm({ ...updateForm, changedBy: ev.target.value })}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={update.isPending}
                className="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-50 sm:col-span-3"
              >
                {update.isPending ? 'Saving…' : 'Save price change'}
              </button>
              {submitError ? (
                <p className="text-sm text-rose-700 sm:col-span-3">{submitError}</p>
              ) : null}
            </form>
          ) : null}

          <h4 className="mt-4 mb-2 text-xs font-semibold uppercase text-gray-700">Price history</h4>
          {(history.data ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">No price changes recorded.</p>
          ) : (
            <ul className="divide-y divide-amber-200">
              {(history.data ?? []).map((h) => (
                <li key={h.id} className="py-2 text-sm">
                  <span className="font-mono text-xs text-gray-600">{h.effectiveDate}</span> —
                  monthly {formatCents(h.previousMonthlyCents ?? 0)} →{' '}
                  {formatCents(h.newMonthlyCents)} / annual{' '}
                  {formatCents(h.previousAnnualCents ?? 0)} → {formatCents(h.newAnnualCents)}
                  <span className="ml-2 text-xs text-gray-500">
                    (by <span className="font-mono">{h.changedBy}</span>)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Support tiers</h2>
        {(tiers.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">No support tiers configured.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs uppercase">Name</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Response (hrs)</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Phone</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Dedicated CSM</th>
                  <th className="px-4 py-2 text-left text-xs uppercase">Monthly add-on</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {(tiers.data ?? []).map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-2 text-sm">{t.name}</td>
                    <td className="px-4 py-2 text-sm">{t.responseTimeHours}</td>
                    <td className="px-4 py-2 text-sm">{t.includesPhone ? 'Yes' : 'No'}</td>
                    <td className="px-4 py-2 text-sm">{t.includesDedicatedCsm ? 'Yes' : 'No'}</td>
                    <td className="px-4 py-2 text-sm">{formatCents(t.monthlyAddonCents)}</td>
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
