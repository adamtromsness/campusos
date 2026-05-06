'use client';

import { PageHeader } from '@/components/ui/PageHeader';
import { useItLicences } from '@/hooks/use-it';
import {
  IT_LICENCE_TYPE_LABELS,
  formatItCurrency,
  formatItDate,
  formatItUtilisation,
  utilisationPill,
} from '@/lib/it-format';

export default function LicencesPage() {
  const licences = useItLicences();
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader
        title="Software licences"
        description="Per-seat / site / subscription licence registry"
      />
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Software</th>
              <th className="p-3">Vendor</th>
              <th className="p-3">Type</th>
              <th className="p-3">Seats</th>
              <th className="p-3">Utilisation</th>
              <th className="p-3">Cost</th>
              <th className="p-3">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {licences.data?.map((l) => (
              <tr key={l.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-3 font-medium">{l.softwareName}</td>
                <td className="p-3 text-gray-700">{l.vendor ?? '—'}</td>
                <td className="p-3 text-gray-700">{IT_LICENCE_TYPE_LABELS[l.licenceType]}</td>
                <td className="p-3 text-gray-700">
                  {l.totalSeats === null ? '∞' : `${l.usedSeats} / ${l.totalSeats}`}
                </td>
                <td className="p-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${utilisationPill(l.utilisationPct)}`}
                  >
                    {formatItUtilisation(l.utilisationPct)}
                  </span>
                </td>
                <td className="p-3 text-gray-700">{formatItCurrency(l.annualCost)} / yr</td>
                <td className="p-3 text-gray-500">{formatItDate(l.expiryDate)}</td>
              </tr>
            ))}
            {!licences.isLoading && (licences.data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-sm text-gray-500">
                  No licences configured.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
