import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { CreateReenrolDto, ReenrolResponseDto, ReenrolSummaryDto } from '../withdrawals/dto/withdrawal.dto';
import { WithdrawalService } from '../withdrawals/withdrawal.service';

interface ReenrolRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  student_grade: string | null;
  academic_year_id: string;
  academic_year_name: string | null;
  submitted_by: string;
  submitted_by_first_name: string | null;
  submitted_by_last_name: string | null;
  confirmed_continuing: boolean;
  withdrawal_reason: string | null;
  submitted_at: string;
  processed_by: string | null;
  processed_by_first_name: string | null;
  processed_by_last_name: string | null;
  processed_at: string | null;
  linked_withdrawal_id: string | null;
  notes: string | null;
}

const SELECT_REENROL_BASE =
  'SELECT r.id, r.school_id, r.student_id, ' +
  '       sp.first_name AS student_first_name, sp.last_name AS student_last_name, ' +
  '       s.grade_level AS student_grade, ' +
  '       r.academic_year_id, ay.name AS academic_year_name, ' +
  '       r.submitted_by, ' +
  '       sub.first_name AS submitted_by_first_name, sub.last_name AS submitted_by_last_name, ' +
  '       r.confirmed_continuing, r.withdrawal_reason, ' +
  '       r.submitted_at::text AS submitted_at, ' +
  '       r.processed_by, ' +
  '       proc.first_name AS processed_by_first_name, proc.last_name AS processed_by_last_name, ' +
  '       r.processed_at::text AS processed_at, ' +
  '       r.linked_withdrawal_id, r.notes ' +
  'FROM enr_reenrollment_confirmations r ' +
  'LEFT JOIN sis_students s ON s.id = r.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person sp ON sp.id = ps.person_id ' +
  'LEFT JOIN sis_academic_years ay ON ay.id = r.academic_year_id ' +
  'LEFT JOIN platform.iam_person sub ON sub.id = r.submitted_by ' +
  'LEFT JOIN platform.iam_person proc ON proc.id = r.processed_by ';

function name(f: string | null, l: string | null): string | null {
  if (!f && !l) return null;
  return [f, l].filter(Boolean).join(' ');
}

function rowToDto(r: ReenrolRow): ReenrolResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentFirstName: r.student_first_name,
    studentLastName: r.student_last_name,
    academicYearId: r.academic_year_id,
    academicYearName: r.academic_year_name,
    submittedBy: r.submitted_by,
    submittedByName: name(r.submitted_by_first_name, r.submitted_by_last_name),
    confirmedContinuing: r.confirmed_continuing,
    withdrawalReason: r.withdrawal_reason,
    submittedAt: r.submitted_at,
    processedBy: r.processed_by,
    processedByName: name(r.processed_by_first_name, r.processed_by_last_name),
    processedAt: r.processed_at,
    linkedWithdrawalId: r.linked_withdrawal_id,
    notes: r.notes,
  };
}

/**
 * ReenrolmentService — guardian submits next-year confirmation.
 *
 * Authorisation contract:
 *   - submit — guardian (stu-004:write) for own children only
 *     (sis_student_guardians row scope). Admin / staff bypass.
 *   - list (admin) — sees the school-wide queue for an academic year.
 *   - summary (admin) — per-grade continuing vs departing counts.
 *   - own list — parent reads only own confirmations.
 *
 * Side effect (the keystone): when confirmed_continuing=false the
 * service auto-initiates an enr_withdrawal_request inside the same
 * tenant tx via WithdrawalService.createInternal — the
 * linked_withdrawal_id gets stamped on the new confirmation row so
 * the dashboard surface can pivot to the linked withdrawal in one
 * click.
 */
@Injectable()
export class ReenrolmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly withdrawals: WithdrawalService,
  ) {}

  private async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:admin',
    ]);
  }

  /**
   * REVIEW-P2-5 BLOCKING 3 — operator scope replaces the old
   * `personType === 'STAFF'` shortcut. Only school admin OR a
   * STAFF actor who explicitly holds STU-004 (Enrolment Officer
   * or Vice Principal) sees school-wide queues / bypasses the
   * guardian check.
   */
  private async hasOperatorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:write',
      'stu-004:admin',
    ]);
  }

  private async assertGuardianOfStudent(actor: ResolvedActor, studentId: string): Promise<void> {
    if (await this.hasOperatorScope(actor)) return;
    if (actor.personType !== 'GUARDIAN') {
      throw new ForbiddenException(
        'Only guardians or admins can submit a re-enrolment confirmation.',
      );
    }
    const tenant = getCurrentTenant();
    const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 FROM sis_students s ' +
          'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE s.school_id = $1::uuid AND s.id = $2::uuid AND g.person_id = $3::uuid LIMIT 1',
        tenant.schoolId,
        studentId,
        actor.personId,
      )) as Array<unknown>;
      return rows.length > 0;
    });
    if (!ok) {
      throw new ForbiddenException(
        'You can only confirm re-enrolment for a student linked to your guardian record.',
      );
    }
  }

  async submit(input: CreateReenrolDto, actor: ResolvedActor): Promise<ReenrolResponseDto> {
    if (input.confirmedContinuing && input.withdrawalReason) {
      throw new BadRequestException(
        'withdrawalReason must be empty when confirmed_continuing=true.',
      );
    }
    if (!input.confirmedContinuing) {
      const reason = (input.withdrawalReason ?? '').trim();
      if (reason.length === 0) {
        throw new BadRequestException(
          'withdrawalReason is required when confirmed_continuing=false (reason_chk schema invariant).',
        );
      }
    }
    await this.assertGuardianOfStudent(actor, input.studentId);

    // Hold check — refuse if a prior withdrawal blocked re-enrolment.
    const onHold = await this.withdrawals.hasActiveHoldForStudent(input.studentId);
    if (onHold && input.confirmedContinuing) {
      throw new BadRequestException(
        'This student has an active re-enrolment hold. Contact the admissions office to resolve.',
      );
    }

    const tenant = getCurrentTenant();
    const id = generateId();

    // REVIEW-P2-5 BLOCKING 2 — single tenant tx for both
    // confirmation INSERT AND auto-initiated withdrawal so a
    // duplicate-confirmation collision rolls the withdrawal back
    // atomically. Previously withdrawal lived in a committed-prior
    // tx; if the confirmation INSERT failed on UNIQUE(student,
    // academic_year_id) the school ended up with an orphan
    // withdrawal in REQUESTED status.
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        let linkedWithdrawalId: string | null = null;
        if (!input.confirmedContinuing) {
          // Auto-initiate the withdrawal in the SAME tx as the
          // confirmation INSERT so a UNIQUE collision rolls them
          // back together.
          linkedWithdrawalId = await this.withdrawals.createInTx(
            tx as never,
            {
              studentId: input.studentId,
              initiatedBy: 'FAMILY',
              requestedBy: actor.personId,
              withdrawalReasonCategory: 'OTHER',
              withdrawalReasonDetail:
                'Auto-initiated from re-enrolment confirmation (confirmed_continuing=false). Family reason: ' +
                (input.withdrawalReason ?? ''),
              lastAttendanceDate: new Date().toISOString().slice(0, 10),
              notes: input.notes ?? undefined,
            },
            actor,
          );
        }

        await tx.$executeRawUnsafe(
          'INSERT INTO enr_reenrollment_confirmations ' +
            '(id, school_id, student_id, academic_year_id, submitted_by, confirmed_continuing, ' +
            ' withdrawal_reason, linked_withdrawal_id, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::uuid, $9)',
          id,
          tenant.schoolId,
          input.studentId,
          input.academicYearId,
          actor.personId,
          input.confirmedContinuing,
          input.withdrawalReason ?? null,
          linkedWithdrawalId,
          input.notes ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A re-enrolment confirmation already exists for this student and academic year.',
        );
      }
      throw err;
    }
    return this.getById(id, actor);
  }

  async getById(id: string, actor: ResolvedActor): Promise<ReenrolResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REENROL_BASE + 'WHERE r.school_id = $1::uuid AND r.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ReenrolRow[];
      if (rows.length === 0) throw new NotFoundException('Re-enrolment confirmation not found');
      const row = rows[0] as ReenrolRow;
      // REVIEW-P2-5 BLOCKING 3 — operator scope replaces broad
      // STAFF shortcut. Non-operator non-submitter gets 404.
      const operator = await this.hasOperatorScope(actor);
      if (!operator) {
        if (row.submitted_by !== actor.personId) {
          throw new NotFoundException('Re-enrolment confirmation not found');
        }
      }
      return rowToDto(row);
    });
  }

  async list(
    actor: ResolvedActor,
    args: { academicYearId?: string; mine?: boolean } = {},
  ): Promise<ReenrolResponseDto[]> {
    const tenant = getCurrentTenant();
    const operator = await this.hasOperatorScope(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const sqlArgs: unknown[] = [tenant.schoolId];
      let where = 'r.school_id = $1::uuid ';
      if (args.academicYearId) {
        sqlArgs.push(args.academicYearId);
        where += '  AND r.academic_year_id = $' + sqlArgs.length + '::uuid ';
      }
      if (args.mine || !operator) {
        sqlArgs.push(actor.personId);
        where += '  AND r.submitted_by = $' + sqlArgs.length + '::uuid ';
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_REENROL_BASE + 'WHERE ' + where + 'ORDER BY r.submitted_at DESC LIMIT 1000',
        ...sqlArgs,
      )) as ReenrolRow[];
      return rows.map(rowToDto);
    });
  }

  /**
   * Admin summary — per-grade continuing vs departing vs outstanding
   * for an academic year. Outstanding = active students enrolled
   * who have NOT yet submitted a confirmation.
   */
  async summary(actor: ResolvedActor, academicYearId: string): Promise<ReenrolSummaryDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Re-enrolment summary requires stu-004:admin');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const yearRows = (await client.$queryRawUnsafe(
        'SELECT name FROM sis_academic_years WHERE id = $1::uuid LIMIT 1',
        academicYearId,
      )) as Array<{ name: string }>;
      const yearName = yearRows[0]?.name ?? null;

      const perGradeRows = (await client.$queryRawUnsafe(
        'WITH active AS ( ' +
          "  SELECT id, grade_level FROM sis_students WHERE school_id = $1::uuid AND enrollment_status = 'ACTIVE' " +
          '), confirmations AS ( ' +
          '  SELECT student_id, confirmed_continuing FROM enr_reenrollment_confirmations ' +
          '  WHERE school_id = $1::uuid AND academic_year_id = $2::uuid ' +
          ') ' +
          'SELECT a.grade_level, ' +
          '       COUNT(*)::int AS total, ' +
          '       COALESCE(SUM(CASE WHEN c.confirmed_continuing = true THEN 1 ELSE 0 END), 0)::int AS continuing, ' +
          '       COALESCE(SUM(CASE WHEN c.confirmed_continuing = false THEN 1 ELSE 0 END), 0)::int AS departing, ' +
          '       COALESCE(SUM(CASE WHEN c.confirmed_continuing IS NULL THEN 1 ELSE 0 END), 0)::int AS outstanding ' +
          'FROM active a LEFT JOIN confirmations c ON c.student_id = a.id ' +
          'GROUP BY a.grade_level ORDER BY a.grade_level',
        tenant.schoolId,
        academicYearId,
      )) as Array<{
        grade_level: string;
        total: number;
        continuing: number;
        departing: number;
        outstanding: number;
      }>;

      const perGrade = perGradeRows.map((r) => ({
        gradeLevel: r.grade_level,
        continuing: r.continuing,
        departing: r.departing,
        outstanding: r.outstanding,
        total: r.total,
      }));

      const totals = perGrade.reduce(
        (acc, r) => ({
          totalStudents: acc.totalStudents + r.total,
          continuing: acc.continuing + r.continuing,
          departing: acc.departing + r.departing,
          outstanding: acc.outstanding + r.outstanding,
        }),
        { totalStudents: 0, continuing: 0, departing: 0, outstanding: 0 },
      );

      return {
        academicYearId,
        academicYearName: yearName,
        totalStudents: totals.totalStudents,
        totalConfirmed: totals.continuing + totals.departing,
        continuing: totals.continuing,
        departing: totals.departing,
        outstanding: totals.outstanding,
        perGrade,
      };
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.code === '23505') return true;
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta && meta.code === '23505') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return msg.includes('duplicate key') || msg.includes('unique constraint');
}
