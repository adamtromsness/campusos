'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFdsDailyMenu,
  useFdsDietaryProfile,
  useFdsStudentAllergenAlerts,
  useFdsSubmitDietaryUpdate,
  useFdsTransactions,
} from '@/hooks/use-food-service';
import { useStudent } from '@/hooks/use-children';
import {
  FDS_CATEGORY_LABEL,
  FDS_CATEGORY_PILL,
  FDS_DUR_TYPE_LABEL,
  FDS_MEAL_PLAN_LABEL,
  FDS_PAYMENT_METHOD_LABEL,
  FDS_SEVERITY_LABEL,
  FDS_SEVERITY_PILL,
  formatCurrency,
} from '@/lib/food-service-format';
import type { FdsDietaryUpdateChangeType } from '@/lib/types';

export default function ChildFoodServicePage() {
  const params = useParams<{ id: string }>();
  const studentId = params?.id ?? '';
  const studentQ = useStudent(studentId);
  const profileQ = useFdsDietaryProfile(studentId);
  const alertsQ = useFdsStudentAllergenAlerts(studentId);
  const today = new Date().toISOString().slice(0, 10);
  const menuQ = useFdsDailyMenu(today, 'LUNCH');
  // Use the student's iam_person id (via the platform_students join) for the
  // patron filter on transactions; the API row-scopes parents to own children.
  const txnQ = useFdsTransactions({});
  const [showRequest, setShowRequest] = useState(false);

  const profile = profileQ.data;
  const alerts = alertsQ.data ?? [];
  const todayItems = menuQ.data?.items ?? [];
  // Transactions filtered client-side by studentName fallback (the patron_id is
  // an iam_person id, not the sis_students id; the parent's row scope server-side
  // already trims to own children).
  const studentName = studentQ.data ? `${studentQ.data.firstName} ${studentQ.data.lastName}` : null;
  const ownTxns = (txnQ.data ?? []).filter((t) => !studentName || t.patronName === studentName);

  return (
    <div>
      <PageHeader
        title={studentName ? `${studentName} — Food service` : 'Food service'}
        description="Dietary profile, allergens, today's menu, and meal history"
        actions={
          <Link
            href="/children"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← My children
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Dietary profile</h2>
          {profileQ.isLoading ? (
            <LoadingSpinner />
          ) : profile ? (
            <ul className="mt-3 space-y-1 text-sm">
              <li>
                <span className="text-gray-500">Meal plan:</span>{' '}
                <span className="font-medium">{FDS_MEAL_PLAN_LABEL[profile.mealPlanType]}</span>
              </li>
              <li>
                <span className="text-gray-500">NSLP eligibility:</span>{' '}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    profile.freeMealEligible
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {profile.freeMealEligible ? 'Free meal eligible' : 'Standard'}
                </span>
              </li>
              {profile.dietaryRestrictions.length > 0 && (
                <li>
                  <span className="text-gray-500">Restrictions:</span>{' '}
                  {profile.dietaryRestrictions.join(', ')}
                </li>
              )}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No dietary profile on file.</p>
          )}
          <button
            type="button"
            onClick={() => setShowRequest(true)}
            className="mt-3 rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Submit a dietary update request
          </button>
        </section>

        <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
          <h2 className="text-base font-semibold text-rose-900">Allergen alerts</h2>
          {alertsQ.isLoading ? (
            <LoadingSpinner />
          ) : alerts.length === 0 ? (
            <p className="mt-3 text-sm text-rose-800">No active allergen alerts.</p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${FDS_SEVERITY_PILL[a.severity]}`}
                  >
                    {FDS_SEVERITY_LABEL[a.severity]}
                  </span>
                  <span className="font-medium text-rose-900">{a.allergenDisplayName}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-rose-800">
            CRITICAL alerts auto-block POS purchases of items containing the allergen unless a
            supervisor overrides.
          </p>
        </section>
      </div>

      <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Today&apos;s lunch</h2>
        {menuQ.isLoading ? (
          <LoadingSpinner />
        ) : todayItems.length > 0 ? (
          <ul className="mt-3 grid gap-2 lg:grid-cols-2">
            {todayItems.map((it) => {
              const childAllergens = alerts.map((a) => a.allergenCode);
              const matched = it.allergenCodes.filter((code) => childAllergens.includes(code));
              return (
                <li
                  key={it.id}
                  className={`rounded-lg p-3 ${
                    matched.length > 0
                      ? 'border-2 border-rose-700 bg-rose-50'
                      : 'border border-gray-100 bg-gray-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900">{it.menuItemName}</span>
                    <span className="text-xs text-gray-500">{formatCurrency(it.unitCost)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {it.category && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${FDS_CATEGORY_PILL[it.category]}`}
                      >
                        {FDS_CATEGORY_LABEL[it.category]}
                      </span>
                    )}
                    {it.allergenCodes.map((code) => (
                      <span
                        key={code}
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          matched.includes(code)
                            ? 'bg-rose-700 text-white'
                            : 'bg-rose-100 text-rose-700'
                        }`}
                      >
                        {code}
                      </span>
                    ))}
                  </div>
                  {matched.length > 0 && (
                    <p className="mt-1 text-xs font-medium text-rose-900">
                      🚨 Contains your child&apos;s CRITICAL allergens — POS will block.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No lunch menu published for today.</p>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Meal history</h2>
        {txnQ.isLoading ? (
          <LoadingSpinner />
        ) : ownTxns.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm">
            {ownTxns.slice(0, 30).map((t) => (
              <li
                key={t.id}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
              >
                <span className="text-gray-700">
                  {new Date(t.servedAt).toLocaleDateString()} ·{' '}
                  {FDS_PAYMENT_METHOD_LABEL[t.paymentMethod]}
                </span>
                <span className="font-medium text-gray-900">{formatCurrency(t.total)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No recent meals.</p>
        )}
      </section>

      {showRequest && (
        <DietaryRequestModal studentId={studentId} onClose={() => setShowRequest(false)} />
      )}
    </div>
  );
}

function DietaryRequestModal({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const submit = useFdsSubmitDietaryUpdate();
  const { toast } = useToast();
  const [changeType, setChangeType] = useState<FdsDietaryUpdateChangeType>('ADD_RESTRICTION');
  const [proposedValue, setProposedValue] = useState('');
  const [reason, setReason] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="Submit a dietary update request"
      footer={
        <button
          type="button"
          onClick={async () => {
            try {
              await submit.mutateAsync({
                studentId,
                changeType,
                proposedValue,
                reason: reason || undefined,
              });
              toast('Request submitted — pending FSM review', 'success');
              onClose();
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={submit.isPending || !proposedValue}
          className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {submit.isPending ? 'Submitting…' : 'Submit'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <fieldset>
          <legend className="block font-medium text-gray-700">Change type</legend>
          <select
            value={changeType}
            onChange={(e) => setChangeType(e.target.value as FdsDietaryUpdateChangeType)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {(Object.keys(FDS_DUR_TYPE_LABEL) as FdsDietaryUpdateChangeType[]).map((c) => (
              <option key={c} value={c}>
                {FDS_DUR_TYPE_LABEL[c]}
              </option>
            ))}
          </select>
        </fieldset>
        <label className="block">
          <span className="block font-medium text-gray-700">Proposed value</span>
          <input
            value={proposedValue}
            onChange={(e) => setProposedValue(e.target.value)}
            placeholder="e.g. HALAL, PEANUTS, VEGETARIAN"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Reason (optional)</span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
