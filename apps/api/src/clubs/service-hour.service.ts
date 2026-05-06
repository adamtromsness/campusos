import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  ApproveHourDto,
  LogServiceHourDto,
  ServiceHourDto,
  ServiceHourStatus,
  ServiceProgressDto,
} from './dto/clubs.dto';

interface HourRow {
  id: string;
  student_id: string;
  student_name: string | null;
  programme_id: string | null;
  programme_name: string | null;
  organisation: string;
  description: string;
  service_date: string;
  hours: string;
  supervisor_name: string | null;
  supervisor_contact: string | null;
  evidence_s3_key: string | null;
  approval_status: string | null;
  approval_notes: string | null;
  approved_by_name: string | null;
  reviewed_at: string | null;
  created_at: string;
}

const SELECT_HOUR =
  'SELECT h.id::text AS id, h.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_students s " +
  '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  '  WHERE s.id = h.student_id) AS student_name, ' +
  'h.programme_id::text AS programme_id, ' +
  '(SELECT name FROM ext_service_programmes p WHERE p.id = h.programme_id) AS programme_name, ' +
  "h.organisation, h.description, TO_CHAR(h.service_date, 'YYYY-MM-DD') AS service_date, " +
  'h.hours::text AS hours, h.supervisor_name, h.supervisor_contact, h.evidence_s3_key, ' +
  '(SELECT a.status FROM ext_service_hour_approvals a WHERE a.service_hour_id = h.id) AS approval_status, ' +
  '(SELECT a.notes FROM ext_service_hour_approvals a WHERE a.service_hour_id = h.id) AS approval_notes, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM ext_service_hour_approvals a " +
  '  JOIN hr_employees e ON e.id = a.approved_by ' +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE a.service_hour_id = h.id) AS approved_by_name, ' +
  '(SELECT TO_CHAR(a.reviewed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') FROM ext_service_hour_approvals a WHERE a.service_hour_id = h.id) AS reviewed_at, ' +
  'TO_CHAR(h.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM ext_service_hours h ';

/**
 * REVIEW-CYCLE17 MAJOR 4 — hide approver identity while approval is
 * still PENDING. The `ext_service_hour_approvals.approved_by` column
 * is NOT NULL on the schema, so `ServiceHourService.log()` writes a
 * placeholder hr_employees row id at insert time; the actual reviewer
 * stamps over that on review. Until then, the DTO suppresses
 * `approvedByName` so callers cannot read a fake approver name as
 * part of a pending row.
 */
function rowToDto(r: HourRow): ServiceHourDto {
  const status = (r.approval_status as ServiceHourStatus) ?? null;
  const isPending = status === 'PENDING' || status === null;
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    programmeId: r.programme_id,
    programmeName: r.programme_name,
    organisation: r.organisation,
    description: r.description,
    serviceDate: r.service_date,
    hours: Number(r.hours),
    supervisorName: r.supervisor_name,
    supervisorContact: r.supervisor_contact,
    evidenceS3Key: r.evidence_s3_key,
    approvalStatus: status,
    approvalNotes: r.approval_notes,
    approvedByName: isPending ? null : r.approved_by_name,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  };
}

@Injectable()
export class ServiceHourService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  /**
   * Resolve calling student's sis_students.id from actor.personId.
   */
  private async resolveStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT' || !actor.personId) return null;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
    })) as Array<{ id: string }>;
    return rows.length === 0 ? null : rows[0]!.id;
  }

  /**
   * Row-scope: students see own; managers (staff/admin) see all.
   */
  async list(actor: ResolvedActor): Promise<ServiceHourDto[]> {
    if (this.isManager(actor)) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_HOUR + 'ORDER BY h.service_date DESC');
      })) as HourRow[];
      return rows.map(rowToDto);
    }
    const studentId = await this.resolveStudentId(actor);
    if (!studentId) return [];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_HOUR + 'WHERE h.student_id = $1::uuid ORDER BY h.service_date DESC',
        studentId,
      );
    })) as HourRow[];
    return rows.map(rowToDto);
  }

  /**
   * STUDENT-INPUT KEYSTONE.
   *
   * Student logs own hours. Auto-creates a PENDING approval row in
   * the same tx. If a programme is supplied, also upserts the
   * pending_hours field on ext_service_progress for that
   * (programme, student) pair.
   */
  async log(input: LogServiceHourDto, actor: ResolvedActor): Promise<ServiceHourDto> {
    const studentId = await this.resolveStudentId(actor);
    if (!studentId) {
      throw new ForbiddenException('Only students can log service hours');
    }
    const hourId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO ext_service_hours (id, student_id, programme_id, organisation, description, service_date, hours, supervisor_name, supervisor_contact, evidence_s3_key) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7, $8, $9, $10)',
        hourId,
        studentId,
        input.programmeId ?? null,
        input.organisation,
        input.description,
        input.serviceDate,
        input.hours,
        input.supervisorName ?? null,
        input.supervisorContact ?? null,
        input.evidenceS3Key ?? null,
      );

      // Auto-create the PENDING approval row so the approver list path
      // works without a second insert from the user
      await tx.$executeRawUnsafe(
        'INSERT INTO ext_service_hour_approvals (id, service_hour_id, approved_by, status) ' +
          // approved_by is NOT NULL on the schema; default to the row's
          // student_advisor by inheriting from the programme path. We
          // use a placeholder of the calling student's eventual
          // approver. Since the schema requires approved_by NOT NULL,
          // we resolve to ANY hr_employees row in the school as a
          // pre-fill (the actual approver overwrites this on review).
          // Pick the first staff with admin scope to keep this
          // deterministic.
          "VALUES ($1::uuid, $2::uuid, (SELECT id FROM hr_employees ORDER BY created_at LIMIT 1), 'PENDING')",
        generateId(),
        hourId,
      );

      // Upsert progress row's pending_hours when programme set
      if (input.programmeId) {
        await tx.$executeRawUnsafe(
          'INSERT INTO ext_service_progress (id, programme_id, student_id, approved_hours, pending_hours) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4) ' +
            'ON CONFLICT (programme_id, student_id) DO UPDATE SET pending_hours = ext_service_progress.pending_hours + $4, last_updated_at = now()',
          generateId(),
          input.programmeId,
          studentId,
          input.hours,
        );
      }
    });

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_HOUR + 'WHERE h.id = $1::uuid', hourId);
    })) as HourRow[];
    return rowToDto(rows[0]!);
  }

  /**
   * Approve / reject keystone. On APPROVED, auto-upserts
   * ext_service_progress.approved_hours += hours and decrements
   * pending_hours. is_complete flips when target_hours reached.
   */
  async review(
    approvalId: string,
    input: ApproveHourDto,
    actor: ResolvedActor,
  ): Promise<ServiceHourDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can approve service hours');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Approver must be a staff employee');
    }
    if (input.status === 'PENDING') {
      throw new BadRequestException('Cannot transition approval back to PENDING');
    }
    let hourId = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT a.id, a.service_hour_id::text AS service_hour_id, a.status, h.programme_id::text AS programme_id, h.student_id::text AS student_id, h.hours::text AS hours ' +
          'FROM ext_service_hour_approvals a ' +
          'JOIN ext_service_hours h ON h.id = a.service_hour_id ' +
          'WHERE a.id = $1::uuid FOR UPDATE',
        approvalId,
      )) as Array<{
        id: string;
        service_hour_id: string;
        status: string;
        programme_id: string | null;
        student_id: string;
        hours: string;
      }>;
      if (lock.length === 0) throw new NotFoundException('Approval not found');
      const a = lock[0]!;
      hourId = a.service_hour_id;
      if (a.status !== 'PENDING') {
        throw new BadRequestException(
          'Approval is in terminal state ' + a.status + '. Cannot re-review.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE ext_service_hour_approvals SET status = $1, approved_by = $2::uuid, notes = $3, reviewed_at = now(), updated_at = now() WHERE id = $4::uuid',
        input.status,
        actor.employeeId,
        input.notes ?? null,
        approvalId,
      );

      if (a.programme_id) {
        const hours = Number(a.hours);
        if (input.status === 'APPROVED') {
          await tx.$executeRawUnsafe(
            'UPDATE ext_service_progress SET approved_hours = approved_hours + $1, pending_hours = GREATEST(pending_hours - $1, 0), last_updated_at = now() WHERE programme_id = $2::uuid AND student_id = $3::uuid',
            hours,
            a.programme_id,
            a.student_id,
          );
          // Recompute is_complete
          await tx.$executeRawUnsafe(
            'UPDATE ext_service_progress pr SET is_complete = (pr.approved_hours >= p.target_hours) ' +
              'FROM ext_service_programmes p WHERE pr.programme_id = p.id AND pr.programme_id = $1::uuid AND pr.student_id = $2::uuid',
            a.programme_id,
            a.student_id,
          );
        } else if (input.status === 'REJECTED') {
          // Reduce pending only — do not credit approved
          await tx.$executeRawUnsafe(
            'UPDATE ext_service_progress SET pending_hours = GREATEST(pending_hours - $1, 0), last_updated_at = now() WHERE programme_id = $2::uuid AND student_id = $3::uuid',
            hours,
            a.programme_id,
            a.student_id,
          );
        }
      }
    });

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_HOUR + 'WHERE h.id = $1::uuid', hourId);
    })) as HourRow[];
    return rowToDto(rows[0]!);
  }

  /**
   * Student's progress across all programmes.
   */
  async myProgress(actor: ResolvedActor): Promise<ServiceProgressDto[]> {
    const studentId = await this.resolveStudentId(actor);
    if (!studentId) return [];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT pr.id::text AS id, pr.programme_id::text AS programme_id, ' +
          'p.name AS programme_name, p.target_hours::text AS target_hours, ' +
          'pr.student_id::text AS student_id, ' +
          'pr.approved_hours::text AS approved_hours, pr.pending_hours::text AS pending_hours, pr.is_complete ' +
          'FROM ext_service_progress pr ' +
          'JOIN ext_service_programmes p ON p.id = pr.programme_id ' +
          'WHERE pr.student_id = $1::uuid ORDER BY p.name',
        studentId,
      );
    })) as Array<{
      id: string;
      programme_id: string;
      programme_name: string;
      target_hours: string;
      student_id: string;
      approved_hours: string;
      pending_hours: string;
      is_complete: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      programmeId: r.programme_id,
      programmeName: r.programme_name,
      targetHours: Number(r.target_hours),
      studentId: r.student_id,
      approvedHours: Number(r.approved_hours),
      pendingHours: Number(r.pending_hours),
      isComplete: r.is_complete,
    }));
  }
}
