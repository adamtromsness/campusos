'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import {
  useAttendanceSummary,
  useAtRiskStudents,
  useClassPerformance,
  useDistrictSummary,
  useSchoolSummary,
} from '@/hooks/use-analytics';
import { attendanceTone, formatGpa, formatPercent, gpaTone } from '@/lib/analytics-format';

/**
 * Cycle 29 Analytics landing — persona-aware. The principal sees a
 * 5-tile school summary + nav chips. The teacher sees their class
 * attendance + performance numbers. The superintendent sees the
 * district summary card.
 */
export default function AnalyticsLandingPage() {
  const user = useAuthStore((s) => s.user);
  const isManager = hasAnyPermission(user, ['rpt-002:read']);
  const isDistrict = hasAnyPermission(user, ['rpt-003:read']);

  const school = useSchoolSummary(isManager);
  const district = useDistrictSummary(isDistrict);
  const atRisk = useAtRiskStudents(isManager);
  const recentAttendance = useAttendanceSummary({ enabled: true });
  const classPerf = useClassPerformance(true);

  const summary = school.data ?? null;
  const districtSummary = district.data ?? null;

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Operational read layer. Dashboards, at-risk detection, and the report engine."
      />

      {isManager && summary && (
        <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Enrolled" value={summary.totalEnrolled.toLocaleString()} />
          <StatCard label="Staff" value={summary.totalStaff.toLocaleString()} />
          <StatCard
            label="Attendance"
            value={formatPercent(summary.avgAttendanceRate)}
            tone={attendanceTone(summary.avgAttendanceRate)}
          />
          <StatCard
            label="Avg GPA"
            value={formatGpa(summary.avgGpa)}
            tone={gpaTone(summary.avgGpa)}
          />
          <StatCard
            label="At-risk"
            value={summary.atRiskCount.toLocaleString()}
            tone={
              summary.atRiskCount > 0
                ? 'bg-rose-100 text-rose-800'
                : 'bg-emerald-100 text-emerald-800'
            }
          />
        </section>
      )}

      {isDistrict && districtSummary && (
        <section className="mb-8 rounded-card border border-violet-200 bg-violet-50 p-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-violet-700">
            District summary
          </div>
          <div className="mt-1 text-lg font-semibold text-violet-900">
            {districtSummary.schoolCount} schools · {districtSummary.totalEnrolled.toLocaleString()}{' '}
            students · {formatPercent(districtSummary.avgAttendanceRate)} attendance
          </div>
          <div className="mt-2">
            <Link
              className="text-sm font-medium text-violet-700 hover:underline"
              href="/analytics/district"
            >
              Open district comparison →
            </Link>
          </div>
        </section>
      )}

      <section className="mb-4 flex flex-wrap gap-2 text-sm">
        <NavChip href="/analytics/attendance" label="Attendance" />
        <NavChip href="/analytics/academics" label="Academics" />
        <NavChip href="/analytics/classes" label="Class performance" />
        {isManager && (
          <NavChip
            href="/analytics/at-risk"
            label={`At-risk${atRisk.data ? ` (${atRisk.data.length})` : ''}`}
          />
        )}
        {isManager && <NavChip href="/analytics/wellbeing" label="Wellbeing trends" />}
        {isManager && <NavChip href="/analytics/aged-debtors" label="Aged debtors" />}
        {isManager && <NavChip href="/analytics/reports" label="Reports" />}
        {isManager && <NavChip href="/analytics/scheduled-reports" label="Scheduled reports" />}
        {isManager && <NavChip href="/analytics/state-reports" label="State reports" />}
        {isDistrict && <NavChip href="/analytics/district" label="District" />}
      </section>

      {/* P2-15 Read-Model Hubs */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2">
        <Link
          href="/analytics/operations"
          className="rounded-card border border-gray-200 bg-white p-5 shadow-sm transition hover:border-campus-400 hover:shadow-md"
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-campus-700">
            Operations
          </div>
          <div className="mt-1 text-lg font-semibold text-gray-900">P2-15a Read Models</div>
          <div className="mt-2 text-sm text-gray-600">
            Procurement &middot; Store sales &middot; Meal counts &middot; NSLP &middot; Ridership
            &middot; Facilities condition + KPI &middot; Tech fleet &middot; Library circulation.
          </div>
          <div className="mt-3 inline-flex text-sm font-medium text-campus-700">
            Open operations dashboard →
          </div>
        </Link>
        <Link
          href="/analytics/engagement"
          className="rounded-card border border-gray-200 bg-white p-5 shadow-sm transition hover:border-campus-400 hover:shadow-md"
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-campus-700">
            Engagement &amp; performance
          </div>
          <div className="mt-1 text-lg font-semibold text-gray-900">P2-15b Read Models</div>
          <div className="mt-2 text-sm text-gray-600">
            Enrolment funnel &middot; Athletics season &middot; Officials &middot; Game results
            &middot; Groups &middot; Publications &middot; Clubs &middot; Communications &middot;
            Wellbeing trends (aggregate).
          </div>
          <div className="mt-3 inline-flex text-sm font-medium text-campus-700">
            Open engagement dashboard →
          </div>
        </Link>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-card border border-gray-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Recent attendance</h2>
            <Link className="text-sm text-campus-600 hover:underline" href="/analytics/attendance">
              View all →
            </Link>
          </div>
          {recentAttendance.isLoading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (recentAttendance.data ?? []).length === 0 ? (
            <div className="text-sm text-gray-500">No data yet — run the SIS worker.</div>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {(recentAttendance.data ?? []).slice(0, 6).map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium text-gray-900">{r.className ?? 'Class'}</div>
                    <div className="text-xs text-gray-500">{r.summaryDate}</div>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${attendanceTone(r.attendanceRate)}`}
                  >
                    {formatPercent(r.attendanceRate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-card border border-gray-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Class performance</h2>
            <Link className="text-sm text-campus-600 hover:underline" href="/analytics/classes">
              View all →
            </Link>
          </div>
          {classPerf.isLoading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (classPerf.data ?? []).length === 0 ? (
            <div className="text-sm text-gray-500">No class performance data yet.</div>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {(classPerf.data ?? []).slice(0, 6).map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium text-gray-900">{c.className ?? 'Class'}</div>
                    <div className="text-xs text-gray-500">{c.studentCount} students</div>
                  </div>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
                    avg {c.avgGrade?.toFixed(1) ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</div>
      <div
        className={`mt-1 inline-block rounded-md px-2 py-0.5 text-2xl font-bold ${tone ?? 'text-gray-900'}`}
      >
        {value}
      </div>
    </div>
  );
}

function NavChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-gray-700 hover:border-campus-400 hover:text-campus-700"
    >
      {label}
    </Link>
  );
}
