import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ProgrammeService } from './programme.service';
import {
  CreateInjuryDto,
  InjurySeverity,
  InjuryResponseDto,
  ReturnToPlayStatus,
  UpdateInjuryDto,
} from './dto/athletics.dto';

interface InjuryRow {
  id: string;
  student_id: string;
  student_name: string | null;
  game_id: string | null;
  practice_date: string | null;
  injury_date: string;
  body_part: string;
  injury_description: string;
  initial_assessment: string | null;
  action_taken: string | null;
  severity: string;
  health_record_id: string | null;
  incident_report_id: string | null;
  return_to_play_status: string;
  logged_by: string;
  logged_by_name: string | null;
  logged_at: string;
  cleared_at: string | null;
}

const SELECT_INJURY =
  'SELECT i.id::text AS id, i.student_id::text AS student_id, ' +
  "(ip.first_name || ' ' || ip.last_name) AS student_name, " +
  'i.game_id::text AS game_id, ' +
  "TO_CHAR(i.practice_date, 'YYYY-MM-DD') AS practice_date, " +
  "TO_CHAR(i.injury_date, 'YYYY-MM-DD') AS injury_date, " +
  'i.body_part, i.injury_description, i.initial_assessment, i.action_taken, i.severity, ' +
  'i.health_record_id::text AS health_record_id, i.incident_report_id::text AS incident_report_id, ' +
  'i.return_to_play_status, i.logged_by::text AS logged_by, ' +
  "(SELECT (lp.first_name || ' ' || lp.last_name) FROM hr_employees le " +
  '  JOIN platform.iam_person lp ON lp.id = le.person_id ' +
  '  WHERE le.id = i.logged_by) AS logged_by_name, ' +
  'TO_CHAR(i.logged_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS logged_at, ' +
  'TO_CHAR(i.cleared_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS cleared_at ' +
  'FROM ath_injuries i ' +
  'JOIN sis_students s ON s.id = i.student_id ' +
  'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'JOIN platform.iam_person ip ON ip.id = ps.person_id ';

function rowToDto(r: InjuryRow): InjuryResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name ?? '',
    gameId: r.game_id,
    practiceDate: r.practice_date,
    injuryDate: r.injury_date,
    bodyPart: r.body_part,
    injuryDescription: r.injury_description,
    initialAssessment: r.initial_assessment,
    actionTaken: r.action_taken,
    severity: r.severity as InjurySeverity,
    healthRecordId: r.health_record_id,
    incidentReportId: r.incident_report_id,
    returnToPlayStatus: r.return_to_play_status as ReturnToPlayStatus,
    loggedBy: r.logged_by,
    loggedByName: r.logged_by_name,
    loggedAt: r.logged_at,
    clearedAt: r.cleared_at,
  };
}

@Injectable()
export class InjuryService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  /**
   * Read scope: admins + Staff + students (own only) + teachers
   * (own students). The Step 4 IAM seed grants ATH-004:read to
   * Teacher / Student / Staff / Admin. Parents do NOT receive it.
   * Row scope for non-admin students is enforced at the service
   * layer by resolving the student_id through actor.personId.
   */
  async list(
    filters: { rosterId?: string; status?: ReturnToPlayStatus; studentId?: string },
    actor: ResolvedActor,
  ): Promise<InjuryResponseDto[]> {
    const sql: string[] = [SELECT_INJURY, 'WHERE 1=1 '];
    const params: unknown[] = [];

    if (actor.personType === 'STUDENT') {
      // Resolve actor.personId -> sis_students.id
      const own = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $1::uuid',
          actor.personId,
        );
      })) as Array<{ id: string }>;
      if (own.length === 0) return [];
      params.push(own[0]!.id);
      sql.push('AND i.student_id = $' + params.length + '::uuid ');
    }

    if (filters.studentId) {
      params.push(filters.studentId);
      sql.push('AND i.student_id = $' + params.length + '::uuid ');
    }
    if (filters.status) {
      params.push(filters.status);
      sql.push('AND i.return_to_play_status = $' + params.length + ' ');
    }
    sql.push('ORDER BY i.injury_date DESC, i.logged_at DESC LIMIT 200');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql.join(''), ...params);
    })) as InjuryRow[];
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<InjuryResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_INJURY + 'WHERE i.id = $1::uuid', id);
    })) as InjuryRow[];
    if (rows.length === 0) throw new NotFoundException('Injury not found');
    return rowToDto(rows[0]!);
  }

  async create(input: CreateInjuryDto, actor: ResolvedActor): Promise<InjuryResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can log injuries');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Injury logging requires an hr_employees identity');
    }
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO ath_injuries (id, student_id, game_id, practice_date, injury_date, body_part, injury_description, initial_assessment, action_taken, severity, health_record_id, incident_report_id, return_to_play_status, logged_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $13, $14::uuid)',
          id,
          input.studentId,
          input.gameId ?? null,
          input.practiceDate ?? null,
          input.injuryDate,
          input.bodyPart,
          input.injuryDescription,
          input.initialAssessment ?? null,
          input.actionTaken ?? null,
          input.severity,
          input.healthRecordId ?? null,
          input.incidentReportId ?? null,
          input.returnToPlayStatus,
          actor.employeeId,
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '23503') {
          throw new BadRequestException('studentId or gameId does not match a row in this tenant.');
        }
        throw e;
      }

      // If CONCUSSION_PROTOCOL, flip the matching active roster_member to INJURED_NOT_CLEARED
      if (input.returnToPlayStatus === 'CONCUSSION_PROTOCOL') {
        await tx.$executeRawUnsafe(
          "UPDATE ath_roster_members SET eligibility_status = 'INJURED_NOT_CLEARED', updated_at = now() " +
            'WHERE student_id = $1::uuid AND removed_at IS NULL',
          input.studentId,
        );
      }

      const rows = (await tx.$queryRawUnsafe(
        SELECT_INJURY + 'WHERE i.id = $1::uuid',
        id,
      )) as InjuryRow[];
      return rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateInjuryDto,
    actor: ResolvedActor,
  ): Promise<InjuryResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can edit injuries');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, student_id::text AS student_id, return_to_play_status FROM ath_injuries WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; student_id: string; return_to_play_status: string }>;
      if (lock.length === 0) throw new NotFoundException('Injury not found');

      // CLEARED requires either non-CONCUSSION_PROTOCOL OR all 6 protocol steps complete + accepted clearance
      if (input.returnToPlayStatus === 'CLEARED') {
        const wasConcussion = lock[0]!.return_to_play_status === 'CONCUSSION_PROTOCOL';
        if (wasConcussion) {
          const stepsRows = (await tx.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS c FROM ath_concussion_protocol_steps WHERE injury_id = $1::uuid AND completed_at IS NOT NULL AND symptom_free = true',
            id,
          )) as Array<{ c: number }>;
          if ((stepsRows[0]?.c ?? 0) < 6) {
            throw new BadRequestException(
              'Cannot clear a CONCUSSION_PROTOCOL injury until all 6 protocol steps are completed with symptom_free=true.',
            );
          }
          const clearanceRows = (await tx.$queryRawUnsafe(
            "SELECT COUNT(*)::int AS c FROM ath_medical_clearances WHERE injury_id = $1::uuid AND review_status = 'ACCEPTED'",
            id,
          )) as Array<{ c: number }>;
          if ((clearanceRows[0]?.c ?? 0) === 0) {
            throw new BadRequestException(
              'Cannot clear a CONCUSSION_PROTOCOL injury without an ACCEPTED medical clearance.',
            );
          }
        }
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.initialAssessment !== undefined) {
        params.push(input.initialAssessment);
        sets.push('initial_assessment = $' + params.length);
      }
      if (input.actionTaken !== undefined) {
        params.push(input.actionTaken);
        sets.push('action_taken = $' + params.length);
      }
      if (input.severity !== undefined) {
        params.push(input.severity);
        sets.push('severity = $' + params.length);
      }
      if (input.returnToPlayStatus !== undefined) {
        params.push(input.returnToPlayStatus);
        sets.push('return_to_play_status = $' + params.length);
        if (input.returnToPlayStatus === 'CLEARED') {
          sets.push('cleared_at = now()');
        } else {
          sets.push('cleared_at = NULL');
        }
      }
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        await tx.$executeRawUnsafe(
          'UPDATE ath_injuries SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
          ...params,
        );
      }

      // If we just CLEARED, restore roster eligibility to ELIGIBLE
      if (input.returnToPlayStatus === 'CLEARED') {
        await tx.$executeRawUnsafe(
          "UPDATE ath_roster_members SET eligibility_status = 'ELIGIBLE', updated_at = now() " +
            "WHERE student_id = $1::uuid AND removed_at IS NULL AND eligibility_status = 'INJURED_NOT_CLEARED'",
          lock[0]!.student_id,
        );
      }

      const rows = (await tx.$queryRawUnsafe(
        SELECT_INJURY + 'WHERE i.id = $1::uuid',
        id,
      )) as InjuryRow[];
      return rowToDto(rows[0]!);
    });
  }
}
