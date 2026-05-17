import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateDriverCredentialDto,
  CredentialStatus,
  CredentialType,
  DriverCredentialResponseDto,
  DriverResponseDto,
  UpdateDriverCredentialDto,
} from './dto/transport.dto';

interface CredentialRow {
  id: string;
  driver_id: string;
  credential_type: string;
  credential_number: string | null;
  issued_date: Date;
  expiry_date: Date;
  s3_key: string | null;
  status: string;
  verified_by: string | null;
  verified_at: Date | null;
}

function rowToDto(r: CredentialRow): DriverCredentialResponseDto {
  const days = Math.floor(
    (r.expiry_date.getTime() - new Date().setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24),
  );
  let status: CredentialStatus;
  if (days < 0) status = 'EXPIRED';
  else if (days <= 30) status = 'EXPIRING_SOON';
  else status = 'VALID';
  return {
    id: r.id,
    driverId: r.driver_id,
    credentialType: r.credential_type as CredentialType,
    credentialNumber: r.credential_number,
    issuedDate: r.issued_date.toISOString().slice(0, 10),
    expiryDate: r.expiry_date.toISOString().slice(0, 10),
    s3Key: r.s3_key,
    status,
    daysUntilExpiry: Math.max(0, days),
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
  };
}

@Injectable()
export class DriverCredentialService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage driver credentials',
    );
  }

  async listDrivers(actor: ResolvedActor): Promise<DriverResponseDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only admins or staff can list drivers');
    }
    // A "driver" is anyone with at least one row in trn_driver_credentials.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT DISTINCT he.id::text AS id, ' +
          "(ip.first_name || ' ' || ip.last_name) AS name " +
          'FROM trn_driver_credentials c ' +
          'JOIN hr_employees he ON he.id = c.driver_id ' +
          'JOIN platform.iam_person ip ON ip.id = he.person_id ' +
          'ORDER BY name',
      );
    })) as Array<{ id: string; name: string }>;

    const drivers: DriverResponseDto[] = [];
    for (const r of rows) {
      const creds = await this.listForDriver(r.id);
      drivers.push({ id: r.id, name: r.name, credentials: creds });
    }
    return drivers;
  }

  async listForDriver(driverId: string): Promise<DriverCredentialResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, driver_id::text AS driver_id, credential_type, credential_number, ' +
          'issued_date, expiry_date, s3_key, status, ' +
          'verified_by::text AS verified_by, verified_at ' +
          'FROM trn_driver_credentials WHERE driver_id = $1::uuid ORDER BY credential_type',
        driverId,
      );
    })) as CredentialRow[];
    return rows.map(rowToDto);
  }

  async create(
    driverId: string,
    input: CreateDriverCredentialDto,
    actor: ResolvedActor,
  ): Promise<DriverCredentialResponseDto> {
    this.assertCanManage(actor);

    // Verify driver_id refers to an hr_employees row in this tenant
    const empCheck = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        driverId,
      );
    })) as Array<{ ok: number }>;
    if (empCheck.length === 0) {
      throw new BadRequestException('driverId does not match an employee in this school');
    }

    const status = computeStatus(input.expiryDate);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_driver_credentials (id, driver_id, credential_type, credential_number, issued_date, expiry_date, s3_key, status) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::date, $7, $8)',
          id,
          driverId,
          input.credentialType,
          input.credentialNumber ?? null,
          input.issuedDate,
          input.expiryDate,
          input.s3Key ?? null,
          status,
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
          'Driver already has a credential of this type. Update the existing row via PATCH.',
        );
      }
      throw err;
    }
    const creds = await this.listForDriver(driverId);
    const found = creds.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Credential not found after insert');
    return found;
  }

  async patch(
    credentialId: string,
    input: UpdateDriverCredentialDto,
    actor: ResolvedActor,
  ): Promise<DriverCredentialResponseDto> {
    this.assertCanManage(actor);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.credentialNumber !== undefined) {
      sets.push('credential_number = $' + (params.length + 1));
      params.push(input.credentialNumber);
    }
    if (input.issuedDate !== undefined) {
      sets.push('issued_date = $' + (params.length + 1) + '::date');
      params.push(input.issuedDate);
    }
    if (input.expiryDate !== undefined) {
      sets.push('expiry_date = $' + (params.length + 1) + '::date');
      params.push(input.expiryDate);
      sets.push('status = $' + (params.length + 1));
      params.push(computeStatus(input.expiryDate));
    }
    if (input.s3Key !== undefined) {
      sets.push('s3_key = $' + (params.length + 1));
      params.push(input.s3Key);
    }
    if (input.verify) {
      sets.push('verified_by = $' + (params.length + 1) + '::uuid');
      params.push(actor.accountId);
      sets.push('verified_at = now()');
    }
    if (sets.length === 0) {
      const all = await this.listAll(credentialId);
      return all;
    }
    sets.push('updated_at = now()');
    params.push(credentialId);

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE trn_driver_credentials SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    return this.listAll(credentialId);
  }

  /**
   * Convenience: refresh status field across all credentials whose
   * computed status no longer matches their stored status. Used by
   * the driver credentials dashboard read path.
   */
  async refreshAllStatuses(): Promise<number> {
    const rowsUpdated = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'UPDATE trn_driver_credentials SET status = CASE ' +
          "  WHEN expiry_date < CURRENT_DATE THEN 'EXPIRED' " +
          "  WHEN expiry_date - CURRENT_DATE <= 30 THEN 'EXPIRING_SOON' " +
          "  ELSE 'VALID' END " +
          'WHERE status <> CASE ' +
          "  WHEN expiry_date < CURRENT_DATE THEN 'EXPIRED' " +
          "  WHEN expiry_date - CURRENT_DATE <= 30 THEN 'EXPIRING_SOON' " +
          "  ELSE 'VALID' END " +
          'RETURNING 1 AS ok',
      )) as Array<{ ok: number }>;
      return r.length;
    })) as number;
    return rowsUpdated;
  }

  async listAll(credentialId: string): Promise<DriverCredentialResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, driver_id::text AS driver_id, credential_type, credential_number, ' +
          'issued_date, expiry_date, s3_key, status, ' +
          'verified_by::text AS verified_by, verified_at ' +
          'FROM trn_driver_credentials WHERE id = $1::uuid LIMIT 1',
        credentialId,
      );
    })) as CredentialRow[];
    if (rows.length === 0) throw new NotFoundException('Credential not found');
    return rowToDto(rows[0]!);
  }
}

function computeStatus(expiryDateIso: string): CredentialStatus {
  const expiry = new Date(expiryDateIso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) return 'EXPIRED';
  if (days <= 30) return 'EXPIRING_SOON';
  return 'VALID';
}
