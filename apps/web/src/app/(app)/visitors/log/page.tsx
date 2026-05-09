'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useSignInLog } from '@/hooks/use-visitors';
import {
  BADGE_COLOR_PILL,
  formatDateTime,
  SAFEGUARDING_STATUS_LABEL,
  SAFEGUARDING_STATUS_PILL,
} from '@/lib/visitors-format';

export default function VisitorLogPage() {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const args: { fromDate?: string; toDate?: string } = {};
  if (fromDate) args.fromDate = new Date(fromDate).toISOString();
  if (toDate) args.toDate = new Date(toDate + 'T23:59:59').toISOString();
  const logQ = useSignInLog(args);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visitor sign-in log"
        description="Historical sign-in / sign-out records."
      />

      <div className="flex flex-wrap gap-3">
        <label className="text-sm text-gray-700">
          From{' '}
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="ml-2 rounded border border-gray-300 px-3 py-1 text-sm"
          />
        </label>
        <label className="text-sm text-gray-700">
          To{' '}
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="ml-2 rounded border border-gray-300 px-3 py-1 text-sm"
          />
        </label>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {logQ.isLoading ? (
          <LoadingSpinner />
        ) : logQ.data && logQ.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <th className="py-2 px-3">Visitor</th>
                <th className="py-2 px-3">Type</th>
                <th className="py-2 px-3">Host</th>
                <th className="py-2 px-3">Signed in</th>
                <th className="py-2 px-3">Signed out</th>
                <th className="py-2 px-3">Safeguarding</th>
              </tr>
            </thead>
            <tbody>
              {logQ.data.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 last:border-0">
                  <td className="py-3 px-3">
                    <div className="font-medium text-gray-900">{s.visitorName}</div>
                    {s.visitorCompany && (
                      <div className="text-xs text-gray-500">{s.visitorCompany}</div>
                    )}
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={
                        'inline-flex rounded px-2 py-0.5 text-xs ' +
                        (BADGE_COLOR_PILL[s.badgeColor] ?? '')
                      }
                    >
                      {s.visitorTypeName}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-gray-700">{s.hostName ?? '—'}</td>
                  <td className="py-3 px-3 text-gray-700">{formatDateTime(s.signedInAt)}</td>
                  <td className="py-3 px-3 text-gray-700">
                    {s.signedOutAt ? (
                      formatDateTime(s.signedOutAt)
                    ) : (
                      <span className="text-emerald-700">on site</span>
                    )}
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={
                        'inline-flex rounded px-2 py-0.5 text-xs ' +
                        SAFEGUARDING_STATUS_PILL[s.safeguardingCheckStatus]
                      }
                    >
                      {SAFEGUARDING_STATUS_LABEL[s.safeguardingCheckStatus]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No sign-ins"
            description="No visitors signed in for the selected window."
          />
        )}
      </div>
    </div>
  );
}
