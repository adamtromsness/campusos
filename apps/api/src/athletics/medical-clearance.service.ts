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
  ClearanceReviewStatus,
  MedicalClearanceResponseDto,
  ReviewClearanceDto,
  UploadClearanceDto,
} from './dto/athletics.dto';

interface ClearanceRow {
  id: string;
  injury_id: string;
  document_s3_key: string;
  physician_name: string | null;
  physician_phone: string | null;
  clearance_date: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  uploaded_at: string;
  review_status: string;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  expires_at: string | null;
}

const SELECT_CLEARANCE =
  'SELECT c.id::text AS id, c.injury_id::text AS injury_id, c.document_s3_key, ' +
  "c.physician_name, c.physician_phone, TO_CHAR(c.clearance_date, 'YYYY-MM-DD') AS clearance_date, " +
  'c.uploaded_by::text AS uploaded_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees he " +
  '  JOIN platform.iam_person ip ON ip.id = he.person_id WHERE he.id = c.uploaded_by) AS uploaded_by_name, ' +
  'TO_CHAR(c.uploaded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS uploaded_at, ' +
  'c.review_status, c.reviewed_by::text AS reviewed_by, ' +
  "(SELECT (rp.first_name || ' ' || rp.last_name) FROM hr_employees re " +
  '  JOIN platform.iam_person rp ON rp.id = re.person_id WHERE re.id = c.reviewed_by) AS reviewed_by_name, ' +
  'TO_CHAR(c.reviewed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS reviewed_at, ' +
  "c.review_notes, TO_CHAR(c.expires_at, 'YYYY-MM-DD') AS expires_at " +
  'FROM ath_medical_clearances c ';

function rowToDto(r: ClearanceRow): MedicalClearanceResponseDto {
  return {
    id: r.id,
    injuryId: r.injury_id,
    documentS3Key: r.document_s3_key,
    physicianName: r.physician_name,
    physicianPhone: r.physician_phone,
    clearanceDate: r.clearance_date,
    uploadedBy: r.uploaded_by,
    uploadedByName: r.uploaded_by_name,
    uploadedAt: r.uploaded_at,
    reviewStatus: r.review_status as ClearanceReviewStatus,
    reviewedBy: r.reviewed_by,
    reviewedByName: r.reviewed_by_name,
    reviewedAt: r.reviewed_at,
    reviewNotes: r.review_notes,
    expiresAt: r.expires_at,
  };
}

@Injectable()
export class MedicalClearanceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  async listForInjury(injuryId: string): Promise<MedicalClearanceResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CLEARANCE + 'WHERE c.injury_id = $1::uuid ORDER BY c.uploaded_at DESC',
        injuryId,
      );
    })) as ClearanceRow[];
    return rows.map(rowToDto);
  }

  async upload(
    injuryId: string,
    input: UploadClearanceDto,
    actor: ResolvedActor,
  ): Promise<MedicalClearanceResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can upload medical clearances');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Clearance upload requires an hr_employees identity');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO ath_medical_clearances (id, injury_id, document_s3_key, physician_name, physician_phone, clearance_date, uploaded_by, expires_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::uuid, $8::date)',
        id,
        injuryId,
        input.documentS3Key,
        input.physicianName ?? null,
        input.physicianPhone ?? null,
        input.clearanceDate,
        actor.employeeId,
        input.expiresAt ?? null,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_CLEARANCE + 'WHERE c.id = $1::uuid', id);
    })) as ClearanceRow[];
    return rowToDto(rows[0]!);
  }

  /**
   * Review the clearance. On ACCEPTED, the service walks the parent
   * injury and (when CONCUSSION_PROTOCOL) checks all 6 protocol
   * steps are completed before flipping return_to_play_status to
   * CLEARED. For non-concussion injuries, ACCEPTED immediately
   * flips return_to_play_status to CLEARED. The roster member's
   * eligibility_status is restored to ELIGIBLE atomically.
   */
  async review(
    id: string,
    body: ReviewClearanceDto,
    actor: ResolvedActor,
  ): Promise<MedicalClearanceResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can review medical clearances');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Clearance review requires an hr_employees identity');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        "SELECT id, injury_id::text AS injury_id, review_status FROM ath_medical_clearances WHERE id = $1::uuid AND review_status = 'PENDING' FOR UPDATE",
        id,
      )) as Array<{ id: string; injury_id: string; review_status: string }>;
      if (lock.length === 0) {
        throw new BadRequestException(
          'Clearance not found or no longer in PENDING state. Reload and try again.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE ath_medical_clearances SET review_status = $1, reviewed_by = $2::uuid, reviewed_at = now(), review_notes = $3, updated_at = now() WHERE id = $4::uuid',
        body.decision,
        actor.employeeId,
        body.reviewNotes ?? null,
        id,
      );

      if (body.decision === 'ACCEPTED') {
        const injId = lock[0]!.injury_id;
        const injRows = (await tx.$queryRawUnsafe(
          'SELECT student_id::text AS student_id, return_to_play_status FROM ath_injuries WHERE id = $1::uuid FOR UPDATE',
          injId,
        )) as Array<{ student_id: string; return_to_play_status: string }>;
        if (injRows.length === 0) {
          throw new NotFoundException('Parent injury row not found');
        }
        const inj = injRows[0]!;
        // Check protocol when injury is CONCUSSION_PROTOCOL
        if (inj.return_to_play_status === 'CONCUSSION_PROTOCOL') {
          const stepsCount = (await tx.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS c FROM ath_concussion_protocol_steps WHERE injury_id = $1::uuid AND completed_at IS NOT NULL AND symptom_free = true',
            injId,
          )) as Array<{ c: number }>;
          if ((stepsCount[0]?.c ?? 0) < 6) {
            // Mark clearance ACCEPTED but DO NOT flip injury — return early
            const rowsKept = (await tx.$queryRawUnsafe(
              SELECT_CLEARANCE + 'WHERE c.id = $1::uuid',
              id,
            )) as ClearanceRow[];
            return rowToDto(rowsKept[0]!);
          }
        }
        // Flip injury -> CLEARED + restore roster eligibility
        await tx.$executeRawUnsafe(
          "UPDATE ath_injuries SET return_to_play_status = 'CLEARED', cleared_at = now(), updated_at = now() WHERE id = $1::uuid",
          injId,
        );
        await tx.$executeRawUnsafe(
          "UPDATE ath_roster_members SET eligibility_status = 'ELIGIBLE', updated_at = now() " +
            "WHERE student_id = $1::uuid AND removed_at IS NULL AND eligibility_status = 'INJURED_NOT_CLEARED'",
          inj.student_id,
        );
      }

      const rows = (await tx.$queryRawUnsafe(
        SELECT_CLEARANCE + 'WHERE c.id = $1::uuid',
        id,
      )) as ClearanceRow[];
      return rowToDto(rows[0]!);
    });
  }
}
