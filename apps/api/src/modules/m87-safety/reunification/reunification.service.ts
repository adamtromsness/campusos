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
import { AccountabilityService } from '../reunification/accountability.service';
import {
  CorrectReunificationDto,
  CreateReunificationDto,
  ReunificationCorrectionDto,
  ReunificationRecordDto,
} from '../common/dto/incident.dto';

interface ReunificationRow {
  id: string;
  incident_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  released_to_id: string;
  released_to_first: string | null;
  released_to_last: string | null;
  released_by: string;
  released_by_first: string | null;
  released_by_last: string | null;
  released_at: string;
  notes: string | null;
}

interface CorrectionRow {
  id: string;
  reunification_record_id: string;
  corrected_by: string;
  corrected_by_first: string | null;
  corrected_by_last: string | null;
  correction_reason: string;
  corrected_at: string;
}

const SELECT_REUN_BASE =
  'SELECT r.id::text AS id, r.incident_id::text AS incident_id, ' +
  '       r.student_id::text AS student_id, ' +
  // sis_students does not carry first_name / last_name — resolve them
  // through the platform_students → iam_person chain like every other
  // module that walks sis_students (see m23 ScreeningService, m20
  // StudentService, m27 caseload, etc).
  '       sip.first_name AS student_first, sip.last_name AS student_last, ' +
  '       r.released_to_id::text AS released_to_id, ' +
  '       v.first_name AS released_to_first, v.last_name AS released_to_last, ' +
  '       r.released_by::text AS released_by, ' +
  '       ip.first_name AS released_by_first, ip.last_name AS released_by_last, ' +
  '       r.released_at::text AS released_at, r.notes ' +
  'FROM inc_reunification_records r ' +
  'LEFT JOIN sis_students s ON s.id = r.student_id ' +
  'LEFT JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN vis_visitors v ON v.id = r.released_to_id ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = r.released_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = pu.person_id ';

const SELECT_CORR_BASE =
  'SELECT c.id::text AS id, c.reunification_record_id::text AS reunification_record_id, ' +
  '       c.corrected_by::text AS corrected_by, ' +
  '       ip.first_name AS corrected_by_first, ip.last_name AS corrected_by_last, ' +
  '       c.correction_reason, c.corrected_at::text AS corrected_at ' +
  'FROM inc_reunification_corrections c ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = c.corrected_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = pu.person_id ';

@Injectable()
export class ReunificationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly accountability: AccountabilityService,
  ) {}

  /**
   * Release a student to an identity-verified adult who is currently
   * signed in via vis_sign_ins (P2C1). The full lifecycle in one
   * tenant tx: (1) verify visitor sign-in is active, (2) verify student
   * is in this tenant, (3) verify no prior reunification for this
   * (incident, student), (4) INSERT reunification_record,
   * (5) flip the student's accountability_record to ACCOUNTED_FOR
   * + recompute summary, (6) append an immutable timeline entry.
   */
  async create(
    incidentId: string,
    input: CreateReunificationDto,
    actor: ResolvedActor,
  ): Promise<ReunificationRecordDto> {
    await this.assertReceptionStaff(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Step 1 — incident in this tenant + ACTIVE.
      const incRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM inc_incidents ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as Array<{ id: string; status: string }>;
      if (incRows.length === 0) throw new NotFoundException('Incident not found');
      if (incRows[0]!.status !== 'ACTIVE') {
        throw new BadRequestException('Reunification only available during ACTIVE incidents');
      }

      // Step 2 — student in this tenant.
      const stuRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      )) as Array<{ id: string }>;
      if (stuRows.length === 0) {
        throw new BadRequestException('Student not found in this tenant');
      }

      // Step 3 — released_to_id MUST be a vis_visitors row in this school
      // currently signed in (vis_sign_ins.signed_out_at IS NULL).
      // Cross-cycle integration with P2C1.
      const visRows = (await tx.$queryRawUnsafe(
        'SELECT v.id::text AS id, v.school_id::text AS school_id, ' +
          '       (SELECT COUNT(*)::int FROM vis_sign_ins s ' +
          '         WHERE s.visitor_id = v.id AND s.school_id = v.school_id ' +
          '           AND s.signed_out_at IS NULL) AS active_signins ' +
          'FROM vis_visitors v WHERE v.id = $1::uuid AND v.school_id = $2::uuid LIMIT 1',
        input.releasedToId,
        tenant.schoolId,
      )) as Array<{ id: string; school_id: string; active_signins: number }>;
      if (visRows.length === 0) {
        throw new BadRequestException(
          'releasedToId must be a vis_visitors row in this school. The collecting adult must sign in as a visitor first.',
        );
      }
      if (visRows[0]!.active_signins === 0) {
        throw new BadRequestException(
          'The collecting adult must be currently signed in. Direct them to the front desk to sign in before the release.',
        );
      }

      // Step 4 — guard against duplicate reunification for the same (incident, student).
      const dupRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM inc_reunification_records ' +
          'WHERE incident_id = $1::uuid AND student_id = $2::uuid LIMIT 1',
        incidentId,
        input.studentId,
      )) as Array<{ id: string }>;
      if (dupRows.length > 0) {
        throw new BadRequestException(
          'This student is already reunified for this incident. Submit a correction instead if the prior release was wrong.',
        );
      }

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_reunification_records ' +
          '(id, incident_id, student_id, released_to_id, released_by, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)',
        id,
        incidentId,
        input.studentId,
        input.releasedToId,
        actor.accountId,
        input.notes ?? null,
      );

      // Step 5 — flip the student's accountability row to ACCOUNTED_FOR if it
      // exists. If no prior row exists, create one (manual reunifications
      // can outpace the muster snapshot).
      const accUpdate = (await tx.$queryRawUnsafe(
        'UPDATE inc_accountability_records SET status = $1, ' +
          '  last_updated_by = $2::uuid, last_updated_at = now(), ' +
          "  notes = COALESCE(notes, '') || E'\\nReunified.' " +
          'WHERE incident_id = $3::uuid AND person_id = $4::uuid ' +
          "  AND person_type = 'STUDENT' RETURNING id",
        'ACCOUNTED_FOR',
        actor.accountId,
        incidentId,
        input.studentId,
      )) as Array<{ id: string }>;
      if (accUpdate.length === 0) {
        await tx.$executeRawUnsafe(
          'INSERT INTO inc_accountability_records ' +
            '(id, incident_id, person_id, person_type, status, last_updated_by, last_updated_at, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, now(), $7) ' +
            'ON CONFLICT (incident_id, person_id) DO NOTHING',
          generateId(),
          incidentId,
          input.studentId,
          'STUDENT',
          'ACCOUNTED_FOR',
          actor.accountId,
          'Reunification.',
        );
      }
      await this.accountability.recomputeSummaryInTx(tx, incidentId);

      // Step 6 — append immutable timeline entry inline.
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_incident_timeline ' +
          '(id, incident_id, recorded_by, event_type, description, metadata) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)',
        generateId(),
        incidentId,
        actor.accountId,
        'REUNIFICATION',
        'Student released to verified adult.',
        JSON.stringify({
          studentId: input.studentId,
          releasedToId: input.releasedToId,
          reunificationId: id,
        }),
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_REUN_BASE + 'WHERE r.id = $1::uuid LIMIT 1',
        id,
      )) as ReunificationRow[];
      return this.rowToDtoWithCorrections(rows[0]!, []);
    });
  }

  /** Audit chain — record a correction with mandatory reason + min length. */
  async correct(
    reunificationId: string,
    input: CorrectReunificationDto,
    actor: ResolvedActor,
  ): Promise<ReunificationCorrectionDto> {
    await this.assertReceptionStaff(actor);
    const tenant = getCurrentTenant();
    const reason = (input.correctionReason ?? '').trim();
    if (reason.length < 20) {
      throw new BadRequestException(
        'correctionReason must be at least 20 characters and explain the cause of the correction.',
      );
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.incident_id::text AS incident_id ' +
          'FROM inc_reunification_records r ' +
          'JOIN inc_incidents i ON i.id = r.incident_id AND i.school_id = $1::uuid ' +
          'WHERE r.id = $2::uuid FOR UPDATE OF r',
        tenant.schoolId,
        reunificationId,
      )) as Array<{ id: string; incident_id: string }>;
      if (lock.length === 0) throw new NotFoundException('Reunification record not found');

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_reunification_corrections ' +
          '(id, reunification_record_id, corrected_by, correction_reason) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
        id,
        reunificationId,
        actor.accountId,
        reason,
      );

      // Append immutable timeline entry.
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_incident_timeline ' +
          '(id, incident_id, recorded_by, event_type, description, metadata) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)',
        generateId(),
        lock[0]!.incident_id,
        actor.accountId,
        'REUNIFICATION_CORRECTION',
        'Reunification correction recorded.',
        JSON.stringify({ reunificationId: lock[0]!.id, correctionId: id }),
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_CORR_BASE + 'WHERE c.id = $1::uuid LIMIT 1',
        id,
      )) as CorrectionRow[];
      return this.corrRowToDto(rows[0]!);
    });
  }

  async listForIncident(incidentId: string): Promise<ReunificationRecordDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const incs = (await client.$queryRawUnsafe(
        'SELECT id FROM inc_incidents WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as Array<{ id: string }>;
      if (incs.length === 0) throw new NotFoundException('Incident not found');

      const reuns = (await client.$queryRawUnsafe(
        SELECT_REUN_BASE + 'WHERE r.incident_id = $1::uuid ORDER BY r.released_at DESC',
        incidentId,
      )) as ReunificationRow[];
      if (reuns.length === 0) return [];

      const ids = reuns.map((r) => r.id);
      const corrs = (await client.$queryRawUnsafe(
        SELECT_CORR_BASE +
          'WHERE c.reunification_record_id = ANY($1::uuid[]) ORDER BY c.corrected_at ASC',
        ids,
      )) as CorrectionRow[];
      const byParent = new Map<string, CorrectionRow[]>();
      for (const c of corrs) {
        const arr = byParent.get(c.reunification_record_id) ?? [];
        arr.push(c);
        byParent.set(c.reunification_record_id, arr);
      }
      return reuns.map((r) => this.rowToDtoWithCorrections(r, byParent.get(r.id) ?? []));
    });
  }

  private async assertReceptionStaff(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Reunification requires saf-001:write or school admin (reception staff or safeguarding).',
      );
    }
  }

  private rowToDtoWithCorrections(
    r: ReunificationRow,
    corrs: CorrectionRow[],
  ): ReunificationRecordDto {
    return {
      id: r.id,
      incidentId: r.incident_id,
      studentId: r.student_id,
      studentName: this.fullName(r.student_first, r.student_last),
      releasedToId: r.released_to_id,
      releasedToName: this.fullName(r.released_to_first, r.released_to_last),
      releasedBy: r.released_by,
      releasedByName: this.fullName(r.released_by_first, r.released_by_last),
      releasedAt: r.released_at,
      notes: r.notes,
      corrections: corrs.map((c) => this.corrRowToDto(c)),
    };
  }

  private corrRowToDto(c: CorrectionRow): ReunificationCorrectionDto {
    return {
      id: c.id,
      reunificationRecordId: c.reunification_record_id,
      correctedBy: c.corrected_by,
      correctedByName: this.fullName(c.corrected_by_first, c.corrected_by_last),
      correctionReason: c.correction_reason,
      correctedAt: c.corrected_at,
    };
  }

  private fullName(first: string | null, last: string | null): string | null {
    if (!first && !last) return null;
    return [first, last].filter(Boolean).join(' ');
  }
}
