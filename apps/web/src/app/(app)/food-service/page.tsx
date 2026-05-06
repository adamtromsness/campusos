'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useFdsAllergenAlerts,
  useFdsDailyMenu,
  useFdsDietaryUpdateRequests,
  useFdsNonCompliantTempLogs,
  useFdsSessions,
} from '@/hooks/use-food-service';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  FDS_CATEGORY_LABEL,
  FDS_CATEGORY_PILL,
  FDS_SEVERITY_PILL,
  formatCurrency,
} from '@/lib/food-service-format';

export default function FoodServiceLandingPage() {
  const user = useAuthStore((s) => s.user);
  const isManager = !!user && hasAnyPermission(user, ['fds-002:write']);
  const today = new Date().toISOString().slice(0, 10);

  const todayMenuQ = useFdsDailyMenu(today, 'LUNCH');
  const sessionsQ = useFdsSessions({ fromDate: today, toDate: today });
  const noncompQ = useFdsNonCompliantTempLogs();
  const pendingQ = useFdsDietaryUpdateRequests({ status: 'PENDING' });
  const allergenQ = useFdsAllergenAlerts();

  if (!user) return <LoadingSpinner />;

  const activeSessions = (sessionsQ.data ?? []).filter((s) => s.closedAt === null);
  const transactionCount = (sessionsQ.data ?? []).reduce((sum, s) => sum + s.transactionCount, 0);
  const todayTotalSales = (sessionsQ.data ?? []).reduce((sum, s) => sum + s.totalSales, 0);
  const noncompCount = noncompQ.data?.length ?? 0;
  const pendingCount = pendingQ.data?.length ?? 0;
  const criticalAllergenCount = (allergenQ.data ?? []).filter(
    (a) => a.severity === 'CRITICAL',
  ).length;

  return (
    <div>
      <PageHeader
        title="Food Service"
        description={
          isManager
            ? "Today's menu, sessions, dietary requests, and food safety"
            : "Today's menu and meal program"
        }
        actions={
          isManager ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/food-service/menus"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Menus
              </Link>
              <Link
                href="/food-service/pos"
                className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-100"
              >
                POS Checkout
              </Link>
              <Link
                href="/food-service/sessions"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Sessions
              </Link>
              <Link
                href="/food-service/safety"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Food safety
              </Link>
              <Link
                href="/food-service/dietary"
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
              >
                Dietary →
              </Link>
            </div>
          ) : null
        }
      />

      {isManager && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Active sessions" value={activeSessions.length} />
          <Stat label="Today's transactions" value={transactionCount} />
          <Stat label="Today's sales" value={formatCurrency(todayTotalSales)} />
          <Stat
            label="Non-compliant temps"
            value={noncompCount}
            tone={noncompCount > 0 ? 'rose' : 'green'}
          />
          <Stat
            label="Pending requests"
            value={pendingCount}
            tone={pendingCount > 0 ? 'amber' : 'green'}
          />
        </div>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900">Today&apos;s lunch menu</h2>
          {isManager && (
            <Link
              href="/food-service/menus"
              className="text-sm text-campus-700 underline underline-offset-4"
            >
              Plan menus →
            </Link>
          )}
        </div>
        {todayMenuQ.isLoading ? (
          <LoadingSpinner />
        ) : todayMenuQ.data && todayMenuQ.data.items && todayMenuQ.data.items.length > 0 ? (
          <ul className="mt-3 grid gap-2 lg:grid-cols-2">
            {todayMenuQ.data.items.map((it) => (
              <li key={it.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
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
                      className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700"
                    >
                      {code}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No lunch menu published for today.</p>
        )}
      </section>

      {isManager && criticalAllergenCount > 0 && (
        <section className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-5">
          <h2 className="text-base font-semibold text-rose-900">
            CRITICAL allergen alerts ({criticalAllergenCount})
          </h2>
          <p className="mt-1 text-sm text-rose-800">
            Students with life-threatening allergens. POS will BLOCK transactions containing these
            allergens unless a supervisor override is supplied.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {(allergenQ.data ?? [])
              .filter((a) => a.severity === 'CRITICAL')
              .slice(0, 10)
              .map((a) => (
                <li key={a.id} className="flex items-baseline gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${FDS_SEVERITY_PILL[a.severity]}`}
                  >
                    {a.allergenCode}
                  </span>
                  <span className="text-rose-900">
                    {a.studentName ?? 'Student'} — {a.allergenDisplayName}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'green' | 'amber' | 'rose';
}) {
  const toneClass =
    tone === 'rose'
      ? 'text-rose-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'green'
          ? 'text-emerald-700'
          : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
