import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { assertAccountInCurrentTenant, isUniqueViolation } from './assets.service';
import type {
  AccessTier,
  AssignLicenceDto,
  CreateCredentialDto,
  CreateLicenceDto,
  CredentialAccessLogDto,
  CredentialAccessType,
  CredentialDetailDto,
  CredentialSummaryDto,
  LicenceAssignmentDto,
  LicenceDto,
  UpdateCredentialDto,
  UpdateLicenceDto,
} from './dto/it.dto';

const TIER_RANK: Record<AccessTier, number> = {
  STANDARD: 0,
  ELEVATED: 1,
  CRITICAL: 2,
};

function tierRank(t: AccessTier): number {
  return TIER_RANK[t];
}

/**
 * Vault encryption helpers (AES-256-GCM via Node crypto).
 *
 * The seed key is derived from process.env.IT_VAULT_KEY. In
 * development and test we fall back to a deterministic seed
 * string so the seeded ciphertext decrypts cleanly through the
 * same module. Production environments MUST set IT_VAULT_KEY
 * (a separate key from the student-data key per ADR-065) — the
 * REVIEW-CYCLE22 BLOCKING 5 fail-closed check throws at module
 * load time when NODE_ENV=production and the env var is missing.
 *
 * Wire format: base64(iv).base64(authTag).base64(ciphertext).
 * 12-byte iv is recommended for GCM. The auth tag is 16 bytes.
 */
const NODE_ENV = process.env.NODE_ENV || 'development';
if (NODE_ENV === 'production' && !process.env.IT_VAULT_KEY) {
  throw new Error(
    'IT_VAULT_KEY is required in production — falling back to a deterministic seed key would defeat ADR-065.',
  );
}
const KEY_MATERIAL = process.env.IT_VAULT_KEY || 'campusos-demo-vault-seed-key-2026';
const KEY_SALT = 'campusos-demo-salt';

function deriveKey(): Buffer {
  return scryptSync(KEY_MATERIAL, KEY_SALT, 32);
}

function encryptPassword(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decryptPassword(wire: string): string {
  const parts = wire.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid vault ciphertext format');
  }
  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const enc = Buffer.from(parts[2]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

async function assertItAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  scope: 'IT-004' | 'IT-005' = 'IT-004',
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  if (actor.personType !== 'STAFF') {
    throw new ForbiddenException('Only IT staff or school admins can manage ' + scope);
  }
  const tenant = getCurrentTenant();
  const code = scope === 'IT-004' ? 'it-004:write' : 'it-005:write';
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [code]);
  if (!ok) {
    throw new ForbiddenException('Only IT staff or school admins can manage ' + scope);
  }
}

@Injectable()
export class LicenceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(includeInactive = false): Promise<LicenceDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, software_name, vendor, licence_type, ' +
          'total_seats, used_seats, expiry_date::text AS expiry_date, annual_cost::text AS annual_cost, ' +
          'notes, is_active ' +
          'FROM tech_software_licences WHERE school_id = $1::uuid' +
          (includeInactive ? '' : ' AND is_active = true') +
          ' ORDER BY software_name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      software_name: string;
      vendor: string | null;
      licence_type: string;
      total_seats: number | null;
      used_seats: number;
      expiry_date: string | null;
      annual_cost: string | null;
      notes: string | null;
      is_active: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      softwareName: r.software_name,
      vendor: r.vendor,
      licenceType: r.licence_type as LicenceDto['licenceType'],
      totalSeats: r.total_seats,
      usedSeats: r.used_seats,
      utilisationPct:
        r.total_seats === null || r.total_seats === 0
          ? null
          : Math.round((r.used_seats / r.total_seats) * 100),
      expiryDate: r.expiry_date,
      annualCost: r.annual_cost === null ? null : Number(r.annual_cost),
      notes: r.notes,
      isActive: r.is_active,
    }));
  }

  async getById(id: string): Promise<LicenceDto> {
    const all = await this.list(true);
    const found = all.find((l) => l.id === id);
    if (!found) throw new NotFoundException('Licence not found');
    return found;
  }

  async create(input: CreateLicenceDto, actor: ResolvedActor): Promise<LicenceDto> {
    await assertItAdmin(actor, this.permCheck, 'IT-004');
    if (
      input.licenceType === 'PER_SEAT' &&
      (input.totalSeats === undefined || input.totalSeats === null)
    ) {
      throw new BadRequestException('totalSeats is required for PER_SEAT licences');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_software_licences (id, school_id, software_name, vendor, licence_type, total_seats, expiry_date, annual_cost, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8, $9, $10::uuid)',
          id,
          tenant.schoolId,
          input.softwareName,
          input.vendor ?? null,
          input.licenceType,
          input.totalSeats ?? null,
          input.expiryDate ?? null,
          input.annualCost ?? null,
          input.notes ?? null,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A licence with this software_name already exists for this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(id: string, input: UpdateLicenceDto, actor: ResolvedActor): Promise<LicenceDto> {
    await assertItAdmin(actor, this.permCheck, 'IT-004');
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.softwareName !== undefined) {
      sets.push('software_name = $' + (params.length + 1));
      params.push(input.softwareName);
    }
    if (input.vendor !== undefined) {
      sets.push('vendor = $' + (params.length + 1));
      params.push(input.vendor);
    }
    if (input.totalSeats !== undefined) {
      sets.push('total_seats = $' + (params.length + 1));
      params.push(input.totalSeats);
    }
    if (input.expiryDate !== undefined) {
      sets.push('expiry_date = $' + (params.length + 1) + '::date');
      params.push(input.expiryDate);
    }
    if (input.annualCost !== undefined) {
      sets.push('annual_cost = $' + (params.length + 1));
      params.push(input.annualCost);
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + (params.length + 1));
      params.push(input.notes);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE tech_software_licences SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }

  async listAssignments(licenceId: string): Promise<LicenceAssignmentDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.licence_id::text AS licence_id, l.software_name, ' +
          "a.assignee_id::text AS assignee_id, ip.first_name || ' ' || ip.last_name AS assignee_name, " +
          'a.assigned_by::text AS assigned_by, a.assigned_at::text AS assigned_at, ' +
          'a.last_used_at::text AS last_used_at, a.notes ' +
          'FROM tech_software_assignments a ' +
          'JOIN tech_software_licences l ON l.id = a.licence_id ' +
          'JOIN platform.platform_users pu ON pu.id = a.assignee_id ' +
          'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
          'WHERE a.licence_id = $1::uuid ORDER BY a.assigned_at DESC',
        licenceId,
      );
    })) as Array<{
      id: string;
      licence_id: string;
      software_name: string;
      assignee_id: string;
      assignee_name: string;
      assigned_by: string;
      assigned_at: string;
      last_used_at: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      licenceId: r.licence_id,
      softwareName: r.software_name,
      assigneeId: r.assignee_id,
      assigneeName: r.assignee_name,
      assignedBy: r.assigned_by,
      assignedAt: r.assigned_at,
      lastUsedAt: r.last_used_at,
      notes: r.notes,
    }));
  }

  // Locked-row assignment: locks the licence FOR UPDATE,
  // verifies seat capacity, INSERTs the assignment row, bumps
  // used_seats inside the same tx. Emits
  // tech.licence.near_capacity AFTER the tx commits when
  // utilisation crosses 80%.
  async assignSeat(
    licenceId: string,
    input: AssignLicenceDto,
    actor: ResolvedActor,
  ): Promise<LicenceAssignmentDto> {
    await assertItAdmin(actor, this.permCheck, 'IT-004');
    // REVIEW-CYCLE22 BLOCKING 4 — validate assignee belongs to the
    // current tenant via sis_students / sis_guardians / hr_employees
    // projection. tech_software_assignments.assignee_id is a soft FK
    // to platform.platform_users so the schema cannot enforce tenant
    // scope; this is the actual gate.
    await assertAccountInCurrentTenant(this.tenantPrisma, input.assigneeId, 'assigneeId');
    const id = generateId();
    type NearCapacity = { total: number; used: number; pct: number; softwareName: string };
    let near: NearCapacity | undefined;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT software_name, licence_type, total_seats, used_seats, is_active ' +
          'FROM tech_software_licences WHERE id = $1::uuid FOR UPDATE',
        licenceId,
      )) as Array<{
        software_name: string;
        licence_type: string;
        total_seats: number | null;
        used_seats: number;
        is_active: boolean;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Licence not found');
      const row = lockRows[0]!;
      if (!row.is_active) throw new ConflictException('Licence is not active');
      if (row.licence_type === 'PER_SEAT' && row.total_seats !== null) {
        if (row.used_seats >= row.total_seats) {
          throw new ConflictException(
            'Licence is at full capacity (' + row.used_seats + '/' + row.total_seats + ' seats)',
          );
        }
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO tech_software_assignments (id, licence_id, assignee_id, assigned_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
          id,
          licenceId,
          input.assigneeId,
          actor.accountId,
          input.notes ?? null,
        );
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('This licence is already assigned to that user');
        }
        throw err;
      }
      await tx.$executeRawUnsafe(
        'UPDATE tech_software_licences SET used_seats = used_seats + 1, updated_at = now() WHERE id = $1::uuid',
        licenceId,
      );
      // Compute post-assignment utilisation
      if (row.total_seats !== null && row.total_seats > 0) {
        const newUsed = row.used_seats + 1;
        const pct = newUsed / row.total_seats;
        if (pct >= 0.8) {
          near = {
            total: row.total_seats,
            used: newUsed,
            pct: Math.round(pct * 100),
            softwareName: row.software_name,
          };
        }
      }
    });
    if (near) {
      const tenant = getCurrentTenant();
      const n: NearCapacity = near;
      await this.kafka.emit({
        topic: 'tech.licence.near_capacity',
        key: licenceId,
        sourceModule: 'it',
        payload: {
          licenceId,
          schoolId: tenant.schoolId,
          softwareName: n.softwareName,
          totalSeats: n.total,
          usedSeats: n.used,
          utilisationPct: n.pct,
          sourceRefId: licenceId,
        },
      });
    }
    const all = await this.listAssignments(licenceId);
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Licence assignment not found after create');
    return found;
  }

  async unassignSeat(assignmentId: string, actor: ResolvedActor): Promise<void> {
    await assertItAdmin(actor, this.permCheck, 'IT-004');
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT licence_id::text AS licence_id FROM tech_software_assignments WHERE id = $1::uuid FOR UPDATE',
        assignmentId,
      )) as Array<{ licence_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Assignment not found');
      const licenceId = lockRows[0]!.licence_id;
      await tx.$executeRawUnsafe(
        'DELETE FROM tech_software_assignments WHERE id = $1::uuid',
        assignmentId,
      );
      await tx.$executeRawUnsafe(
        'UPDATE tech_software_licences SET used_seats = GREATEST(used_seats - 1, 0), updated_at = now() WHERE id = $1::uuid',
        licenceId,
      );
    });
  }
}

@Injectable()
export class CredentialVaultService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * Resolve the actor's effective vault tier.
   *
   * STANDARD = baseline IT-005:read
   * ELEVATED = STAFF persona with IT-005:write
   * CRITICAL = School Admin OR IT-005:admin
   *
   * The Step 6 SECURITY KEYSTONE check refuses to decrypt a
   * credential when actor tier < credential tier.
   */
  async actorTier(actor: ResolvedActor): Promise<AccessTier> {
    if (actor.isSchoolAdmin) return 'CRITICAL';
    const tenant = getCurrentTenant();
    const hasAdmin = await this.permCheck.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['it-005:admin'],
    );
    if (hasAdmin) return 'CRITICAL';
    if (actor.personType === 'STAFF') {
      const hasWrite = await this.permCheck.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['it-005:write'],
      );
      if (hasWrite) return 'ELEVATED';
    }
    return 'STANDARD';
  }

  // List-level read returns summaries (no plaintext password).
  // Service-layer gate: actor must be STAFF or school admin OR
  // hold it-005:read. Teachers, students, parents 403.
  async list(actor: ResolvedActor): Promise<CredentialSummaryDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT staff or school admins can read the credential vault');
    }
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-005:read',
    ]);
    if (!ok) {
      throw new ForbiddenException('Insufficient permissions on the credential vault');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, service_name, credential_type, ' +
          'username, url, access_tier, last_rotated_at::text AS last_rotated_at, ' +
          'rotation_due_at::text AS rotation_due_at, expiry_date::text AS expiry_date, notes, ' +
          'created_at::text AS created_at, updated_at::text AS updated_at ' +
          'FROM tech_credential_vault WHERE school_id = $1::uuid ORDER BY service_name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      service_name: string;
      credential_type: string;
      username: string | null;
      url: string | null;
      access_tier: string;
      last_rotated_at: string | null;
      rotation_due_at: string | null;
      expiry_date: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      serviceName: r.service_name,
      credentialType: r.credential_type as CredentialSummaryDto['credentialType'],
      username: r.username,
      url: r.url,
      accessTier: r.access_tier as AccessTier,
      lastRotatedAt: r.last_rotated_at,
      rotationDueAt: r.rotation_due_at,
      expiryDate: r.expiry_date,
      notes: r.notes,
      hasPassword: true,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // SECURITY KEYSTONE — getById decrypts the credential and
  // returns plaintext, but only when actor tier >= credential
  // tier AND the actor holds IT-005:read. Every successful read
  // writes a VIEW row to tech_credential_access_log inside the
  // same tenant tx as the SELECT.
  async getByIdWithPassword(id: string, actor: ResolvedActor): Promise<CredentialDetailDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT staff or school admins can read the credential vault');
    }
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-005:read',
    ]);
    if (!ok) {
      throw new ForbiddenException('Insufficient permissions on the credential vault');
    }
    const tier = await this.actorTier(actor);
    type VaultRow = {
      id: string;
      school_id: string;
      service_name: string;
      credential_type: string;
      username: string | null;
      encrypted_password: string;
      url: string | null;
      access_tier: string;
      last_rotated_at: string | null;
      rotation_due_at: string | null;
      expiry_date: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
    };
    let resolved: VaultRow | undefined;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, service_name, credential_type, ' +
          'username, encrypted_password, url, access_tier, last_rotated_at::text AS last_rotated_at, ' +
          'rotation_due_at::text AS rotation_due_at, expiry_date::text AS expiry_date, notes, ' +
          'created_at::text AS created_at, updated_at::text AS updated_at ' +
          'FROM tech_credential_vault WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      )) as VaultRow[];
      if (lockRows.length === 0) {
        throw new NotFoundException('Credential not found');
      }
      const cur = lockRows[0]!;
      const credTier = cur.access_tier as AccessTier;
      if (tierRank(tier) < tierRank(credTier)) {
        throw new ForbiddenException(
          'Insufficient access tier — this credential requires ' + credTier + ' tier',
        );
      }
      // Audit-log the VIEW inside the same tx as the SELECT
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_credential_access_log (id, credential_id, accessed_by, access_type) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'VIEW')",
        generateId(),
        id,
        actor.accountId,
      );
      resolved = cur;
    });
    if (!resolved) throw new NotFoundException('Credential not found');
    const r = resolved;
    let plaintext: string;
    try {
      plaintext = decryptPassword(r.encrypted_password);
    } catch {
      throw new BadRequestException('Stored credential is not decryptable — verify IT_VAULT_KEY');
    }
    return {
      id: r.id,
      schoolId: r.school_id,
      serviceName: r.service_name,
      credentialType: r.credential_type as CredentialDetailDto['credentialType'],
      username: r.username,
      url: r.url,
      accessTier: r.access_tier as AccessTier,
      lastRotatedAt: r.last_rotated_at,
      rotationDueAt: r.rotation_due_at,
      expiryDate: r.expiry_date,
      notes: r.notes,
      hasPassword: true,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      password: plaintext,
    };
  }

  async create(input: CreateCredentialDto, actor: ResolvedActor): Promise<CredentialSummaryDto> {
    await assertItAdmin(actor, this.permCheck, 'IT-005');
    // Tier the new credential at most at the actor's current tier
    const reqTier: AccessTier = input.accessTier ?? 'STANDARD';
    const myTier = await this.actorTier(actor);
    if (tierRank(reqTier) > tierRank(myTier)) {
      throw new ForbiddenException(
        'Cannot create a ' + reqTier + ' credential — your tier is ' + myTier,
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    const enc = encryptPassword(input.password);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_credential_vault (id, school_id, service_name, credential_type, username, encrypted_password, url, last_rotated_at, rotation_due_at, expiry_date, access_tier, notes, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, now(), $8::timestamptz, $9::date, $10, $11, $12::uuid)',
        id,
        tenant.schoolId,
        input.serviceName,
        input.credentialType,
        input.username ?? null,
        enc,
        input.url ?? null,
        input.rotationDueAt ?? null,
        input.expiryDate ?? null,
        reqTier,
        input.notes ?? null,
        actor.accountId,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_credential_access_log (id, credential_id, accessed_by, access_type) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'CREATE')",
        generateId(),
        id,
        actor.accountId,
      );
    });
    const list = await this.list(actor);
    const found = list.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Credential not found after create');
    return found;
  }

  async patch(
    id: string,
    input: UpdateCredentialDto,
    actor: ResolvedActor,
  ): Promise<CredentialSummaryDto> {
    await assertItAdmin(actor, this.permCheck, 'IT-005');
    const tenant = getCurrentTenant();
    // Tier guard: caller must already be authorised at the
    // existing credential's tier
    const myTier = await this.actorTier(actor);
    const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT access_tier FROM tech_credential_vault WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{ access_tier: string }>;
    if (existing.length === 0) throw new NotFoundException('Credential not found');
    const existingTier = existing[0]!.access_tier as AccessTier;
    if (tierRank(myTier) < tierRank(existingTier)) {
      throw new ForbiddenException(
        'Cannot modify a ' + existingTier + ' credential — your tier is ' + myTier,
      );
    }
    if (input.accessTier && tierRank(input.accessTier) > tierRank(myTier)) {
      throw new ForbiddenException('Cannot raise tier above your own (' + myTier + ')');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.serviceName !== undefined) {
      sets.push('service_name = $' + (params.length + 1));
      params.push(input.serviceName);
    }
    if (input.username !== undefined) {
      sets.push('username = $' + (params.length + 1));
      params.push(input.username);
    }
    if (input.password !== undefined) {
      sets.push('encrypted_password = $' + (params.length + 1));
      params.push(encryptPassword(input.password));
      sets.push('last_rotated_at = now()');
    }
    if (input.url !== undefined) {
      sets.push('url = $' + (params.length + 1));
      params.push(input.url);
    }
    if (input.expiryDate !== undefined) {
      sets.push('expiry_date = $' + (params.length + 1) + '::date');
      params.push(input.expiryDate);
    }
    if (input.rotationDueAt !== undefined) {
      sets.push('rotation_due_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.rotationDueAt);
    }
    if (input.accessTier !== undefined) {
      sets.push('access_tier = $' + (params.length + 1));
      params.push(input.accessTier);
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + (params.length + 1));
      params.push(input.notes);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'UPDATE tech_credential_vault SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
        await tx.$executeRawUnsafe(
          'INSERT INTO tech_credential_access_log (id, credential_id, accessed_by, access_type) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MODIFY')",
          generateId(),
          id,
          actor.accountId,
        );
      });
    }
    const list = await this.list(actor);
    const found = list.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Credential not found after update');
    return found;
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    await assertItAdmin(actor, this.permCheck, 'IT-005');
    const tenant = getCurrentTenant();
    const myTier = await this.actorTier(actor);
    const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT access_tier FROM tech_credential_vault WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{ access_tier: string }>;
    if (existing.length === 0) throw new NotFoundException('Credential not found');
    const existingTier = existing[0]!.access_tier as AccessTier;
    if (tierRank(myTier) < tierRank(existingTier)) {
      throw new ForbiddenException(
        'Cannot delete a ' + existingTier + ' credential — your tier is ' + myTier,
      );
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_credential_access_log (id, credential_id, accessed_by, access_type) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'DELETE')",
        generateId(),
        id,
        actor.accountId,
      );
      // Per ADR-010 the access log CASCADEs on credential delete.
      // The DELETE row above lands first so the audit tip is
      // captured even though the row is about to drop.
      await tx.$executeRawUnsafe('DELETE FROM tech_credential_vault WHERE id = $1::uuid', id);
    });
  }

  async accessLog(id: string, actor: ResolvedActor): Promise<CredentialAccessLogDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT staff or school admins can read the access log');
    }
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-005:read',
    ]);
    if (!ok) {
      throw new ForbiddenException('Insufficient permissions on the credential vault');
    }
    // REVIEW-CYCLE22 BLOCKING 6 — apply the same tier-rank check
    // used by getByIdWithPassword. A STANDARD-tier operator who
    // cannot decrypt a CRITICAL credential must not be able to see
    // the access log either — that is metadata leakage around
    // privileged credentials (who looked, when).
    const credRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT access_tier FROM tech_credential_vault WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{ access_tier: string }>;
    if (credRows.length === 0) {
      throw new NotFoundException('Credential not found');
    }
    const credTier = credRows[0]!.access_tier as AccessTier;
    const myTier = await this.actorTier(actor);
    if (tierRank(myTier) < tierRank(credTier)) {
      throw new ForbiddenException(
        'Insufficient access tier — this credential requires ' + credTier + ' tier',
      );
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT al.id::text AS id, al.credential_id::text AS credential_id, c.service_name, ' +
          "al.accessed_by::text AS accessed_by, ip.first_name || ' ' || ip.last_name AS accessed_by_name, " +
          'al.access_type, al.accessed_at::text AS accessed_at ' +
          'FROM tech_credential_access_log al ' +
          'JOIN tech_credential_vault c ON c.id = al.credential_id ' +
          'JOIN platform.platform_users pu ON pu.id = al.accessed_by ' +
          'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
          'WHERE al.credential_id = $1::uuid AND c.school_id = $2::uuid ' +
          'ORDER BY al.accessed_at DESC',
        id,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      credential_id: string;
      service_name: string;
      accessed_by: string;
      accessed_by_name: string;
      access_type: string;
      accessed_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      credentialId: r.credential_id,
      serviceName: r.service_name,
      accessedBy: r.accessed_by,
      accessedByName: r.accessed_by_name,
      accessType: r.access_type as CredentialAccessType,
      accessedAt: r.accessed_at,
    }));
  }
}
