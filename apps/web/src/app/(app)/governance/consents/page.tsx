'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useConsents } from '@/hooks/use-governance';
import { formatDateTime } from '@/lib/governance-format';

export default function ConsentsPage() {
  const [consentedOnly, setConsentedOnly] = useState(false);
  const consents = useConsents({ consentedOnly });

  return (
    <div>
      <PageHeader
        title="Consent records"
        description="Per-(data subject, processing activity) consent ledger. Each row records the consent decision + method + evidence reference."
      />

      <div className="mb-4 flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={consentedOnly}
            onChange={(e) => setConsentedOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>Active consents only</span>
        </label>
        <Link href="/governance" className="ml-auto text-sm text-gray-500 hover:text-campus-700">
          ← Back to compliance dashboard
        </Link>
      </div>

      {consents.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !consents.data || consents.data.length === 0 ? (
        <p className="text-sm text-gray-500">No consent records.</p>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-4 py-2">Subject</th>
                <th className="px-4 py-2">Processing activity</th>
                <th className="px-4 py-2">Method</th>
                <th className="px-4 py-2">Given</th>
                <th className="px-4 py-2">Withdrawn</th>
                <th className="px-4 py-2">State</th>
              </tr>
            </thead>
            <tbody>
              {consents.data.map((c) => (
                <tr
                  key={c.id}
                  className={`border-b border-gray-100 last:border-0 ${
                    c.consentWithdrawnAt ? 'bg-gray-50' : ''
                  }`}
                >
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {c.dataSubjectId.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {c.processingActivityName ?? c.processingActivityId.slice(0, 8) + '…'}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">{c.consentMethod}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {formatDateTime(c.consentGivenAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {formatDateTime(c.consentWithdrawnAt)}
                  </td>
                  <td className="px-4 py-3">
                    {c.consentWithdrawnAt ? (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                        Withdrawn
                      </span>
                    ) : c.consented ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
                        Refused
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
