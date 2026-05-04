import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { CreateVendorDto, UpdateVendorDto, VendorResponseDto, VendorType } from './dto/ticket.dto';

interface VendorRow {
  id: string;
  school_id: string;
  vendor_name: string;
  vendor_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  is_preferred: boolean;
  notes: string | null;
  is_active: boolean;
}

const SELECT_VENDOR_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, vendor_name, vendor_type, ' +
  'contact_name, contact_email, contact_phone, website, is_preferred, notes, is_active ' +
  'FROM tkt_vendors ';

function rowToDto(r: VendorRow): VendorResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    vendorName: r.vendor_name,
    vendorType: r.vendor_type as VendorType,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    website: r.website,
    isPreferred: r.is_preferred,
    notes: r.notes,
    isActive: r.is_active,
  };
}

@Injectable()
export class VendorService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * List vendors. Sorts preferred-first then alphabetical so the Step 8
   * admin assignment dropdown shows the school's go-to vendors at the top.
   * Admins can flip includeInactive=true to see deactivated vendors.
   */
  async list(includeInactive: boolean): Promise<VendorResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<VendorRow[]>(
        SELECT_VENDOR_BASE +
          (includeInactive ? '' : 'WHERE is_active = true ') +
          'ORDER BY is_preferred DESC, vendor_name',
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<VendorResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<VendorRow[]>(SELECT_VENDOR_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Vendor ' + id);
    return rowToDto(rows[0]!);
  }

  async create(input: CreateVendorDto): Promise<VendorResponseDto> {
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO tkt_vendors (id, school_id, vendor_name, vendor_type, contact_name, contact_email, contact_phone, website, is_preferred, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)',
          id,
          tenant.schoolId,
          input.vendorName,
          input.vendorType,
          input.contactName ?? null,
          input.contactEmail ?? null,
          input.contactPhone ?? null,
          input.website ?? null,
          input.isPreferred ?? false,
          input.notes ?? null,
        );
      } catch (err) {
        const e = err as { meta?: { code?: string }; code?: string };
        if (e?.meta?.code === '23505' || e?.code === '23505') {
          throw new BadRequestException('Vendor name already exists: ' + input.vendorName);
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  async update(id: string, input: UpdateVendorDto): Promise<VendorResponseDto> {
    await this.getById(id); // 404 guard
    if (Object.keys(input).length === 0) return this.getById(id);
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    function pushNullable(column: string, value: string | null | undefined): void {
      if (value === undefined) return;
      if (value === null) sets.push(column + ' = NULL');
      else {
        sets.push(column + ' = $' + idx);
        params.push(value);
        idx++;
      }
    }

    if (input.vendorName !== undefined) {
      sets.push('vendor_name = $' + idx);
      params.push(input.vendorName);
      idx++;
    }
    if (input.vendorType !== undefined) {
      sets.push('vendor_type = $' + idx);
      params.push(input.vendorType);
      idx++;
    }
    pushNullable('contact_name', input.contactName);
    pushNullable('contact_email', input.contactEmail);
    pushNullable('contact_phone', input.contactPhone);
    pushNullable('website', input.website);
    pushNullable('notes', input.notes);
    if (input.isPreferred !== undefined) {
      sets.push('is_preferred = $' + idx);
      params.push(input.isPreferred);
      idx++;
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    sets.push('updated_at = now()');

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'UPDATE tkt_vendors SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
          ...params,
          id,
        );
      } catch (err) {
        const e = err as { meta?: { code?: string }; code?: string };
        if (e?.meta?.code === '23505' || e?.code === '23505') {
          throw new BadRequestException('Vendor name already exists: ' + input.vendorName);
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  /**
   * Internal helper used by TicketService.assignVendor to validate the
   * vendor exists, is active, and belongs to the current tenant.
   */
  async assertActive(id: string): Promise<{ id: string; vendorName: string }> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string; vendor_name: string; is_active: boolean }>>(
        'SELECT id::text AS id, vendor_name, is_active FROM tkt_vendors WHERE id = $1::uuid LIMIT 1',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Vendor ' + id);
    if (!rows[0]!.is_active) {
      throw new BadRequestException('Vendor is deactivated: ' + rows[0]!.vendor_name);
    }
    return { id: rows[0]!.id, vendorName: rows[0]!.vendor_name };
  }
}
