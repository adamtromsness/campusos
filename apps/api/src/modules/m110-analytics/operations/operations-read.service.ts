import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';

/**
 * Read-only service for the P2-15a operations read models.
 *
 * All reads route through the tenant context and could be pointed at
 * the read replica in production (via a separate Prisma client) — the
 * plan calls for replica routing on all rpt_* reads. For now we run
 * through the existing TenantPrismaService which uses the primary; a
 * follow-up wiring task swaps in `TenantPrismaService.executeOnReplica`
 * once that helper lands (P2-15b).
 *
 * Every list endpoint accepts an optional date range. School scoping
 * comes from the resolved tenant context — no cross-tenant reads.
 */

export interface DateRangeArgs {
  fromDate?: string;
  toDate?: string;
}

export interface ProcurementSummaryRowDto {
  id: string;
  schoolId: string;
  period: string;
  department: string;
  vendorId: string;
  totalPos: number;
  totalSpend: number;
  avgLeadTimeDays: number | null;
  generatedAt: string;
}

export interface StoreSalesRowDto {
  id: string;
  schoolId: string;
  period: string;
  productId: string;
  unitsSold: number;
  revenue: number;
  costOfGoods: number;
  profitMargin: number | null;
  generatedAt: string;
}

export interface MealCountsRowDto {
  id: string;
  schoolId: string;
  serviceDate: string;
  mealType: string;
  totalServed: number;
  freeCount: number;
  reducedCount: number;
  paidCount: number;
  wasteCount: number;
  generatedAt: string;
}

export interface NslpSummaryRowDto {
  id: string;
  schoolId: string;
  monthYear: string;
  freeMeals: number;
  reducedMeals: number;
  paidMeals: number;
  totalReimbursementEstimate: number;
  generatedAt: string;
}

export interface RidershipSummaryRowDto {
  id: string;
  schoolId: string;
  routeId: string;
  period: string;
  totalRuns: number;
  totalRiders: number;
  avgRidersPerRun: number | null;
  onTimeRate: number | null;
  avgDurationMinutes: number | null;
  generatedAt: string;
}

export interface FacilitiesConditionRowDto {
  id: string;
  schoolId: string;
  buildingId: string;
  spaceId: string;
  lastInspectionDate: string | null;
  conditionScore: number | null;
  openWorkOrders: number;
  overdueWorkOrders: number;
  generatedAt: string;
}

export interface FacilitiesKpiRowDto {
  id: string;
  schoolId: string;
  period: string;
  totalWorkOrders: number;
  completedOnTime: number;
  avgResolutionDays: number | null;
  energyCost: number;
  costPerSqft: number | null;
  generatedAt: string;
}

export interface FleetStatusRowDto {
  id: string;
  schoolId: string;
  deviceType: string;
  totalDevices: number;
  active: number;
  inRepair: number;
  decommissioned: number;
  avgAgeMonths: number | null;
  incidentRate: number | null;
  generatedAt: string;
}

export interface LibraryCirculationRowDto {
  id: string;
  schoolId: string;
  period: string;
  totalCheckouts: number;
  totalReturns: number;
  overdueCount: number;
  popularTitles: unknown;
  avgLoanDurationDays: number | null;
  generatedAt: string;
}

@Injectable()
export class OperationsReadService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listProcurement(args: DateRangeArgs = {}): Promise<ProcurementSummaryRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                department, vendor_id::text AS vendor_id, total_pos, total_spend::float AS total_spend,
                avg_lead_time_days::float AS avg_lead_time_days, generated_at::text AS generated_at
         FROM rpt_procurement_summary
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC, department`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        department: String(r.department),
        vendorId: String(r.vendor_id),
        totalPos: Number(r.total_pos),
        totalSpend: Number(r.total_spend),
        avgLeadTimeDays: r.avg_lead_time_days === null ? null : Number(r.avg_lead_time_days),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listStoreSales(args: DateRangeArgs = {}): Promise<StoreSalesRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                product_id::text AS product_id, units_sold, revenue::float AS revenue,
                cost_of_goods::float AS cost_of_goods, profit_margin::float AS profit_margin,
                generated_at::text AS generated_at
         FROM rpt_store_sales
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC, revenue DESC`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        productId: String(r.product_id),
        unitsSold: Number(r.units_sold),
        revenue: Number(r.revenue),
        costOfGoods: Number(r.cost_of_goods),
        profitMargin: r.profit_margin === null ? null : Number(r.profit_margin),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listMealCounts(args: DateRangeArgs = {}): Promise<MealCountsRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, service_date::text AS service_date,
                meal_type, total_served, free_count, reduced_count, paid_count, waste_count,
                generated_at::text AS generated_at
         FROM rpt_fds_meal_counts
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR service_date >= $2::date)
           AND ($3::date IS NULL OR service_date <= $3::date)
         ORDER BY service_date DESC, meal_type`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        serviceDate: String(r.service_date).slice(0, 10),
        mealType: String(r.meal_type),
        totalServed: Number(r.total_served),
        freeCount: Number(r.free_count),
        reducedCount: Number(r.reduced_count),
        paidCount: Number(r.paid_count),
        wasteCount: Number(r.waste_count),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listNslp(args: DateRangeArgs = {}): Promise<NslpSummaryRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, month_year::text AS month_year,
                free_meals, reduced_meals, paid_meals,
                total_reimbursement_estimate::float AS total_reimbursement_estimate,
                generated_at::text AS generated_at
         FROM rpt_fds_nslp_summary
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR month_year >= $2::date)
           AND ($3::date IS NULL OR month_year <= $3::date)
         ORDER BY month_year DESC`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        monthYear: String(r.month_year).slice(0, 10),
        freeMeals: Number(r.free_meals),
        reducedMeals: Number(r.reduced_meals),
        paidMeals: Number(r.paid_meals),
        totalReimbursementEstimate: Number(r.total_reimbursement_estimate),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listRidership(args: DateRangeArgs = {}): Promise<RidershipSummaryRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, route_id::text AS route_id,
                period::text AS period, total_runs, total_riders,
                avg_riders_per_run::float AS avg_riders_per_run,
                on_time_rate::float AS on_time_rate,
                avg_duration_minutes::float AS avg_duration_minutes,
                generated_at::text AS generated_at
         FROM rpt_trn_ridership_summary
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC, route_id`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        routeId: String(r.route_id),
        period: String(r.period).slice(0, 10),
        totalRuns: Number(r.total_runs),
        totalRiders: Number(r.total_riders),
        avgRidersPerRun: r.avg_riders_per_run === null ? null : Number(r.avg_riders_per_run),
        onTimeRate: r.on_time_rate === null ? null : Number(r.on_time_rate),
        avgDurationMinutes: r.avg_duration_minutes === null ? null : Number(r.avg_duration_minutes),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listFacilitiesCondition(): Promise<FacilitiesConditionRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                building_id::text AS building_id, space_id::text AS space_id,
                last_inspection_date::text AS last_inspection_date,
                condition_score::float AS condition_score,
                open_work_orders, overdue_work_orders,
                generated_at::text AS generated_at
         FROM rpt_facilities_condition
         WHERE school_id = $1::uuid
         ORDER BY condition_score NULLS LAST, building_id`,
        tenant.schoolId,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        buildingId: String(r.building_id),
        spaceId: String(r.space_id),
        lastInspectionDate:
          r.last_inspection_date === null ? null : String(r.last_inspection_date).slice(0, 10),
        conditionScore: r.condition_score === null ? null : Number(r.condition_score),
        openWorkOrders: Number(r.open_work_orders),
        overdueWorkOrders: Number(r.overdue_work_orders),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listFacilitiesKpi(args: DateRangeArgs = {}): Promise<FacilitiesKpiRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                total_work_orders, completed_on_time,
                avg_resolution_days::float AS avg_resolution_days,
                energy_cost::float AS energy_cost,
                cost_per_sqft::float AS cost_per_sqft,
                generated_at::text AS generated_at
         FROM rpt_facilities_kpi
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        totalWorkOrders: Number(r.total_work_orders),
        completedOnTime: Number(r.completed_on_time),
        avgResolutionDays: r.avg_resolution_days === null ? null : Number(r.avg_resolution_days),
        energyCost: Number(r.energy_cost),
        costPerSqft: r.cost_per_sqft === null ? null : Number(r.cost_per_sqft),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listTechFleet(): Promise<FleetStatusRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, device_type,
                total_devices, active, in_repair, decommissioned,
                avg_age_months::float AS avg_age_months,
                incident_rate::float AS incident_rate,
                generated_at::text AS generated_at
         FROM rpt_tech_fleet_status
         WHERE school_id = $1::uuid
         ORDER BY device_type`,
        tenant.schoolId,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        deviceType: String(r.device_type),
        totalDevices: Number(r.total_devices),
        active: Number(r.active),
        inRepair: Number(r.in_repair),
        decommissioned: Number(r.decommissioned),
        avgAgeMonths: r.avg_age_months === null ? null : Number(r.avg_age_months),
        incidentRate: r.incident_rate === null ? null : Number(r.incident_rate),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listLibraryCirculation(args: DateRangeArgs = {}): Promise<LibraryCirculationRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                total_checkouts, total_returns, overdue_count, popular_titles,
                avg_loan_duration_days::float AS avg_loan_duration_days,
                generated_at::text AS generated_at
         FROM rpt_lib_circulation_summary
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        totalCheckouts: Number(r.total_checkouts),
        totalReturns: Number(r.total_returns),
        overdueCount: Number(r.overdue_count),
        popularTitles: r.popular_titles ?? [],
        avgLoanDurationDays:
          r.avg_loan_duration_days === null ? null : Number(r.avg_loan_duration_days),
        generatedAt: String(r.generated_at),
      }));
    });
  }
}
