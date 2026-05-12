'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import {
  useFacilitiesCondition,
  useFacilitiesKpi,
  useLibraryCirculation,
  useMealCounts,
  useNslp,
  useProcurementRollup,
  useRidership,
  useStoreSales,
  useTechFleet,
} from '@/hooks/use-analytics-readmodels';

/**
 * P2-15a Operations Read Models dashboard.
 *
 * 9 cards covering procurement, store sales, food service, transportation,
 * facilities (condition + KPI), IT fleet, and library circulation.
 */
export default function OperationsAnalyticsPage() {
  const user = useAuthStore((s) => s.user);
  const canSeeManagerSurfaces = hasAnyPermission(user, ['rpt-002:read']);

  const procurement = useProcurementRollup();
  const storeSales = useStoreSales();
  const mealCounts = useMealCounts();
  const nslp = useNslp(canSeeManagerSurfaces);
  const ridership = useRidership(canSeeManagerSurfaces);
  const facilitiesCondition = useFacilitiesCondition(canSeeManagerSurfaces);
  const facilitiesKpi = useFacilitiesKpi(canSeeManagerSurfaces);
  const techFleet = useTechFleet(canSeeManagerSurfaces);
  const library = useLibraryCirculation();

  const procurementTotalSpend = procurement.data?.reduce((sum, r) => sum + r.totalSpend, 0) ?? 0;
  const procurementTotalPos = procurement.data?.reduce((sum, r) => sum + r.totalPos, 0) ?? 0;
  const storeRevenue = storeSales.data?.reduce((sum, r) => sum + r.revenue, 0) ?? 0;
  const storeUnits = storeSales.data?.reduce((sum, r) => sum + r.unitsSold, 0) ?? 0;
  const mealsThisPeriod = mealCounts.data?.[0];
  const latestNslp = nslp.data?.[0];
  const latestRidership = ridership.data?.[0];
  const totalSpaces = facilitiesCondition.data?.length ?? 0;
  const avgCondition =
    facilitiesCondition.data && facilitiesCondition.data.length > 0
      ? facilitiesCondition.data
          .filter((r) => r.conditionScore !== null)
          .reduce((sum, r) => sum + (r.conditionScore ?? 0), 0) /
        Math.max(facilitiesCondition.data.filter((r) => r.conditionScore !== null).length, 1)
      : null;
  const latestKpi = facilitiesKpi.data?.[0];
  const totalDevices = techFleet.data?.reduce((sum, r) => sum + r.totalDevices, 0) ?? 0;
  const activeDevices = techFleet.data?.reduce((sum, r) => sum + r.active, 0) ?? 0;
  const latestLibrary = library.data?.[0];

  return (
    <div>
      <PageHeader
        title="Operations"
        description="P2-15a live read models for procurement, store, food service, transportation, facilities, IT, and library."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Procurement" source="prc.po.issued + prc.receipt.completed">
          {procurement.data && procurement.data.length > 0 ? (
            <Stats>
              <Stat label="POs" value={procurementTotalPos.toLocaleString()} />
              <Stat label="Spend" value={`$${procurementTotalSpend.toLocaleString()}`} />
              <Stat
                label="Avg lead"
                value={
                  procurement.data[0]?.avgLeadTimeDays === null ||
                  procurement.data[0]?.avgLeadTimeDays === undefined
                    ? '—'
                    : `${procurement.data[0].avgLeadTimeDays.toFixed(1)}d`
                }
              />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="Store sales" source="str.order.completed">
          {storeSales.data && storeSales.data.length > 0 ? (
            <Stats>
              <Stat label="Revenue" value={`$${storeRevenue.toLocaleString()}`} />
              <Stat label="Units" value={storeUnits.toLocaleString()} />
              <Stat label="Products" value={storeSales.data.length.toLocaleString()} />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="Meal counts" source="fds.meal.served (daily grain)">
          {mealsThisPeriod ? (
            <Stats>
              <Stat label="Served" value={mealsThisPeriod.totalServed.toLocaleString()} />
              <Stat label="Free" value={mealsThisPeriod.freeCount.toLocaleString()} />
              <Stat label="Waste" value={mealsThisPeriod.wasteCount.toLocaleString()} />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        {canSeeManagerSurfaces && (
          <Card title="NSLP" source="fds.meal.served (monthly federal)" badge="Federal">
            {latestNslp ? (
              <Stats>
                <Stat label="Free" value={latestNslp.freeMeals.toLocaleString()} />
                <Stat label="Reduced" value={latestNslp.reducedMeals.toLocaleString()} />
                <Stat
                  label="Reimburse"
                  value={`$${latestNslp.totalReimbursementEstimate.toLocaleString()}`}
                />
              </Stats>
            ) : (
              <Empty />
            )}
          </Card>
        )}

        {canSeeManagerSurfaces && (
          <Card title="Ridership" source="trn.run.completed">
            {latestRidership ? (
              <Stats>
                <Stat label="Runs" value={latestRidership.totalRuns.toLocaleString()} />
                <Stat label="Riders" value={latestRidership.totalRiders.toLocaleString()} />
                <Stat
                  label="On time"
                  value={
                    latestRidership.onTimeRate === null
                      ? '—'
                      : `${(latestRidership.onTimeRate * 100).toFixed(0)}%`
                  }
                />
              </Stats>
            ) : (
              <Empty />
            )}
          </Card>
        )}

        {canSeeManagerSurfaces && (
          <Card
            title="Facilities condition"
            source="fac.inspection.completed + fac.work_order.completed"
          >
            {facilitiesCondition.data && facilitiesCondition.data.length > 0 ? (
              <Stats>
                <Stat label="Spaces" value={totalSpaces.toLocaleString()} />
                <Stat
                  label="Avg score"
                  value={avgCondition === null ? '—' : avgCondition.toFixed(1)}
                />
                <Stat
                  label="Overdue WO"
                  value={(
                    facilitiesCondition.data.reduce((s, r) => s + r.overdueWorkOrders, 0) ?? 0
                  ).toLocaleString()}
                />
              </Stats>
            ) : (
              <Empty />
            )}
          </Card>
        )}

        {canSeeManagerSurfaces && (
          <Card title="Facilities KPI" source="fac.work_order.* + fac.energy.*" badge="Nightly">
            {latestKpi ? (
              <Stats>
                <Stat label="Work orders" value={latestKpi.totalWorkOrders.toLocaleString()} />
                <Stat label="On time" value={latestKpi.completedOnTime.toLocaleString()} />
                <Stat label="Energy" value={`$${latestKpi.energyCost.toLocaleString()}`} />
              </Stats>
            ) : (
              <Empty />
            )}
          </Card>
        )}

        {canSeeManagerSurfaces && (
          <Card title="IT fleet" source="tech.device.provisioned/deprovisioned/incident">
            {techFleet.data && techFleet.data.length > 0 ? (
              <Stats>
                <Stat label="Devices" value={totalDevices.toLocaleString()} />
                <Stat label="Active" value={activeDevices.toLocaleString()} />
                <Stat
                  label="In repair"
                  value={(techFleet.data.reduce((s, r) => s + r.inRepair, 0) ?? 0).toLocaleString()}
                />
              </Stats>
            ) : (
              <Empty />
            )}
          </Card>
        )}

        <Card title="Library circulation" source="lib.checkout.created + lib.return.completed">
          {latestLibrary ? (
            <Stats>
              <Stat label="Checkouts" value={latestLibrary.totalCheckouts.toLocaleString()} />
              <Stat label="Returns" value={latestLibrary.totalReturns.toLocaleString()} />
              <Stat label="Overdue" value={latestLibrary.overdueCount.toLocaleString()} />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>
      </section>
    </div>
  );
}

function Card({
  title,
  source,
  badge,
  children,
}: {
  title: string;
  source: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        {badge && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
            {badge}
          </span>
        )}
      </div>
      <div className="mb-3 text-xs text-gray-500">{source}</div>
      {children}
    </div>
  );
}

function Stats({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-3">{children}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 text-lg font-bold text-gray-900">{value}</div>
    </div>
  );
}

function Empty() {
  return <div className="text-sm text-gray-500">No data yet.</div>;
}
