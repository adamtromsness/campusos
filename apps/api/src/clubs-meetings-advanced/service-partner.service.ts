import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateServicePartnerOrgDto,
  ServicePartnerOrgResponseDto,
  UpdateServicePartnerOrgDto,
} from './dto/clubs-meetings-advanced.dto';

interface PartnerRow {
  id: string;
  school_id: string;
  org_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  service_types: string[];
  description: string | null;
  website_url: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const SELECT_PARTNER =
  'SELECT id::text AS id, school_id::text AS school_id, org_name, ' +
  'contact_name, contact_email, contact_phone, service_types, description, website_url, ' +
  'is_active, created_at, updated_at ' +
  'FROM ext_service_partner_orgs ';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23505' || e?.meta?.code === '23505' || /unique constraint/i.test(e?.message ?? '')
  );
}

/**
 * ServicePartnerService — P2-28b Step 4.
 *
 * Per-school catalogue of external service-learning partner
 * organisations. UNIQUE(school_id, org_name) caps the catalogue at
 * one row per name — duplicate POST raises a friendly 400. is_active
 * gates whether the org appears in the future student-volunteer
 * placement picker.
 *
 * Authorisation: CLB-003:read for reads; CLB-003:write for create
 * and patch. STUDENT and GUARDIAN refused.
 */
@Injectable()
export class ServicePartnerService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Service partner catalogue is staff-only');
    }
  }

  async list(
    actor: ResolvedActor,
    includeInactive = false,
  ): Promise<ServicePartnerOrgResponseDto[]> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      if (includeInactive) {
        return client.$queryRawUnsafe(
          SELECT_PARTNER + 'WHERE school_id = $1::uuid ORDER BY org_name ASC',
          tenant.schoolId,
        );
      }
      return client.$queryRawUnsafe(
        SELECT_PARTNER + 'WHERE school_id = $1::uuid AND is_active = true ORDER BY org_name ASC',
        tenant.schoolId,
      );
    })) as PartnerRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<ServicePartnerOrgResponseDto> {
    this.assertStaff(actor);
    return this.loadOrFail(id);
  }

  private async loadOrFail(id: string): Promise<ServicePartnerOrgResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PARTNER + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as PartnerRow[];
    if (rows.length === 0) throw new NotFoundException('Service partner not found');
    return this.rowToDto(rows[0]!);
  }

  async create(
    input: CreateServicePartnerOrgDto,
    actor: ResolvedActor,
  ): Promise<ServicePartnerOrgResponseDto> {
    this.assertStaff(actor);
    const id = generateId();
    const tenant = getCurrentTenant();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ext_service_partner_orgs ' +
            '(id, school_id, org_name, contact_name, contact_email, contact_phone, service_types, description, website_url) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8, $9)',
          id,
          tenant.schoolId,
          input.orgName,
          input.contactName ?? null,
          input.contactEmail ?? null,
          input.contactPhone ?? null,
          input.serviceTypes ?? [],
          input.description ?? null,
          input.websiteUrl ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A partner org with that name already exists for this school',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  async patch(
    id: string,
    input: UpdateServicePartnerOrgDto,
    actor: ResolvedActor,
  ): Promise<ServicePartnerOrgResponseDto> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.orgName !== undefined) {
      params.push(input.orgName);
      sets.push('org_name = $' + params.length);
    }
    if (input.contactName !== undefined) {
      params.push(input.contactName);
      sets.push('contact_name = $' + params.length);
    }
    if (input.contactEmail !== undefined) {
      params.push(input.contactEmail);
      sets.push('contact_email = $' + params.length);
    }
    if (input.contactPhone !== undefined) {
      params.push(input.contactPhone);
      sets.push('contact_phone = $' + params.length);
    }
    if (input.serviceTypes !== undefined) {
      params.push(input.serviceTypes);
      sets.push('service_types = $' + params.length + '::text[]');
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push('description = $' + params.length);
    }
    if (input.websiteUrl !== undefined) {
      params.push(input.websiteUrl);
      sets.push('website_url = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);
    params.push(tenant.schoolId);
    try {
      const result = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE ext_service_partner_orgs SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      })) as number;
      if (result === 0) throw new NotFoundException('Service partner not found');
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A partner org with that name already exists for this school',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  private rowToDto(r: PartnerRow): ServicePartnerOrgResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      orgName: r.org_name,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      serviceTypes: r.service_types ?? [],
      description: r.description,
      websiteUrl: r.website_url,
      isActive: r.is_active,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }
}
