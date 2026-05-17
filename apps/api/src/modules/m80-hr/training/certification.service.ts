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
import {
  CertificationStatus,
  CertificationTypeDto,
  CreateCertificationTypeDto,
  CreateEmployeeCertificationDto,
  EmployeeCertificationDto,
  RevokeEmployeeCertificationDto,
  UpdateCertificationTypeDto,
} from './dto/training.dto';

interface CertTypeRow {
  id: string;
  school_id: string;
  name: string;
  issuing_body: string | null;
  description: string | null;
  validity_months: number | null;
  is_required: boolean;
  is_active: boolean;
  created_at: string;
}

interface EmpCertRow {
  id: string;
  employee_id: string;
  employee_first: string | null;
  employee_last: string | null;
  certification_type_id: string;
  certification_type_name: string | null;
  school_id: string;
  issued_at: string;
  expires_at: string | null;
  document_s3_key: string | null;
  reference_number: string | null;
  status: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

const SELECT_CERT_TYPE =
  'SELECT id::text AS id, school_id::text AS school_id, name, issuing_body, description, ' +
  '       validity_months, is_required, is_active, created_at::text AS created_at ' +
  'FROM hr_certification_types ';

const SELECT_EMP_CERT_BASE =
  'SELECT c.id::text AS id, c.employee_id::text AS employee_id, ip.first_name AS employee_first, ' +
  '       ip.last_name AS employee_last, c.certification_type_id::text AS certification_type_id, ' +
  '       t.name AS certification_type_name, c.school_id::text AS school_id, ' +
  '       c.issued_at::text AS issued_at, c.expires_at::text AS expires_at, ' +
  '       c.document_s3_key, c.reference_number, c.status, ' +
  '       c.revoked_at::text AS revoked_at, c.revoked_reason, ' +
  '       c.created_at::text AS created_at ' +
  'FROM hr_employee_certifications c ' +
  'JOIN hr_certification_types t ON t.id = c.certification_type_id ' +
  'JOIN hr_employees emp ON emp.id = c.employee_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = emp.person_id ';

@Injectable()
export class CertificationTypeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(includeInactive: boolean): Promise<CertificationTypeDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = includeInactive
        ? 'WHERE school_id = $1::uuid'
        : 'WHERE school_id = $1::uuid AND is_active = true';
      const rows = (await client.$queryRawUnsafe(
        SELECT_CERT_TYPE + where + ' ORDER BY name',
        tenant.schoolId,
      )) as CertTypeRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(
    input: CreateCertificationTypeDto,
    actor: ResolvedActor,
  ): Promise<CertificationTypeDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_certification_types ' +
            '(id, school_id, name, issuing_body, description, validity_months, is_required) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.name,
          input.issuingBody ?? null,
          input.description ?? null,
          input.validityMonths ?? null,
          input.isRequired ?? false,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            `A certification type with name "${input.name}" already exists.`,
          );
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_CERT_TYPE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as CertTypeRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateCertificationTypeDto,
    actor: ResolvedActor,
  ): Promise<CertificationTypeDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_certification_types WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (lock.length === 0) throw new NotFoundException('Certification type not found');
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(`${col} = $${n}`);
        values.push(value);
        n += 1;
      };
      if (input.name !== undefined) push('name', input.name);
      if (input.issuingBody !== undefined) push('issuing_body', input.issuingBody);
      if (input.description !== undefined) push('description', input.description);
      if (input.validityMonths !== undefined) push('validity_months', input.validityMonths);
      if (input.isRequired !== undefined) push('is_required', input.isRequired);
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_CERT_TYPE + 'WHERE id = $1::uuid LIMIT 1',
          id,
        )) as CertTypeRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      try {
        await tx.$executeRawUnsafe(
          `UPDATE hr_certification_types SET ${sets.join(', ')} ` +
            `WHERE school_id = $${n}::uuid AND id = $${n + 1}::uuid`,
          ...values,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('A certification type with that name already exists.');
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_CERT_TYPE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as CertTypeRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-004:write',
      'hr-004:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Certification type administration requires hr-004:write or school admin.',
      );
    }
  }

  private rowToDto(r: CertTypeRow): CertificationTypeDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      issuingBody: r.issuing_body,
      description: r.description,
      validityMonths: r.validity_months,
      isRequired: r.is_required,
      isActive: r.is_active,
      createdAt: r.created_at,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (!e) return false;
    if (e.code === 'P2010' && e.meta?.code === '23505') return true;
    if (typeof e.message === 'string' && /unique/i.test(e.message)) return true;
    return false;
  }
}

@Injectable()
export class EmployeeCertificationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async listForEmployee(
    employeeId: string,
    actor: ResolvedActor,
  ): Promise<EmployeeCertificationDto[]> {
    if (actor.employeeId !== employeeId && !(await this.isAdmin(actor))) {
      throw new ForbiddenException(
        'You can only view your own certifications. Admin scope required for other employees.',
      );
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_EMP_CERT_BASE +
          'WHERE c.school_id = $1::uuid AND c.employee_id = $2::uuid ' +
          'ORDER BY c.issued_at DESC',
        tenant.schoolId,
        employeeId,
      )) as EmpCertRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  /** Admin dashboard — every active certification across the school
   * sorted by nearest expiry first. Used by the compliance overview. */
  async listExpiringSoon(
    daysAhead: number,
    actor: ResolvedActor,
  ): Promise<EmployeeCertificationDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_EMP_CERT_BASE +
          "WHERE c.school_id = $1::uuid AND c.status = 'ACTIVE' " +
          "  AND c.expires_at IS NOT NULL AND c.expires_at <= CURRENT_DATE + ($2::int * INTERVAL '1 day') " +
          'ORDER BY c.expires_at',
        tenant.schoolId,
        daysAhead,
      )) as EmpCertRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(
    input: CreateEmployeeCertificationDto,
    actor: ResolvedActor,
  ): Promise<EmployeeCertificationDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate employee + cert type are in this school.
      const empCheck = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.employeeId,
      )) as Array<{ id: string }>;
      if (empCheck.length === 0) {
        throw new BadRequestException('employeeId does not match an employee in this school.');
      }
      const typeCheck = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_certification_types ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid AND is_active = true LIMIT 1',
        tenant.schoolId,
        input.certificationTypeId,
      )) as Array<{ id: string }>;
      if (typeCheck.length === 0) {
        throw new BadRequestException(
          'certificationTypeId does not match an active certification type in this school.',
        );
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_employee_certifications ' +
          '(id, employee_id, certification_type_id, school_id, issued_at, expires_at, ' +
          ' document_s3_key, reference_number, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7, $8, 'ACTIVE')",
        id,
        input.employeeId,
        input.certificationTypeId,
        tenant.schoolId,
        input.issuedAt,
        input.expiresAt ?? null,
        input.documentS3Key ?? null,
        input.referenceNumber ?? null,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_EMP_CERT_BASE + 'WHERE c.id = $1::uuid LIMIT 1',
        id,
      )) as EmpCertRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async revoke(
    id: string,
    input: RevokeEmployeeCertificationDto,
    actor: ResolvedActor,
  ): Promise<EmployeeCertificationDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_employee_certifications ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Certification not found');
      if (lock[0]!.status === 'REVOKED') {
        throw new BadRequestException('This certification is already revoked.');
      }
      await tx.$executeRawUnsafe(
        'UPDATE hr_employee_certifications ' +
          "SET status = 'REVOKED', revoked_at = now(), revoked_reason = $1, updated_at = now() " +
          'WHERE id = $2::uuid',
        input.reason,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_EMP_CERT_BASE + 'WHERE c.id = $1::uuid LIMIT 1',
        id,
      )) as EmpCertRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (await this.isAdmin(actor)) return;
    throw new ForbiddenException(
      'Certification administration requires hr-004:write or school admin.',
    );
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-004:write',
      'hr-004:admin',
    ]);
  }

  private rowToDto(r: EmpCertRow): EmployeeCertificationDto {
    const name =
      r.employee_first || r.employee_last
        ? [r.employee_first, r.employee_last].filter(Boolean).join(' ')
        : null;
    let daysUntilExpiry: number | null = null;
    if (r.expires_at) {
      const expiry = new Date(r.expires_at + 'T00:00:00Z').getTime();
      const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
      daysUntilExpiry = Math.round((expiry - today) / (24 * 3600 * 1000));
    }
    return {
      id: r.id,
      employeeId: r.employee_id,
      employeeName: name,
      certificationTypeId: r.certification_type_id,
      certificationTypeName: r.certification_type_name,
      schoolId: r.school_id,
      issuedAt: r.issued_at,
      expiresAt: r.expires_at,
      documentS3Key: r.document_s3_key,
      referenceNumber: r.reference_number,
      status: r.status as CertificationStatus,
      revokedAt: r.revoked_at,
      revokedReason: r.revoked_reason,
      daysUntilExpiry,
      createdAt: r.created_at,
    };
  }
}
