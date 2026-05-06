'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useDrivers } from '@/hooks/use-transport';
import {
  CREDENTIAL_STATUS_LABEL,
  CREDENTIAL_STATUS_PILL,
  CREDENTIAL_TYPE_LABEL,
} from '@/lib/transport-format';

export default function DriversPage() {
  const driversQ = useDrivers();

  return (
    <div>
      <PageHeader
        title="Drivers"
        description="Credentials with expiry status"
        actions={
          <Link
            href="/transport"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Transportation
          </Link>
        }
      />

      {driversQ.isLoading ? (
        <LoadingSpinner />
      ) : driversQ.data && driversQ.data.length > 0 ? (
        <ul className="grid gap-3 lg:grid-cols-2">
          {driversQ.data.map((d) => (
            <li key={d.id} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-base font-semibold text-gray-900">{d.name ?? '—'}</div>
              <ul className="mt-3 space-y-2">
                {d.credentials.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm"
                  >
                    <div>
                      <div className="font-medium text-gray-900">
                        {CREDENTIAL_TYPE_LABEL[c.credentialType]}
                      </div>
                      <div className="text-xs text-gray-500">
                        {c.credentialNumber ?? '—'} · expires {c.expiryDate}
                      </div>
                      {c.verifiedAt && (
                        <div className="text-xs text-emerald-700">
                          Verified {new Date(c.verifiedAt).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${CREDENTIAL_STATUS_PILL[c.status]}`}
                    >
                      {CREDENTIAL_STATUS_LABEL[c.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No drivers configured.</p>
      )}
    </div>
  );
}
