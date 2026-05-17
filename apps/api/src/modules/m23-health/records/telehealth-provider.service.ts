import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CreateTelehealthProviderDto,
  TelehealthProviderDto,
  UpdateTelehealthProviderDto,
} from './dto/health-advanced.dto';

interface ProviderRow {
  id: string;
  school_id: string | null;
  provider_name: string;
  speciality: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  booking_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_PROVIDER_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, provider_name, speciality, ' +
  '       contact_email, contact_phone, booking_url, is_active, ' +
  '       created_at::text AS created_at, updated_at::text AS updated_at ' +
  'FROM hlth_telehealth_providers ';

@Injectable()
export class TelehealthProviderService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(includeInactive = false): Promise<TelehealthProviderDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = includeInactive
        ? 'WHERE school_id = $1::uuid'
        : 'WHERE school_id = $1::uuid AND is_active = true';
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROVIDER_BASE + where + ' ORDER BY provider_name',
        tenant.schoolId,
      )) as ProviderRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<TelehealthProviderDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROVIDER_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ProviderRow[];
      if (rows.length === 0) throw new NotFoundException('Provider not found');
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Resolve a provider record without surfacing the row scope to the
   * caller — used by TelehealthSessionService when scheduling so the
   * service can verify the provider belongs to this school AND is
   * active before INSERTing the session row. Returns null when the id
   * doesn't match this school.
   */
  async loadActiveOrFail(providerId: string): Promise<ProviderRow> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROVIDER_BASE +
          'WHERE school_id = $1::uuid AND id = $2::uuid AND is_active = true LIMIT 1',
        tenant.schoolId,
        providerId,
      )) as ProviderRow[];
      if (rows.length === 0) {
        throw new BadRequestException('Telehealth provider not found in this school or inactive');
      }
      return rows[0]!;
    });
  }

  async create(
    input: CreateTelehealthProviderDto,
    actor: ResolvedActor,
  ): Promise<TelehealthProviderDto> {
    await this.assertHealthScope(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_telehealth_providers ' +
          '(id, school_id, provider_name, speciality, contact_email, contact_phone, booking_url) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
        id,
        tenant.schoolId,
        input.providerName,
        input.speciality ?? null,
        input.contactEmail ?? null,
        input.contactPhone ?? null,
        input.bookingUrl ?? null,
      );
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROVIDER_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as ProviderRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateTelehealthProviderDto,
    actor: ResolvedActor,
  ): Promise<TelehealthProviderDto> {
    await this.assertHealthScope(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id FROM hlth_telehealth_providers ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (lock.length === 0) throw new NotFoundException('Provider not found');

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.providerName !== undefined) push('provider_name', input.providerName);
      if (input.speciality !== undefined) push('speciality', input.speciality);
      if (input.contactEmail !== undefined) push('contact_email', input.contactEmail);
      if (input.contactPhone !== undefined) push('contact_phone', input.contactPhone);
      if (input.bookingUrl !== undefined) push('booking_url', input.bookingUrl);
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_PROVIDER_BASE + 'WHERE id = $1::uuid LIMIT 1',
          id,
        )) as ProviderRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        'UPDATE hlth_telehealth_providers SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          n +
          '::uuid AND id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_PROVIDER_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as ProviderRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertHealthScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hlt-006:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Telehealth provider management requires hlt-006:write or school admin.',
      );
    }
  }

  private rowToDto(r: ProviderRow): TelehealthProviderDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      providerName: r.provider_name,
      speciality: r.speciality,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      bookingUrl: r.booking_url,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
