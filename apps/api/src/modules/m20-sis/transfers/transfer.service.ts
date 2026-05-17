import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  TRANSFER_DIRECTIONS,
  type CreateTransferRecordDto,
  type PatchTransferRecordDto,
  type TransferDirection,
  type TransferRecordDto,
} from '../transcripts/dto/sis-transcripts.dto';

interface TransferRow {
  id: string;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  transfer_direction: string;
  other_school_name: string;
  other_school_country: string | null;
  other_school_contact: string | null;
  transfer_date: string;
  records_received: boolean;
  records_sent: boolean;
  records_package_s3_key: string | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

/**
 * Transfer Service — incoming/outgoing transfer records under STU-004.
 *
 * Schema enforces direction shape — INCOMING carries records_received,
 * OUTGOING carries records_sent. Service-layer patches reject any update
 * that would violate that invariant.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: TransferRow): TransferRecordDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName:
        r.student_first_name && r.student_last_name
          ? `${r.student_first_name} ${r.student_last_name}`
          : null,
      transferDirection: r.transfer_direction as TransferDirection,
      otherSchoolName: r.other_school_name,
      otherSchoolCountry: r.other_school_country,
      otherSchoolContact: r.other_school_contact,
      transferDate: r.transfer_date,
      recordsReceived: r.records_received,
      recordsSent: r.records_sent,
      recordsPackageS3Key: r.records_package_s3_key,
      notes: r.notes,
      recordedBy: r.recorded_by,
      createdAt: r.created_at,
    };
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:write',
      'stu-004:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only staff or admins can manage transfer records.');
    }
  }

  private async assertStudentInTenant(studentId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }
  }

  /**
   * REVIEW-P2C13 BLOCKING 8 — SELECT base now joins sis_students with
   * an inner join so the school predicate can be pushed down. Every
   * read endpoint binds `s.school_id = tenant.schoolId`.
   */
  private buildSelectBase(): string {
    return (
      'SELECT t.id::text, t.student_id::text, ' +
      'ip.first_name AS student_first_name, ip.last_name AS student_last_name, ' +
      't.transfer_direction, t.other_school_name, t.other_school_country, t.other_school_contact, ' +
      't.transfer_date::text, t.records_received, t.records_sent, t.records_package_s3_key, ' +
      't.notes, t.recorded_by::text, t.created_at::text ' +
      'FROM sis_transfer_records t ' +
      'JOIN sis_students s ON s.id = t.student_id ' +
      'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'LEFT JOIN platform.iam_person ip ON ip.id = ps.person_id '
    );
  }

  async listForStudent(studentId: string, actor: ResolvedActor): Promise<TransferRecordDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TransferRow[]>(
        this.buildSelectBase() +
          'WHERE t.student_id = $1::uuid AND s.school_id = $2::uuid ORDER BY t.transfer_date DESC',
        studentId,
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async list(
    args: { direction?: string; fromDate?: string; toDate?: string },
    actor: ResolvedActor,
  ): Promise<TransferRecordDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const conditions: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    let next = 2;
    if (args.direction) {
      if (!TRANSFER_DIRECTIONS.includes(args.direction as TransferDirection)) {
        throw new BadRequestException(`direction must be one of ${TRANSFER_DIRECTIONS.join(', ')}`);
      }
      conditions.push(`t.transfer_direction = $${next}`);
      params.push(args.direction);
      next += 1;
    }
    if (args.fromDate) {
      conditions.push(`t.transfer_date >= $${next}::date`);
      params.push(args.fromDate);
      next += 1;
    }
    if (args.toDate) {
      conditions.push(`t.transfer_date <= $${next}::date`);
      params.push(args.toDate);
      next += 1;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TransferRow[]>(
        this.buildSelectBase() +
          'WHERE ' +
          conditions.join(' AND ') +
          ' ORDER BY t.transfer_date DESC LIMIT 200',
        ...params,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<TransferRecordDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TransferRow[]>(
        this.buildSelectBase() + 'WHERE t.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Transfer record not found');
    return this.rowToDto(rows[0]!);
  }

  async create(dto: CreateTransferRecordDto, actor: ResolvedActor): Promise<TransferRecordDto> {
    await this.assertAdmin(actor);
    if (!TRANSFER_DIRECTIONS.includes(dto.transferDirection)) {
      throw new BadRequestException(
        `transferDirection must be one of ${TRANSFER_DIRECTIONS.join(', ')}`,
      );
    }
    await this.assertStudentInTenant(dto.studentId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'INSERT INTO sis_transfer_records (id, student_id, transfer_direction, other_school_name, ' +
          'other_school_country, other_school_contact, transfer_date, recorded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::uuid)',
        id,
        dto.studentId,
        dto.transferDirection,
        dto.otherSchoolName,
        dto.otherSchoolCountry ?? null,
        dto.otherSchoolContact ?? null,
        dto.transferDate,
        actor.personId,
      ),
    );
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    dto: PatchTransferRecordDto,
    actor: ResolvedActor,
  ): Promise<TransferRecordDto> {
    await this.assertAdmin(actor);

    const tenant = getCurrentTenant();
    // REVIEW-P2C13 BLOCKING 8 — lock joins through sis_students with
    // the school predicate so a registrar in school A cannot mark a
    // School B transfer record as received/sent by guessing the UUID.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          transfer_direction: string;
          records_received: boolean;
          records_sent: boolean;
        }>
      >(
        'SELECT t.transfer_direction, t.records_received, t.records_sent ' +
          'FROM sis_transfer_records t ' +
          'JOIN sis_students s ON s.id = t.student_id ' +
          'WHERE t.id = $1::uuid AND s.school_id = $2::uuid FOR UPDATE OF t',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Transfer record not found');
      const row = rows[0]!;
      const direction = row.transfer_direction as TransferDirection;

      if (direction === 'INCOMING' && dto.recordsSent === true) {
        throw new BadRequestException(
          'INCOMING transfers cannot have recordsSent=true. Use recordsReceived to mark the package arrived.',
        );
      }
      if (direction === 'OUTGOING' && dto.recordsReceived === true) {
        throw new BadRequestException(
          'OUTGOING transfers cannot have recordsReceived=true. Use recordsSent to mark the package mailed.',
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      let next = 1;
      if (dto.recordsReceived !== undefined) {
        sets.push(`records_received = $${next}`);
        params.push(dto.recordsReceived);
        next += 1;
      }
      if (dto.recordsSent !== undefined) {
        sets.push(`records_sent = $${next}`);
        params.push(dto.recordsSent);
        next += 1;
      }
      if (dto.recordsPackageS3Key !== undefined) {
        sets.push(`records_package_s3_key = $${next}`);
        params.push(dto.recordsPackageS3Key);
        next += 1;
      }
      if (dto.notes !== undefined) {
        sets.push(`notes = $${next}`);
        params.push(dto.notes);
        next += 1;
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        `UPDATE sis_transfer_records SET ${sets.join(', ')} WHERE id = $${next}::uuid`,
        ...params,
      );
    });
    return this.getById(id, actor);
  }
}
