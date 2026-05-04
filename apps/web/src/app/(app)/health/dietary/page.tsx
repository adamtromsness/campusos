'use client';

import { useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAllergenAlerts, useUpdateDietaryProfile } from '@/hooks/use-health';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { SEVERITIES, SEVERITY_LABELS, SEVERITY_PILL } from '@/lib/health-format';
import type {
  ConditionSeverity,
  DietaryAllergenDto,
  DietaryProfileDto,
  UpdateDietaryProfilePayload,
} from '@/lib/types';

/* /health/dietary — admin / nurse list of students with cafeteria
 * allergen alerts (pos_allergen_alert=true). Hits the Step 3 partial
 * INDEX. Per-row inline edit modal mutates allergens / restrictions /
 * POS alert flag / special meal instructions.
 */

export default function DietaryAdminPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['hlt-001:read']);
  const canWrite = !!user && hasAnyPermission(user, ['hlt-005:write']);
  const alerts = useAllergenAlerts(canRead);
  const [editing, setEditing] = useState<DietaryProfileDto | null>(null);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <PageHeader title="Dietary alerts" />
        <EmptyState title="Not available" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Dietary alerts"
        description="Students with cafeteria allergen alerts. The POS / cafeteria integration reads from this list at checkout."
        actions={
          <Link
            href="/health"
            className="text-sm font-medium text-campus-600 hover:text-campus-700"
          >
            ← Health
          </Link>
        }
      />

      {alerts.isLoading ? (
        <LoadingSpinner />
      ) : (alerts.data ?? []).length === 0 ? (
        <EmptyState
          title="No allergen alerts on file"
          description="Toggle a student's POS allergen alert flag from their health record's Dietary tab."
        />
      ) : (
        <ul className="space-y-2">
          {(alerts.data ?? []).map((p) => (
            <li key={p.id} className="rounded-md border border-gray-200 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-gray-900">
                    {p.studentName ?? p.studentId.slice(0, 8)}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {p.allergens.map((a, i) => (
                      <span
                        key={i}
                        className={
                          'rounded-full px-2 py-0.5 text-xs font-medium ' +
                          SEVERITY_PILL[a.severity]
                        }
                      >
                        {a.allergen} · {SEVERITY_LABELS[a.severity]}
                      </span>
                    ))}
                  </div>
                  {p.dietaryRestrictions.length > 0 ? (
                    <p className="mt-1 text-xs text-gray-600">
                      Restrictions: {p.dietaryRestrictions.join(', ')}
                    </p>
                  ) : null}
                  {p.specialMealInstructions ? (
                    <p className="mt-1 text-xs text-gray-600">{p.specialMealInstructions}</p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {p.posAllergenAlert ? (
                    <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
                      POS alert
                    </span>
                  ) : null}
                  <Link
                    href={`/health/students/${p.studentId}`}
                    className="text-xs font-medium text-campus-600 hover:text-campus-700"
                  >
                    Open record →
                  </Link>
                  {canWrite ? (
                    <button
                      type="button"
                      onClick={() => setEditing(p)}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? <DietaryEditModal profile={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

// ─── Edit modal ────────────────────────────────────────────

function DietaryEditModal({
  profile,
  onClose,
}: {
  profile: DietaryProfileDto;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateDietaryProfile(profile.id);
  const [allergens, setAllergens] = useState<DietaryAllergenDto[]>(profile.allergens);
  const [restrictions, setRestrictions] = useState(profile.dietaryRestrictions.join(', '));
  const [posAllergenAlert, setPosAllergenAlert] = useState(profile.posAllergenAlert);
  const [specialMealInstructions, setSpecialMealInstructions] = useState(
    profile.specialMealInstructions ?? '',
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: UpdateDietaryProfilePayload = {
      dietaryRestrictions: restrictions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      allergens: allergens.filter((a) => a.allergen.trim().length > 0),
      specialMealInstructions: specialMealInstructions || null,
      posAllergenAlert,
    };
    update.mutate(payload, {
      onSuccess: () => {
        toast('Dietary profile updated', 'success');
        onClose();
      },
      onError: (e) => toast((e as Error).message, 'error'),
    });
  };

  return (
    <Modal
      open={true}
      title={`Edit dietary profile · ${profile.studentName ?? ''}`}
      onClose={onClose}
      size="lg"
    >
      <form className="space-y-3" onSubmit={submit}>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Allergens
          </label>
          <ul className="mt-1 space-y-2">
            {allergens.map((a, i) => (
              <li key={i} className="grid grid-cols-12 gap-2">
                <input
                  type="text"
                  value={a.allergen}
                  onChange={(e) => {
                    const next = allergens.slice();
                    next[i] = { ...a, allergen: e.target.value };
                    setAllergens(next);
                  }}
                  className="col-span-5 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Allergen"
                />
                <select
                  value={a.severity}
                  onChange={(e) => {
                    const next = allergens.slice();
                    next[i] = { ...a, severity: e.target.value as ConditionSeverity };
                    setAllergens(next);
                  }}
                  className="col-span-3 rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {SEVERITY_LABELS[s]}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={a.reaction ?? ''}
                  onChange={(e) => {
                    const next = allergens.slice();
                    next[i] = { ...a, reaction: e.target.value || null };
                    setAllergens(next);
                  }}
                  className="col-span-3 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Reaction (optional)"
                />
                <button
                  type="button"
                  onClick={() => setAllergens(allergens.filter((_, j) => j !== i))}
                  className="col-span-1 rounded-md border border-rose-200 bg-rose-50 px-2 text-xs font-medium text-rose-700 hover:bg-rose-100"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() =>
              setAllergens([...allergens, { allergen: '', severity: 'MODERATE', reaction: null }])
            }
            className="mt-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            + Add allergen
          </button>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Dietary restrictions (comma-separated)
          </label>
          <input
            type="text"
            value={restrictions}
            onChange={(e) => setRestrictions(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="e.g. vegetarian, gluten-free"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Special meal instructions
          </label>
          <textarea
            rows={2}
            value={specialMealInstructions}
            onChange={(e) => setSpecialMealInstructions(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={posAllergenAlert}
            onChange={(e) => setPosAllergenAlert(e.target.checked)}
          />
          Show allergen alert at the cafeteria POS
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={update.isPending}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
