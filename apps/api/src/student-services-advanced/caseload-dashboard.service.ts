import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CaseloadCapacityRowDto,
  CaseloadDashboardResponseDto,
} from './dto/student-services-advanced.dto';

interface CapacityRow {
  counsellor_id: string;
  counsellor_name: string | null;
  active_count: string;
  crisis_count: string;
  academic_year_id: string;
}

const DEFAULT_CAPACITY_TARGET = 35;

/**
 * CaseloadDashboardService — P2-28c capacity tracking on top of the
 * Cycle 11 svc_caseloads table. Read-only. Aggregates active caseloads
 * per counsellor and surfaces utilisation against a default capacity
 * target so admins can see who is overloaded at a glance.
 *
 * The capacity target is a per-counsellor constant for now (default
 * 35); a future Phase 2 polish can wire it to a per-school school
 * _config key.
 *
 * Authorisation: staff + admin only at the service layer. STUDENT and
 * GUARDIAN actors are refused.
 */
@Injectable()
export class CaseloadDashboardService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Counsellor caseload dashboard is staff-only');
    }
  }

  async getDashboard(
    actor: ResolvedActor,
    academicYearId?: string,
  ): Promise<CaseloadDashboardResponseDto> {
    this.assertStaff(actor);

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      const yearFilter = academicYearId ? 'AND c.academic_year_id = $1::uuid ' : '';
      const yearArg = academicYearId ? [academicYearId] : [];

      const sql =
        'SELECT e.id::text AS counsellor_id, ' +
        "(ip.first_name || ' ' || ip.last_name) AS counsellor_name, " +
        'COUNT(*) FILTER (WHERE true)::text AS active_count, ' +
        "COUNT(*) FILTER (WHERE c.primary_concern = 'CRISIS')::text AS crisis_count, " +
        'c.academic_year_id::text AS academic_year_id ' +
        'FROM svc_caseloads c ' +
        'JOIN hr_employees e ON e.id = c.counselor_id ' +
        'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
        "WHERE c.status = 'ACTIVE' " +
        yearFilter +
        'GROUP BY e.id, ip.first_name, ip.last_name, c.academic_year_id ' +
        'ORDER BY active_count DESC';

      return client.$queryRawUnsafe(sql, ...yearArg);
    })) as CapacityRow[];

    const dashboardRows: CaseloadCapacityRowDto[] = rows.map((r) => {
      const active = Number(r.active_count);
      const utilisation = Math.round((active / DEFAULT_CAPACITY_TARGET) * 1000) / 10;
      return {
        counsellorId: r.counsellor_id,
        counsellorName: r.counsellor_name,
        activeCaseloads: active,
        capacityTarget: DEFAULT_CAPACITY_TARGET,
        utilisationPct: utilisation,
        crisisCount: Number(r.crisis_count),
        academicYearId: r.academic_year_id,
      };
    });

    const totalActive = dashboardRows.reduce((sum, r) => sum + r.activeCaseloads, 0);
    const totalCrisis = dashboardRows.reduce((sum, r) => sum + r.crisisCount, 0);
    const yearId =
      academicYearId ?? dashboardRows[0]?.academicYearId ?? '00000000-0000-0000-0000-000000000000';

    return {
      rows: dashboardRows,
      totalActive,
      totalCrisis,
      academicYearId: yearId,
    };
  }
}
