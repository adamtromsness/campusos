import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  ComplianceDashboardDto,
  ComplianceRowDto,
  EmployeeComplianceDto,
} from './dto/compliance.dto';

interface ComplianceRow {
  employee_id: string;
  employee_first_name: string;
  employee_last_name: string;
  primary_position_title: string | null;
  requirement_id: string;
  requirement_name: string;
  requirement_certification_type: string | null;
  frequency: string;
  is_compliant: boolean;
  last_completed_date: string | null;
  next_due_date: string | null;
  linked_certification_id: string | null;
  days_until_due: number | null;
}

function urgencyFor(row: ComplianceRow): 'green' | 'amber' | 'red' {
  if (row.is_compliant) {
    if (row.days_until_due !== null && row.days_until_due <= 90) return 'amber';
    return 'green';
  }
  if (row.days_until_due !== null && row.days_until_due > 0 && row.days_until_due <= 90) {
    return 'amber';
  }
  return 'red';
}

function rowToDto(row: ComplianceRow): ComplianceRowDto {
  return {
    requirementId: row.requirement_id,
    requirementName: row.requirement_name,
    certificationType: row.requirement_certification_type,
    frequency: row.frequency,
    isCompliant: row.is_compliant,
    lastCompletedDate: row.last_completed_date,
    nextDueDate: row.next_due_date,
    linkedCertificationId: row.linked_certification_id,
    daysUntilDue: row.days_until_due === null ? null : Number(row.days_until_due),
    urgency: urgencyFor(row),
  };
}

var SELECT_COMPLIANCE_BASE =
  'SELECT c.employee_id, ip.first_name AS employee_first_name, ip.last_name AS employee_last_name, ' +
  'pos.title AS primary_position_title, ' +
  'c.requirement_id, r.training_name AS requirement_name, r.certification_type AS requirement_certification_type, ' +
  'r.frequency, c.is_compliant, ' +
  "TO_CHAR(c.last_completed_date, 'YYYY-MM-DD') AS last_completed_date, " +
  "TO_CHAR(c.next_due_date, 'YYYY-MM-DD') AS next_due_date, " +
  'c.linked_certification_id, c.days_until_due ' +
  'FROM hr_training_compliance c ' +
  'JOIN hr_training_requirements r ON r.id = c.requirement_id ' +
  'JOIN hr_employees e ON e.id = c.employee_id ' +
  'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  'LEFT JOIN hr_employee_positions ep ON ep.employee_id = e.id AND ep.is_primary = true AND ep.effective_to IS NULL ' +
  'LEFT JOIN hr_positions pos ON pos.id = ep.position_id ';

@Injectable()
export class TrainingComplianceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * Per-employee compliance breakdown. Visibility:
   *   - Admin can read any employee's compliance.
   *   - Owning employee can read their own.
   *   - Anyone else gets 403.
   */
  async getForEmployee(employeeId: string, actor: ResolvedActor): Promise<EmployeeComplianceDto> {
    if (!actor.isSchoolAdmin && actor.employeeId !== employeeId) {
      throw new ForbiddenException(
        'Only the owning employee or a school admin can read compliance details',
      );
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ComplianceRow[]>(
        SELECT_COMPLIANCE_BASE + 'WHERE c.employee_id = $1::uuid ORDER BY r.training_name',
        employeeId,
      );
    });
    return this.aggregate(employeeId, rows);
  }

  /**
   * School-wide dashboard for admins. Aggregates per-employee rows and
   * returns the school's total + the count of employees with at least one
   * red or amber row.
   *
   * Auth (REVIEW-CYCLE4 MAJOR 2): accepts School Admins (`sch-001:admin`,
   * surfaced as `actor.isSchoolAdmin`) AND HR-Compliance Admins
   * (`hr-004:admin` resolved via the tenant scope chain). The web tile in
   * `apps.tsx` already gates on the same `sch-001:admin OR hr-004:admin`
   * union, so the API and UI agree.
   */
  async getDashboard(actor: ResolvedActor): Promise<ComplianceDashboardDto> {
    var allowed = actor.isSchoolAdmin;
    if (!allowed) {
      var tenant = getCurrentTenant();
      allowed = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
        'hr-004:admin',
      ]);
    }
    if (!allowed) {
      throw new ForbiddenException('Only admins can read the compliance dashboard');
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ComplianceRow[]>(
        SELECT_COMPLIANCE_BASE + 'ORDER BY ip.last_name, ip.first_name, r.training_name',
      );
    });

    var byEmployee: Record<string, ComplianceRow[]> = {};
    var employeeOrder: string[] = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]!;
      if (!byEmployee[r.employee_id]) {
        byEmployee[r.employee_id] = [];
        employeeOrder.push(r.employee_id);
      }
      byEmployee[r.employee_id]!.push(r);
    }
    // Also include employees with zero compliance rows so the dashboard
    // shows the full roster.
    var allEmployees = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          first_name: string;
          last_name: string;
          primary_position_title: string | null;
        }>
      >(
        'SELECT e.id, ip.first_name, ip.last_name, pos.title AS primary_position_title ' +
          'FROM hr_employees e ' +
          'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
          'LEFT JOIN hr_employee_positions ep ON ep.employee_id = e.id AND ep.is_primary = true AND ep.effective_to IS NULL ' +
          'LEFT JOIN hr_positions pos ON pos.id = ep.position_id ' +
          "WHERE e.employment_status = 'ACTIVE' " +
          'ORDER BY ip.last_name, ip.first_name',
      );
    });

    var employees: EmployeeComplianceDto[] = [];
    var employeesWithGaps = 0;
    for (var ai = 0; ai < allEmployees.length; ai++) {
      var emp = allEmployees[ai]!;
      var empRows = byEmployee[emp.id] ?? [];
      // Hydrate the per-row primary_position_title from the roster row in
      // case the empty-rows employees come through here.
      var hydrated: ComplianceRow[] = empRows.map(function (er) {
        return Object.assign({}, er, {
          primary_position_title: er.primary_position_title ?? emp.primary_position_title,
          employee_first_name: emp.first_name,
          employee_last_name: emp.last_name,
        });
      });
      var aggregated: EmployeeComplianceDto = this.aggregate(emp.id, hydrated, {
        firstName: emp.first_name,
        lastName: emp.last_name,
        primaryPositionTitle: emp.primary_position_title,
      });
      employees.push(aggregated);
      if (aggregated.amberCount > 0 || aggregated.redCount > 0) employeesWithGaps++;
    }

    return {
      employees: employees,
      totalEmployees: employees.length,
      employeesWithGaps: employeesWithGaps,
    };
  }

  private aggregate(
    employeeId: string,
    rows: ComplianceRow[],
    fallback?: { firstName: string; lastName: string; primaryPositionTitle: string | null },
  ): EmployeeComplianceDto {
    var dtoRows = rows.map(rowToDto);
    var compliantCount = 0;
    var amberCount = 0;
    var redCount = 0;
    for (var i = 0; i < dtoRows.length; i++) {
      var u = dtoRows[i]!.urgency;
      if (u === 'green') compliantCount++;
      else if (u === 'amber') amberCount++;
      else redCount++;
    }
    var firstRow = rows[0];
    var firstName = firstRow ? firstRow.employee_first_name : (fallback?.firstName ?? '');
    var lastName = firstRow ? firstRow.employee_last_name : (fallback?.lastName ?? '');
    var primaryPositionTitle = firstRow
      ? firstRow.primary_position_title
      : (fallback?.primaryPositionTitle ?? null);
    return {
      employeeId: employeeId,
      employeeName: firstName + ' ' + lastName,
      primaryPositionTitle: primaryPositionTitle,
      rows: dtoRows,
      totalRequirements: dtoRows.length,
      compliantCount: compliantCount,
      amberCount: amberCount,
      redCount: redCount,
    };
  }
}
