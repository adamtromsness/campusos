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
import { KafkaProducerService } from '@shared/kafka';
import { nameHash } from './crypto';
import type {
  BannedPersonCheckDto,
  BannedPersonCheckResultDto,
  BannedPersonDto,
  BanType,
  CreateBannedPersonDto,
  UpdateBannedPersonDto,
} from './dto/visitor.dto';

interface BannedRow {
  id: string;
  school_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  photo_s3_key: string | null;
  ban_reason: string;
  ban_type: string;
  ban_order_s3_key: string | null;
  added_by: string;
  added_by_first: string | null;
  added_by_last: string | null;
  reviewed_by: string | null;
  reviewed_by_first: string | null;
  reviewed_by_last: string | null;
  last_reviewed_at: string | null;
  is_active: boolean;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  created_at: string;
}

const SELECT_BANNED_BASE =
  'SELECT b.id::text AS id, b.school_id::text AS school_id, b.first_name, b.last_name, ' +
  "TO_CHAR(b.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, b.photo_s3_key, b.ban_reason, b.ban_type, b.ban_order_s3_key, " +
  'b.added_by::text AS added_by, ap.first_name AS added_by_first, ap.last_name AS added_by_last, ' +
  'b.reviewed_by::text AS reviewed_by, rp.first_name AS reviewed_by_first, rp.last_name AS reviewed_by_last, ' +
  "TO_CHAR(b.last_reviewed_at, 'YYYY-MM-DD') AS last_reviewed_at, b.is_active, " +
  "TO_CHAR(b.effective_from, 'YYYY-MM-DD') AS effective_from, " +
  "TO_CHAR(b.effective_to, 'YYYY-MM-DD') AS effective_to, b.notes, " +
  'TO_CHAR(b.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM vis_banned_persons b ' +
  'LEFT JOIN platform.platform_users apu ON apu.id = b.added_by ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = apu.person_id ' +
  'LEFT JOIN platform.platform_users rpu ON rpu.id = b.reviewed_by ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = rpu.person_id ';

/**
 * BannedPersonService — SAFETY KEYSTONE.
 *
 * Plaintext name + DOB + court-order S3 key are gated on the dedicated
 * safeguarding_ban:read permission. Only School Admin and Platform
 * Admin hold this permission via the everyFunction grant. Reception
 * Staff do NOT hold safeguarding_ban:read — their kiosk only ever
 * receives the BLOCKED outcome via the silent vis.banned_person.
 * detected emit.
 */
@Injectable()
export class BannedPersonService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async assertSafeguardingAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'safeguarding_ban:read',
    ]);
    if (!ok) {
      throw new ForbiddenException('Banned persons registry requires safeguarding_ban:read');
    }
  }

  async list(actor: ResolvedActor, includeInactive = false): Promise<BannedPersonDto[]> {
    await this.assertSafeguardingAdmin(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const sql =
        SELECT_BANNED_BASE +
        'WHERE b.school_id = $1::uuid' +
        (includeInactive ? '' : ' AND b.is_active = true') +
        ' ORDER BY b.is_active DESC, b.last_name ASC';
      const rows = (await client.$queryRawUnsafe(sql, tenant.schoolId)) as BannedRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<BannedPersonDto> {
    await this.assertSafeguardingAdmin(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_BANNED_BASE + 'WHERE b.school_id = $1::uuid AND b.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as BannedRow[];
      if (rows.length === 0) throw new NotFoundException('Banned person not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(input: CreateBannedPersonDto, actor: ResolvedActor): Promise<BannedPersonDto> {
    await this.assertSafeguardingAdmin(actor);
    if (input.banType === 'COURT_ORDER' || input.banType === 'RESTRAINING_ORDER') {
      if (!input.banOrderS3Key) {
        throw new BadRequestException(
          'COURT_ORDER and RESTRAINING_ORDER ban types require ban_order_s3_key supporting document',
        );
      }
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    // REVIEW-P2C1 MAJOR 1 — nameHash binds to schoolId.
    const hash = nameHash(
      tenant.schoolId,
      input.firstName,
      input.lastName,
      input.dateOfBirth ?? null,
    );
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO vis_banned_persons (id, school_id, first_name, last_name, date_of_birth, name_hash, photo_s3_key, ban_reason, ban_type, ban_order_s3_key, added_by, effective_from, effective_to, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9, $10, $11::uuid, $12::date, $13::date, $14)',
        id,
        tenant.schoolId,
        input.firstName,
        input.lastName,
        input.dateOfBirth ?? null,
        hash,
        input.photoS3Key ?? null,
        input.banReason,
        input.banType,
        input.banOrderS3Key ?? null,
        actor.accountId,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        input.notes ?? null,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_BANNED_BASE + 'WHERE b.id = $1::uuid',
        id,
      )) as BannedRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateBannedPersonDto,
    actor: ResolvedActor,
  ): Promise<BannedPersonDto> {
    await this.assertSafeguardingAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C1 BLOCKING 2 — every lock + UPDATE + reload predicate
      // includes school_id so an actor authenticated against tenant A
      // school A cannot mutate tenant A school B's banned-person row by
      // guessing or replaying the UUID. Defence-in-depth alongside the
      // tenant search_path isolation.
      const existing = (await tx.$queryRawUnsafe(
        'SELECT first_name, last_name, ' +
          "TO_CHAR(date_of_birth, 'YYYY-MM-DD') AS date_of_birth FROM vis_banned_persons WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE",
        tenant.schoolId,
        id,
      )) as Array<{ first_name: string; last_name: string; date_of_birth: string | null }>;
      if (existing.length === 0) throw new NotFoundException('Banned person not found');
      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      const map = (col: string, val: unknown, cast?: string) => {
        sets.push(col + ' = $' + p + (cast ?? ''));
        args.push(val);
        p++;
      };
      if (input.firstName !== undefined) map('first_name', input.firstName);
      if (input.lastName !== undefined) map('last_name', input.lastName);
      if (input.dateOfBirth !== undefined) map('date_of_birth', input.dateOfBirth, '::date');
      if (input.photoS3Key !== undefined) map('photo_s3_key', input.photoS3Key);
      if (input.banReason !== undefined) map('ban_reason', input.banReason);
      if (input.banType !== undefined) map('ban_type', input.banType);
      if (input.banOrderS3Key !== undefined) map('ban_order_s3_key', input.banOrderS3Key);
      if (input.isActive !== undefined) map('is_active', input.isActive);
      if (input.effectiveFrom !== undefined) map('effective_from', input.effectiveFrom, '::date');
      if (input.effectiveTo !== undefined) map('effective_to', input.effectiveTo, '::date');
      if (input.notes !== undefined) map('notes', input.notes);
      if (input.markReviewed) {
        map('reviewed_by', actor.accountId, '::uuid');
        sets.push('last_reviewed_at = CURRENT_DATE');
      }

      // Recompute name_hash if name or DOB changed (REVIEW-P2C1 MAJOR 1
      // — nameHash now binds to schoolId).
      const newFirst = input.firstName ?? existing[0]!.first_name;
      const newLast = input.lastName ?? existing[0]!.last_name;
      const newDob =
        input.dateOfBirth === null ? null : (input.dateOfBirth ?? existing[0]!.date_of_birth);
      if (
        input.firstName !== undefined ||
        input.lastName !== undefined ||
        input.dateOfBirth !== undefined
      ) {
        map('name_hash', nameHash(tenant.schoolId, newFirst, newLast, newDob));
      }

      if (sets.length === 0) throw new BadRequestException('No fields to update');
      sets.push('updated_at = now()');
      const schoolIdParam = p++;
      args.push(tenant.schoolId);
      const idParam = p;
      args.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE vis_banned_persons SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          schoolIdParam +
          '::uuid AND id = $' +
          idParam +
          '::uuid',
        ...args,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_BANNED_BASE + 'WHERE b.school_id = $1::uuid AND b.id = $2::uuid',
        tenant.schoolId,
        id,
      )) as BannedRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * KIOSK INTERNAL — called by SignInService on every sign-in.
   *
   * Computes HMAC of the entered name + DOB and matches against
   * vis_banned_persons.name_hash WHERE is_active = true. On match:
   *   1. Emits vis.banned_person.detected so the safeguarding officer
   *      is paged.
   *   2. Returns { blocked: true } so the SignInService refuses to
   *      create the sign-in.
   * The visitor never learns why they were blocked — the kiosk renders
   * a neutral "please see reception staff" message.
   *
   * Public method (no permission gate) because the kiosk is the only
   * caller and it runs as a Staff actor with saf-002:write — the gate
   * happens at the SignInService entrypoint, not here.
   */
  async checkAtKiosk(
    input: BannedPersonCheckDto,
    actor: ResolvedActor,
  ): Promise<BannedPersonCheckResultDto> {
    const tenant = getCurrentTenant();
    // REVIEW-P2C1 MAJOR 1 — nameHash binds to schoolId.
    const hash = nameHash(
      tenant.schoolId,
      input.firstName,
      input.lastName,
      input.dateOfBirth ?? null,
    );
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM vis_banned_persons ' +
          'WHERE school_id = $1::uuid AND name_hash = $2 AND is_active = true ' +
          'AND effective_from <= CURRENT_DATE ' +
          'AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) LIMIT 1',
        tenant.schoolId,
        hash,
      )) as Array<{ id: string }>;
    });
    if (rows.length === 0) {
      return { blocked: false };
    }
    const detectedAt = new Date().toISOString();
    const banId = rows[0]!.id;
    // Emit AFTER the read so the safeguarding officer is paged. We
    // never include the entered name in the payload — the registry
    // row already has the plaintext for admins.
    await this.kafka.emit({
      topic: 'vis.banned_person.detected',
      key: banId,
      sourceModule: 'visitors',
      payload: {
        bannedPersonId: banId,
        schoolId: tenant.schoolId,
        detectedByAccountId: actor.accountId,
        detectedAt,
        sourceRefId: banId,
      },
    });
    return { blocked: true, detectedAt };
  }

  private rowToDto(r: BannedRow): BannedPersonDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      firstName: r.first_name,
      lastName: r.last_name,
      dateOfBirth: r.date_of_birth,
      photoS3Key: r.photo_s3_key,
      banReason: r.ban_reason,
      banType: r.ban_type as BanType,
      banOrderS3Key: r.ban_order_s3_key,
      addedBy: r.added_by,
      addedByName:
        r.added_by_first || r.added_by_last
          ? [r.added_by_first ?? '', r.added_by_last ?? ''].filter(Boolean).join(' ')
          : null,
      reviewedBy: r.reviewed_by,
      reviewedByName:
        r.reviewed_by_first || r.reviewed_by_last
          ? [r.reviewed_by_first ?? '', r.reviewed_by_last ?? ''].filter(Boolean).join(' ')
          : null,
      lastReviewedAt: r.last_reviewed_at,
      isActive: r.is_active,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      notes: r.notes,
      createdAt: r.created_at,
    };
  }
}
