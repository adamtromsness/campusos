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
import {
  CreateVehicleDocumentDto,
  CreateVehicleDto,
  DocumentType,
  UpdateVehicleDto,
  VehicleDocumentResponseDto,
  VehicleResponseDto,
  VehicleStatus,
  VehicleType,
} from './dto/transport.dto';

interface VehicleRow {
  id: string;
  school_id: string;
  registration: string;
  make: string | null;
  model: string | null;
  year: number | null;
  capacity: number;
  vehicle_type: string;
  status: string;
  doc_total: number;
  doc_current: number;
  doc_expiring_soon: number;
  doc_expired: number;
  created_at: Date;
}

const SELECT_VEHICLE_BASE =
  'SELECT v.id::text AS id, v.school_id::text AS school_id, v.registration, v.make, v.model, v.year, ' +
  'v.capacity, v.vehicle_type, v.status, ' +
  '(SELECT COUNT(*)::int FROM trn_vehicle_documents d WHERE d.vehicle_id = v.id AND d.is_current = true) AS doc_total, ' +
  '(SELECT COUNT(*)::int FROM trn_vehicle_documents d WHERE d.vehicle_id = v.id AND d.is_current = true AND d.expiry_date - CURRENT_DATE > 30) AS doc_current, ' +
  '(SELECT COUNT(*)::int FROM trn_vehicle_documents d WHERE d.vehicle_id = v.id AND d.is_current = true AND d.expiry_date - CURRENT_DATE BETWEEN 0 AND 30) AS doc_expiring_soon, ' +
  '(SELECT COUNT(*)::int FROM trn_vehicle_documents d WHERE d.vehicle_id = v.id AND d.is_current = true AND d.expiry_date < CURRENT_DATE) AS doc_expired, ' +
  'v.created_at ' +
  'FROM trn_vehicles v ';

function rowToDto(r: VehicleRow): VehicleResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    registration: r.registration,
    make: r.make,
    model: r.model,
    year: r.year,
    capacity: r.capacity,
    vehicleType: r.vehicle_type as VehicleType,
    status: r.status as VehicleStatus,
    documentSummary: {
      total: r.doc_total,
      current: r.doc_current,
      expiringSoon: r.doc_expiring_soon,
      expired: r.doc_expired,
    },
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class VehicleService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException('Only school admins or transportation staff can manage vehicles');
  }

  async list(
    actor: ResolvedActor,
    args: { status?: VehicleStatus },
  ): Promise<VehicleResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['v.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      where.push('v.status = $' + (params.length + 1));
      params.push(args.status);
    } else if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      where.push("v.status <> 'RETIRED'");
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_VEHICLE_BASE + 'WHERE ' + where.join(' AND ') + ' ORDER BY v.registration LIMIT 200',
        ...params,
      );
    })) as VehicleRow[];
    return rows.map(rowToDto);
  }

  async getById(vehicleId: string): Promise<VehicleResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_VEHICLE_BASE + 'WHERE v.id = $1::uuid LIMIT 1',
        vehicleId,
      );
    })) as VehicleRow[];
    if (rows.length === 0) throw new NotFoundException('Vehicle not found');
    return rowToDto(rows[0]!);
  }

  async create(input: CreateVehicleDto, actor: ResolvedActor): Promise<VehicleResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_vehicles (id, school_id, registration, make, model, year, capacity, vehicle_type, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'ACTIVE')",
          id,
          tenant.schoolId,
          input.registration,
          input.make ?? null,
          input.model ?? null,
          input.year ?? null,
          input.capacity,
          input.vehicleType,
        );
      });
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { code?: string }; message?: string };
      if (
        e.code === '23505' ||
        e.meta?.code === '23505' ||
        (typeof e.message === 'string' && e.message.includes('23505'))
      ) {
        throw new BadRequestException(
          'A vehicle with this registration already exists for this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    vehicleId: string,
    input: UpdateVehicleDto,
    actor: ResolvedActor,
  ): Promise<VehicleResponseDto> {
    this.assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.make !== undefined) {
      sets.push('make = $' + (params.length + 1));
      params.push(input.make);
    }
    if (input.model !== undefined) {
      sets.push('model = $' + (params.length + 1));
      params.push(input.model);
    }
    if (input.year !== undefined) {
      sets.push('year = $' + (params.length + 1));
      params.push(input.year);
    }
    if (input.capacity !== undefined) {
      sets.push('capacity = $' + (params.length + 1));
      params.push(input.capacity);
    }
    if (input.status !== undefined) {
      sets.push('status = $' + (params.length + 1));
      params.push(input.status);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(vehicleId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE trn_vehicles SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
          ...params,
        );
      });
    }
    return this.getById(vehicleId);
  }

  // ── Documents ──
  async listDocuments(vehicleId: string): Promise<VehicleDocumentResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, vehicle_id::text AS vehicle_id, document_type, document_number, s3_key, ' +
          'issued_date, expiry_date, is_current, ' +
          'GREATEST(0, expiry_date - CURRENT_DATE) AS days_until_expiry ' +
          'FROM trn_vehicle_documents WHERE vehicle_id = $1::uuid ORDER BY expiry_date',
        vehicleId,
      );
    })) as Array<{
      id: string;
      vehicle_id: string;
      document_type: string;
      document_number: string | null;
      s3_key: string | null;
      issued_date: Date | null;
      expiry_date: Date;
      is_current: boolean;
      days_until_expiry: number;
    }>;
    return rows.map((r) => {
      const days = Math.floor(
        (r.expiry_date.getTime() - new Date().setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24),
      );
      let status: 'CURRENT' | 'EXPIRING_SOON' | 'EXPIRED';
      if (days < 0) status = 'EXPIRED';
      else if (days <= 30) status = 'EXPIRING_SOON';
      else status = 'CURRENT';
      return {
        id: r.id,
        vehicleId: r.vehicle_id,
        documentType: r.document_type as DocumentType,
        documentNumber: r.document_number,
        s3Key: r.s3_key,
        issuedDate: r.issued_date ? r.issued_date.toISOString().slice(0, 10) : null,
        expiryDate: r.expiry_date.toISOString().slice(0, 10),
        isCurrent: r.is_current,
        expiryStatus: status,
        daysUntilExpiry: Math.max(0, days),
      };
    });
  }

  async addDocument(
    vehicleId: string,
    input: CreateVehicleDocumentDto,
    actor: ResolvedActor,
  ): Promise<VehicleDocumentResponseDto> {
    this.assertCanManage(actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Mark older same-type documents as not current
      await tx.$executeRawUnsafe(
        'UPDATE trn_vehicle_documents SET is_current = false WHERE vehicle_id = $1::uuid AND document_type = $2 AND is_current = true',
        vehicleId,
        input.documentType,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO trn_vehicle_documents (id, vehicle_id, document_type, document_number, s3_key, issued_date, expiry_date, is_current, uploaded_by, uploaded_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, true, $8::uuid, now())',
        id,
        vehicleId,
        input.documentType,
        input.documentNumber ?? null,
        input.s3Key ?? null,
        input.issuedDate ?? null,
        input.expiryDate,
        actor.accountId,
      );
    });
    const docs = await this.listDocuments(vehicleId);
    const found = docs.find((d) => d.id === id);
    if (!found) throw new NotFoundException('Document not found after insert');
    return found;
  }
}
