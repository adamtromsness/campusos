import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CertificationResponseDto,
  CreateCertificationDto,
  VerifyCertificationDto,
} from './dto/certification.dto';

interface CertificationRow {
  id: string;
  employee_id: string;
  certification_type: string;
  certification_name: string;
  issuing_body: string | null;
  reference_number: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  verification_status: string;
  verified_by: string | null;
  verified_at: string | null;
  document_s3_key: string | null;
  notes: string | null;
}

function rowToDto(row: CertificationRow, todayIso: string): CertificationResponseDto {
  var daysUntilExpiry: number | null = null;
  if (row.expiry_date) {
    var diffMs = new Date(row.expiry_date).getTime() - new Date(todayIso).getTime();
    daysUntilExpiry = Math.round(diffMs / (24 * 60 * 60 * 1000));
  }
  return {
    id: row.id,
    employeeId: row.employee_id,
    certificationType: row.certification_type as CertificationResponseDto['certificationType'],
    certificationName: row.certification_name,
    issuingBody: row.issuing_body,
    referenceNumber: row.reference_number,
    issuedDate: row.issued_date,
    expiryDate: row.expiry_date,
    verificationStatus: row.verification_status as CertificationResponseDto['verificationStatus'],
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    documentS3Key: row.document_s3_key,
    notes: row.notes,
    daysUntilExpiry: daysUntilExpiry,
  };
}

var SELECT_CERT_BASE =
  'SELECT id, employee_id, certification_type, certification_name, issuing_body, reference_number, ' +
  "TO_CHAR(issued_date, 'YYYY-MM-DD') AS issued_date, " +
  "TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date, " +
  'verification_status, verified_by, ' +
  "TO_CHAR(verified_at, 'YYYY-MM-DD') AS verified_at, " +
  'document_s3_key, notes ' +
  'FROM hr_staff_certifications ';

@Injectable()
export class CertificationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Per-employee certification list. Visibility:
   *   - Admin can read any employee's certs.
   *   - Owning employee can read their own.
   *   - Anyone else gets 403.
   */
  async listForEmployee(
    employeeId: string,
    actor: ResolvedActor,
  ): Promise<CertificationResponseDto[]> {
    this.assertCanAccess(employeeId, actor);
    var todayIso = new Date().toISOString().slice(0, 10);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CertificationRow[]>(
        SELECT_CERT_BASE +
          'WHERE employee_id = $1::uuid ORDER BY expiry_date NULLS LAST, certification_name',
        employeeId,
      );
    });
    return rows.map(function (r) {
      return rowToDto(r, todayIso);
    });
  }

  async create(
    employeeId: string,
    body: CreateCertificationDto,
    actor: ResolvedActor,
  ): Promise<CertificationResponseDto> {
    this.assertCanAccess(employeeId, actor);
    var employeeRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM hr_employees WHERE id = $1::uuid',
        employeeId,
      );
    });
    if (employeeRows.length === 0) {
      throw new NotFoundException('Employee ' + employeeId + ' not found');
    }
    var certId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hr_staff_certifications ' +
          '(id, employee_id, certification_type, certification_name, issuing_body, reference_number, issued_date, expiry_date, document_s3_key, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9, $10)',
        certId,
        employeeId,
        body.certificationType,
        body.certificationName,
        body.issuingBody ?? null,
        body.referenceNumber ?? null,
        body.issuedDate ?? null,
        body.expiryDate ?? null,
        body.documentS3Key ?? null,
        body.notes ?? null,
      );
    });
    return this.getById(certId, actor);
  }

  /**
   * Admin-only verify endpoint. Flips `verification_status` and stamps
   * `verified_by` / `verified_at`. Emits `hr.certification.verified`.
   */
  async verify(
    certId: string,
    body: VerifyCertificationDto,
    actor: ResolvedActor,
  ): Promise<CertificationResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can verify certifications');
    }
    var todayIso = new Date().toISOString().slice(0, 10);
    var existing = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CertificationRow[]>(
        SELECT_CERT_BASE + 'WHERE id = $1::uuid',
        certId,
      );
    });
    if (existing.length === 0) throw new NotFoundException('Certification ' + certId + ' not found');
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE hr_staff_certifications SET verification_status = $1, verified_by = $2::uuid, verified_at = now(), notes = COALESCE($3, notes), updated_at = now() ' +
          'WHERE id = $4::uuid',
        body.status,
        actor.accountId,
        body.notes ?? null,
        certId,
      );
    });
    var dto = await this.getById(certId, actor);
    void this.kafka.emit({
      topic: 'hr.certification.verified',
      key: certId,
      sourceModule: 'hr',
      payload: {
        certificationId: certId,
        employeeId: dto.employeeId,
        certificationType: dto.certificationType,
        certificationName: dto.certificationName,
        verificationStatus: dto.verificationStatus,
        verifiedBy: actor.accountId,
        verifiedAt: dto.verifiedAt,
      },
    });
    return dto;
    void todayIso;
  }

  async getById(certId: string, actor: ResolvedActor): Promise<CertificationResponseDto> {
    var todayIso = new Date().toISOString().slice(0, 10);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CertificationRow[]>(
        SELECT_CERT_BASE + 'WHERE id = $1::uuid',
        certId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Certification ' + certId + ' not found');
    var row = rows[0]!;
    this.assertCanAccess(row.employee_id, actor);
    return rowToDto(row, todayIso);
  }

  /**
   * Sweep certifications that hit a 90 / 30 / 7-day pre-expiry window or
   * are now overdue. Returns the affected rows so the caller (or a future
   * scheduled task) can emit `hr.certification.expiring` per row.
   *
   * The query is intentionally scoped to PENDING + VERIFIED — already
   * EXPIRED / REVOKED rows are not re-alerted.
   */
  async listExpiringSoon(): Promise<CertificationResponseDto[]> {
    var todayIso = new Date().toISOString().slice(0, 10);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CertificationRow[]>(
        SELECT_CERT_BASE +
          "WHERE verification_status IN ('PENDING','VERIFIED') " +
          "AND expiry_date IS NOT NULL " +
          "AND expiry_date <= (now() + INTERVAL '90 days')::date " +
          'ORDER BY expiry_date',
      );
    });
    return rows.map(function (r) {
      return rowToDto(r, todayIso);
    });
  }

  private assertCanAccess(employeeId: string, actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.employeeId === employeeId) return;
    throw new ForbiddenException(
      'Only the owning employee or a school admin can access this employee certification set',
    );
  }
}
