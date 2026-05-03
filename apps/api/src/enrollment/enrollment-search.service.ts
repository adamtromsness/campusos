import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';

export interface EnrollmentSearchResultDto {
  schoolId: string;
  schoolName: string;
  schoolFullAddress: string | null;
  distanceMiles: number;
  periodId: string;
  periodName: string;
  closesAt: string;
  acceptingGrades: string[];
}

interface SchoolRow {
  id: string;
  name: string;
  full_address: string | null;
  schema_name: string;
  latitude: number;
  longitude: number;
}

interface PeriodRow {
  id: string;
  name: string;
  closes_at: string;
}

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

@Injectable()
export class EnrollmentSearchService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Cross-tenant search for schools within `radiusMiles` of (lat, lng) that
   * have at least one OPEN, public-search enrollment period (optionally
   * accepting `gradeLevel`). Returns results sorted nearest-first.
   *
   * Two-phase query:
   *   1. Read every active school with non-null lat/lng from platform
   *      schema and Haversine-filter app-side.
   *   2. For each survivor, enter the school's tenant schema explicitly via
   *      executeInExplicitSchema and pick out any OPEN periods with
   *      allows_public_search=true. Periods without intake_capacities for
   *      the requested grade are filtered out.
   *
   * Radius is hard-capped at 100 miles per the spec.
   */
  async search(input: {
    lat: number;
    lng: number;
    radiusMiles: number;
    gradeLevel?: string;
  }): Promise<EnrollmentSearchResultDto[]> {
    const radius = Math.min(Math.max(input.radiusMiles, 1), 100);
    if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) {
      throw new BadRequestException('lat must be a number between -90 and 90');
    }
    if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) {
      throw new BadRequestException('lng must be a number between -180 and 180');
    }
    const platformClient = (this.tenantPrisma as any).platformClient as PrismaClient;
    const schools = (await platformClient.$queryRawUnsafe(
      'SELECT s.id, s.name, s.full_address, r.schema_name, ' +
        's.latitude::float8 AS latitude, s.longitude::float8 AS longitude ' +
        'FROM platform.schools s ' +
        'JOIN platform.platform_tenant_routing r ON r.tenant_id = s.id ' +
        'WHERE s.is_active = true ' +
        'AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL ' +
        'AND r.is_active = true',
    )) as SchoolRow[];

    const candidates = schools
      .map((s) => ({
        ...s,
        distance: haversineMiles(input.lat, input.lng, s.latitude, s.longitude),
      }))
      .filter((s) => s.distance <= radius);

    const out: EnrollmentSearchResultDto[] = [];
    for (const school of candidates) {
      const periods = await this.tenantPrisma.executeInExplicitSchema(
        school.schema_name,
        async (client) => {
          const rows = await client.$queryRawUnsafe<PeriodRow[]>(
            'SELECT p.id, p.name, ' +
              "TO_CHAR(p.closes_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS closes_at " +
              'FROM enr_enrollment_periods p ' +
              "WHERE p.school_id = $1::uuid AND p.status = 'OPEN' " +
              'AND p.allows_public_search = true ' +
              'AND ($2::text IS NULL OR EXISTS (' +
              'SELECT 1 FROM enr_intake_capacities ic ' +
              'WHERE ic.enrollment_period_id = p.id AND ic.grade_level = $2::text)) ' +
              'ORDER BY p.closes_at ASC',
            school.id,
            input.gradeLevel ?? null,
          );
          if (rows.length === 0) return [] as Array<PeriodRow & { acceptingGrades: string[] }>;
          // Load accepting grades (from intake_capacities) for each period.
          const periodIds = rows.map((r) => r.id);
          const grades = (await client.$queryRawUnsafe(
            'SELECT enrollment_period_id, grade_level FROM enr_intake_capacities ' +
              'WHERE enrollment_period_id = ANY($1::uuid[]) ' +
              'GROUP BY enrollment_period_id, grade_level',
            periodIds,
          )) as Array<{ enrollment_period_id: string; grade_level: string }>;
          const byPeriod = new Map<string, string[]>();
          for (const g of grades) {
            const arr = byPeriod.get(g.enrollment_period_id) ?? [];
            arr.push(g.grade_level);
            byPeriod.set(g.enrollment_period_id, arr);
          }
          return rows.map((r) => ({
            ...r,
            acceptingGrades: (byPeriod.get(r.id) ?? []).sort(),
          }));
        },
      );
      for (const p of periods) {
        out.push({
          schoolId: school.id,
          schoolName: school.name,
          schoolFullAddress: school.full_address,
          distanceMiles: Math.round(school.distance * 10) / 10,
          periodId: p.id,
          periodName: p.name,
          closesAt: p.closes_at,
          acceptingGrades: p.acceptingGrades,
        });
      }
    }
    out.sort((a, b) => a.distanceMiles - b.distanceMiles);
    return out;
  }
}
