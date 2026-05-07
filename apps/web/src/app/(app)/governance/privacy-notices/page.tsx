'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { usePrivacyNotices } from '@/hooks/use-governance';
import { formatDate, formatDateTime } from '@/lib/governance-format';

export default function PrivacyNoticesPage() {
  const notices = usePrivacyNotices();

  return (
    <div>
      <PageHeader
        title="Privacy notices"
        description="GDPR Articles 13 + 14 transparency notices. Exactly one notice carries is_current=true at any given time; publishing a new version automatically supersedes the prior one."
      />

      <Link
        href="/governance"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-campus-700"
      >
        ← Back to compliance dashboard
      </Link>

      {notices.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !notices.data || notices.data.length === 0 ? (
        <p className="text-sm text-gray-500">No privacy notices recorded yet.</p>
      ) : (
        <ul className="space-y-3">
          {notices.data.map((n) => (
            <li
              key={n.id}
              className={`rounded-card border p-4 shadow-sm ${
                n.isCurrent ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-gray-900">
                      Version {n.noticeVersion}
                    </span>
                    {n.isCurrent && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-gray-700">{n.contentSummary}</p>
                  <div className="mt-2 text-xs text-gray-500">
                    Effective {formatDate(n.effectiveFrom)}
                    {n.publishedAt && ` · Published ${formatDateTime(n.publishedAt)}`}
                    {n.publishedByName && ` by ${n.publishedByName}`}
                    {n.supersededAt && ` · Superseded ${formatDateTime(n.supersededAt)}`}
                  </div>
                </div>
                <a
                  href={n.documentS3Key}
                  className="text-xs text-campus-700 hover:underline"
                  onClick={(e) => e.preventDefault()}
                  title={n.documentS3Key}
                >
                  Document ref
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
