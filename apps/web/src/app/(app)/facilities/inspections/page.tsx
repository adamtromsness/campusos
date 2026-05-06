'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useFacInspectionTypes, useFacInspections } from '@/hooks/use-facilities';
import {
  FAC_INSPECTION_OUTCOME_LABEL,
  FAC_INSPECTION_OUTCOME_PILL,
  formatDateOnly,
  formatRelativeDue,
} from '@/lib/facilities-format';

export default function InspectionsPage() {
  const inspectionsQ = useFacInspections();
  const typesQ = useFacInspectionTypes();

  return (
    <div>
      <PageHeader
        title="Compliance inspections"
        description="Annual fire, elevator, health — IMMUTABLE once outcome is recorded"
        actions={
          <Link
            href="/facilities"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Facilities
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Inspection types</h2>
        {typesQ.isLoading ? (
          <LoadingSpinner />
        ) : typesQ.data && typesQ.data.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm">
            {typesQ.data.map((t) => (
              <li
                key={t.id}
                className="flex items-baseline justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
              >
                <div>
                  <div className="font-medium text-gray-900">{t.name}</div>
                  <div className="text-xs text-gray-500">
                    {t.authority} · every {t.frequencyMonths}mo
                    {t.isMandatory ? ' · mandatory' : ''}
                    {t.failureEscalationDays ? ` · escalation ${t.failureEscalationDays}d` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No inspection types yet.</p>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Inspection log</h2>
        {inspectionsQ.isLoading ? (
          <LoadingSpinner />
        ) : inspectionsQ.data && inspectionsQ.data.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm">
            {inspectionsQ.data.map((i) => (
              <li key={i.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div>
                    <span className="font-medium text-gray-900">{i.inspectionTypeName}</span>
                    <span className="ml-2 text-xs text-gray-500">{i.authority}</span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${FAC_INSPECTION_OUTCOME_PILL[i.outcome]}`}
                  >
                    {FAC_INSPECTION_OUTCOME_LABEL[i.outcome]}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-600">
                  <span>{i.buildingName}</span>
                  {i.conductedDate && <span>Conducted {formatDateOnly(i.conductedDate)}</span>}
                  {i.inspectorName && <span>by {i.inspectorName}</span>}
                  {i.nextDueDate && <span>Next due {formatRelativeDue(i.nextDueDate)}</span>}
                </div>
                {i.notes && <p className="mt-2 text-xs text-gray-700 italic">{i.notes}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No inspections recorded yet.</p>
        )}
      </section>
    </div>
  );
}
