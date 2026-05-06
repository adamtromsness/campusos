'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFdsDetermineEligibility,
  useFdsEligibilityApplications,
} from '@/hooks/use-food-service';
import {
  FDS_ELIGIBILITY_CATEGORY_LABEL,
  FDS_ELIGIBILITY_CATEGORY_PILL,
  FDS_ELIGIBILITY_STATUS_LABEL,
} from '@/lib/food-service-format';
import type { FdsEligibilityApplicationDto, FdsEligibilityCategory } from '@/lib/types';

export default function EligibilityPage() {
  const apps = useFdsEligibilityApplications();
  const [active, setActive] = useState<FdsEligibilityApplicationDto | null>(null);

  return (
    <div>
      <PageHeader
        title="NSLP Eligibility"
        description="Free / reduced price meal applications + determinations"
        actions={
          <Link
            href="/food-service"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Food Service
          </Link>
        }
      />

      {apps.isLoading ? (
        <LoadingSpinner />
      ) : apps.data && apps.data.length > 0 ? (
        <ul className="space-y-2">
          {apps.data.map((a) => (
            <li key={a.id} className="rounded-2xl border border-gray-200 bg-white p-4 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <div className="font-semibold text-gray-900">{a.studentName ?? 'Student'}</div>
                  <div className="text-xs text-gray-500">
                    {a.applicationType} · household size {a.householdSize}
                    {a.snapBenefitCaseNumber && ` · SNAP ${a.snapBenefitCaseNumber}`}
                  </div>
                </div>
                <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
                  {FDS_ELIGIBILITY_STATUS_LABEL[a.status]}
                </span>
              </div>
              {a.determination ? (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span
                    className={`rounded-full px-2 py-0.5 ${FDS_ELIGIBILITY_CATEGORY_PILL[a.determination.eligibilityCategory]}`}
                  >
                    {FDS_ELIGIBILITY_CATEGORY_LABEL[a.determination.eligibilityCategory]}
                  </span>
                  <span className="text-gray-500">
                    Effective {a.determination.effectiveFrom} → {a.determination.effectiveTo}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setActive(a)}
                  className="mt-2 rounded-lg bg-campus-700 px-3 py-1 text-xs font-medium text-white hover:bg-campus-800"
                >
                  Determine eligibility…
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No applications.</p>
      )}

      {active && <DetermineModal application={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function DetermineModal({
  application,
  onClose,
}: {
  application: FdsEligibilityApplicationDto;
  onClose: () => void;
}) {
  const determine = useFdsDetermineEligibility(application.id);
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const yearOut = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const [category, setCategory] = useState<FdsEligibilityCategory>('PAID');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [effectiveTo, setEffectiveTo] = useState(yearOut);
  const [notes, setNotes] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title={`Determine eligibility — ${application.studentName ?? 'Student'}`}
      footer={
        <button
          type="button"
          onClick={async () => {
            try {
              const res = await determine.mutateAsync({
                eligibilityCategory: category,
                effectiveFrom,
                effectiveTo,
                notes: notes || undefined,
              });
              const eligible =
                res.determination?.eligibilityCategory === 'FREE' ||
                res.determination?.eligibilityCategory === 'REDUCED';
              toast(
                eligible
                  ? 'Determined — dietary profile.free_meal_eligible flipped to true'
                  : `Determined ${category}`,
                'success',
              );
              onClose();
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={determine.isPending}
          className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {determine.isPending ? 'Saving…' : 'Save determination'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <fieldset>
          <legend className="block font-medium text-gray-700">Category</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(['FREE', 'REDUCED', 'PAID', 'DENIED'] as FdsEligibilityCategory[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  category === c
                    ? 'border-campus-700 bg-campus-700 text-white'
                    : 'border-gray-300 bg-white text-gray-700'
                }`}
              >
                {FDS_ELIGIBILITY_CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="block font-medium text-gray-700">Effective from</span>
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Effective to</span>
          <input
            type="date"
            value={effectiveTo}
            onChange={(e) => setEffectiveTo(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Notes</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
