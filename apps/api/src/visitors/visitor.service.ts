import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { decryptPII, emailHash, encryptPII, phoneHash } from './crypto';
import type {
  CreateVisitorDto,
  CreateVisitorTypeDto,
  SignInSettingsDto,
  UpdateSignInSettingsDto,
  UpdateVisitorDto,
  UpdateVisitorTypeDto,
  VisitorBadgeColor,
  VisitorDetailDto,
  VisitorDto,
  VisitorTypeDto,
} from './dto/visitor.dto';

// Helper: shared isUniqueViolation across visitors module (prefer
// not to import from IT assets to keep modules independent).
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

interface VisitorTypeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  requires_safeguarding_check: boolean;
  badge_color: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface VisitorRow {
  id: string;
  school_id: string;
  visitor_type_id: string;
  visitor_type_name: string | null;
  badge_color: string | null;
  requires_safeguarding_check: boolean | null;
  first_name: string;
  last_name: string;
  company: string | null;
  email_encrypted: string | null;
  phone_encrypted: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingsRow {
  id: string;
  school_id: string;
  require_photo_id: boolean;
  require_purpose: boolean;
  auto_sign_out_hours: number;
  safeguarding_provider: string | null;
  badge_template: 'STANDARD' | 'COMPACT' | 'PHOTO';
  kiosk_welcome_message: string | null;
  updated_at: string;
}

const SELECT_VISITOR_BASE =
  'SELECT v.id::text AS id, v.school_id::text AS school_id, ' +
  'v.visitor_type_id::text AS visitor_type_id, vt.name AS visitor_type_name, ' +
  'vt.badge_color, vt.requires_safeguarding_check, ' +
  'v.first_name, v.last_name, v.company, ' +
  'v.email_encrypted, v.phone_encrypted, v.notes, ' +
  'TO_CHAR(v.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(v.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM vis_visitors v ' +
  // REVIEW-P2C1 ROUND 3 BLOCKING — defence-in-depth join predicate.
  // Refuses to surface a visitor type that belongs to a different
  // school than the visitor row, even if a stale row exists.
  'LEFT JOIN vis_visitor_types vt ON vt.id = v.visitor_type_id AND vt.school_id = v.school_id ';

/**
 * Visitor Type catalogue. Admin-only writes via SAF-002:admin; reads
 * gated at the controller via SAF-002:read so every persona that needs
 * to render badge colours can lookup the catalogue.
 */
@Injectable()
export class VisitorTypeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertManager(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-002:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Visitor type management requires saf-002:admin');
    }
  }

  async list(actor: ResolvedActor, includeInactive = false): Promise<VisitorTypeDto[]> {
    void actor;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const sql = includeInactive
        ? 'SELECT id::text AS id, school_id::text AS school_id, name, description, requires_safeguarding_check, badge_color, is_active, ' +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM vis_visitor_types WHERE school_id = $1::uuid ORDER BY name ASC'
        : 'SELECT id::text AS id, school_id::text AS school_id, name, description, requires_safeguarding_check, badge_color, is_active, ' +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM vis_visitor_types WHERE school_id = $1::uuid AND is_active = true ORDER BY name ASC';
      const rows = (await client.$queryRawUnsafe(sql, tenant.schoolId)) as VisitorTypeRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(input: CreateVisitorTypeDto, actor: ResolvedActor): Promise<VisitorTypeDto> {
    await this.assertManager(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO vis_visitor_types (id, school_id, name, description, requires_safeguarding_check, badge_color) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.requiresSafeguardingCheck ?? true,
          input.badgeColor ?? 'blue',
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A visitor type named "' + input.name + '" already exists in this school',
          );
        }
        throw err;
      }
      // REVIEW-P2C1 ROUND 3 BLOCKING — reload scoped by school_id even
      // though we just INSERTed the row with the calling tenant's
      // schoolId; consistent with every other vis_visitor_types read.
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, requires_safeguarding_check, badge_color, is_active, ' +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM vis_visitor_types WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      )) as VisitorTypeRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateVisitorTypeDto,
    actor: ResolvedActor,
  ): Promise<VisitorTypeDto> {
    await this.assertManager(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      if (input.name !== undefined) {
        sets.push('name = $' + p++);
        args.push(input.name);
      }
      if (input.description !== undefined) {
        sets.push('description = $' + p++);
        args.push(input.description);
      }
      if (input.requiresSafeguardingCheck !== undefined) {
        sets.push('requires_safeguarding_check = $' + p++);
        args.push(input.requiresSafeguardingCheck);
      }
      if (input.badgeColor !== undefined) {
        sets.push('badge_color = $' + p++);
        args.push(input.badgeColor);
      }
      if (input.isActive !== undefined) {
        sets.push('is_active = $' + p++);
        args.push(input.isActive);
      }
      if (sets.length === 0) throw new BadRequestException('No fields to update');
      sets.push('updated_at = now()');
      // REVIEW-P2C1 BLOCKING 2 — school_id scoped UPDATE.
      const schoolIdParam = p++;
      args.push(tenant.schoolId);
      const idParam = p;
      args.push(id);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE vis_visitor_types SET ' +
            sets.join(', ') +
            ' WHERE school_id = $' +
            schoolIdParam +
            '::uuid AND id = $' +
            idParam +
            '::uuid',
          ...args,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A visitor type with that name already exists in this school',
          );
        }
        throw err;
      }
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, requires_safeguarding_check, badge_color, is_active, ' +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM vis_visitor_types WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      )) as VisitorTypeRow[];
      if (rows.length === 0) throw new NotFoundException('Visitor type not found');
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Internal — used by VisitorService.create / VisitorService.patch /
   * SignInService.create / PreRegistrationService.create to enforce
   * the safeguarding contract before INSERT.
   *
   * REVIEW-P2C1 ROUND 3 BLOCKING — analogous to the Round 2 fix on
   * VisitorService.loadInternal. A School A reception user with
   * saf-002:write must not be able to attach a School B
   * visitorTypeId to a new School A visitor by guessing or replaying
   * the UUID. School-scoped via getCurrentTenant. Returns 404
   * (collapsed don't-leak-existence — caller cannot tell "doesn't
   * exist" from "exists in another school"). Defence-in-depth
   * alongside the AND vt.school_id = v.school_id JOIN predicate
   * added to every visitor-type JOIN.
   */
  async loadOrFail(id: string): Promise<VisitorTypeRow> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, requires_safeguarding_check, badge_color, is_active, ' +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM vis_visitor_types WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      )) as VisitorTypeRow[];
      if (rows.length === 0) {
        throw new NotFoundException('Visitor type not found');
      }
      if (!rows[0]!.is_active) {
        throw new BadRequestException('Visitor type is inactive');
      }
      return rows[0]!;
    });
  }

  private rowToDto(r: VisitorTypeRow): VisitorTypeDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      requiresSafeguardingCheck: r.requires_safeguarding_check,
      badgeColor: r.badge_color as VisitorBadgeColor,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

/**
 * VisitorService — directory of every person who has signed in.
 * SECURITY KEYSTONE — PII at rest is encrypted; kiosk lookup uses
 * the HMAC blind index without ever decrypting.
 */
@Injectable()
export class VisitorService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly visitorTypes: VisitorTypeService,
  ) {}

  private async assertManager(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-002:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Visitor management requires saf-002:write');
    }
  }

  async list(actor: ResolvedActor, search?: string): Promise<VisitorDto[]> {
    void actor;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      let sql = SELECT_VISITOR_BASE + 'WHERE v.school_id = $1::uuid';
      const args: unknown[] = [tenant.schoolId];
      if (search && search.trim() !== '') {
        sql += ' AND (v.first_name ILIKE $2 OR v.last_name ILIKE $2 OR v.company ILIKE $2)';
        args.push('%' + search.trim() + '%');
      }
      sql += ' ORDER BY v.last_name, v.first_name LIMIT 200';
      const rows = (await client.$queryRawUnsafe(sql, ...args)) as VisitorRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  /**
   * KIOSK RETURNING-VISITOR LOOKUP — takes a raw email, computes the
   * HMAC blind index, and SELECTs by email_hash. Never decrypts and
   * never returns the email_encrypted column. Returns null when no
   * match (the kiosk falls through to new-visitor capture).
   */
  async lookupByEmail(email: string): Promise<VisitorDto | null> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      // REVIEW-P2C1 MAJOR 1 — emailHash binds to schoolId.
      const hash = emailHash(tenant.schoolId, email);
      const rows = (await client.$queryRawUnsafe(
        SELECT_VISITOR_BASE + 'WHERE v.school_id = $1::uuid AND v.email_hash = $2 LIMIT 1',
        tenant.schoolId,
        hash,
      )) as VisitorRow[];
      if (rows.length === 0) return null;
      return this.rowToDto(rows[0]!);
    });
  }

  /** Admin detail with decrypted email + phone. Requires saf-002:write. */
  async getById(id: string, actor: ResolvedActor): Promise<VisitorDetailDto> {
    await this.assertManager(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_VISITOR_BASE + 'WHERE v.school_id = $1::uuid AND v.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as VisitorRow[];
      if (rows.length === 0) throw new NotFoundException('Visitor not found');
      const r = rows[0]!;
      const dto = this.rowToDto(r) as VisitorDetailDto;
      dto.email = decryptPII(r.email_encrypted);
      dto.phone = decryptPII(r.phone_encrypted);
      dto.notes = r.notes;
      return dto;
    });
  }

  async create(input: CreateVisitorDto, actor: ResolvedActor): Promise<VisitorDto> {
    await this.assertManager(actor);
    return this.createInternal(input);
  }

  /** Internal — also called by SignInService when a kiosk creates a new visitor inline. */
  async createInternal(input: CreateVisitorDto): Promise<VisitorDto> {
    const tenant = getCurrentTenant();
    await this.visitorTypes.loadOrFail(input.visitorTypeId);
    const id = generateId();
    // REVIEW-P2C1 MAJOR 1 — every blind index binds to schoolId.
    const eHash = emailHash(tenant.schoolId, input.email);
    const pHash = phoneHash(tenant.schoolId, input.phone ?? null);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Upsert-style — if a visitor with this email_hash already
      // exists, return the existing record so the kiosk does not
      // duplicate. Same UNIQUE(school_id, email_hash) gate as below.
      const existing = (await tx.$queryRawUnsafe(
        SELECT_VISITOR_BASE + 'WHERE v.school_id = $1::uuid AND v.email_hash = $2 LIMIT 1',
        tenant.schoolId,
        eHash,
      )) as VisitorRow[];
      if (existing.length > 0) {
        return this.rowToDto(existing[0]!);
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO vis_visitors (id, school_id, visitor_type_id, first_name, last_name, company, email_encrypted, email_hash, phone_encrypted, phone_hash, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11)',
          id,
          tenant.schoolId,
          input.visitorTypeId,
          input.firstName,
          input.lastName,
          input.company ?? null,
          encryptPII(input.email),
          eHash,
          encryptPII(input.phone ?? null),
          pHash,
          input.notes ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Race — another kiosk created the same email_hash between
          // the SELECT above and the INSERT. Reload and return.
          const reload = (await tx.$queryRawUnsafe(
            SELECT_VISITOR_BASE + 'WHERE v.school_id = $1::uuid AND v.email_hash = $2 LIMIT 1',
            tenant.schoolId,
            eHash,
          )) as VisitorRow[];
          if (reload.length > 0) return this.rowToDto(reload[0]!);
        }
        throw err;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_VISITOR_BASE + 'WHERE v.id = $1::uuid',
        id,
      )) as VisitorRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(id: string, input: UpdateVisitorDto, actor: ResolvedActor): Promise<VisitorDto> {
    await this.assertManager(actor);
    if (input.visitorTypeId) await this.visitorTypes.loadOrFail(input.visitorTypeId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      const map = (col: string, val: unknown) => {
        sets.push(col + ' = $' + p++);
        args.push(val);
      };
      if (input.visitorTypeId !== undefined) map('visitor_type_id', input.visitorTypeId);
      if (input.firstName !== undefined) map('first_name', input.firstName);
      if (input.lastName !== undefined) map('last_name', input.lastName);
      if (input.company !== undefined) map('company', input.company);
      if (input.email !== undefined) {
        map('email_encrypted', encryptPII(input.email));
        map('email_hash', emailHash(tenant.schoolId, input.email));
      }
      if (input.phone !== undefined) {
        map('phone_encrypted', encryptPII(input.phone));
        map('phone_hash', phoneHash(tenant.schoolId, input.phone));
      }
      if (input.notes !== undefined) map('notes', input.notes);
      if (sets.length === 0) throw new BadRequestException('No fields to update');
      sets.push('updated_at = now()');
      // Cast email_hash / phone_hash positions are TEXT — no cast needed.
      // Cast visitor_type_id to uuid if updating.
      let setClause = sets.join(', ');
      if (input.visitorTypeId !== undefined) {
        setClause = setClause.replace(/^visitor_type_id = (\$\d+)/, 'visitor_type_id = $1::uuid');
      }
      // REVIEW-P2C1 BLOCKING 2 — school_id-scoped UPDATE.
      const schoolIdParam = p++;
      args.push(tenant.schoolId);
      const idParam = p;
      args.push(id);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE vis_visitors SET ' +
            setClause +
            ' WHERE school_id = $' +
            schoolIdParam +
            '::uuid AND id = $' +
            idParam +
            '::uuid',
          ...args,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('A visitor with that email already exists in this school');
        }
        throw err;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_VISITOR_BASE + 'WHERE v.school_id = $1::uuid AND v.id = $2::uuid',
        tenant.schoolId,
        id,
      )) as VisitorRow[];
      if (rows.length === 0) throw new NotFoundException('Visitor not found');
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Internal — used by SignInService.create / PreRegistrationService.create /
   * RecurringVisitorService.create when the caller passes a visitorId
   * directly (returning visitor pre-resolved at the kiosk; staff
   * pre-registering an existing visitor; admin attaching a recurring
   * schedule to an existing contractor).
   *
   * REVIEW-P2C1 ROUND 2 BLOCKING — every direct visitorId resolution
   * MUST be school-scoped. A School A reception user with saf-002:write
   * must not be able to attach a School B visitor record to a School A
   * sign-in / pre-reg / recurring row by guessing or replaying the
   * UUID. Returns 404 (collapsed don't-leak-existence — the caller
   * cannot tell the difference between "visitor doesn't exist" and
   * "visitor exists in another school"). Defence-in-depth alongside
   * the AND v.school_id = s.school_id JOIN predicate added to the
   * sign-in / pre-reg / recurring SELECT_BASE templates.
   */
  async loadInternal(id: string): Promise<VisitorRow> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_VISITOR_BASE + 'WHERE v.school_id = $1::uuid AND v.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as VisitorRow[];
      if (rows.length === 0) throw new NotFoundException('Visitor not found');
      return rows[0]!;
    });
  }

  private rowToDto(r: VisitorRow): VisitorDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      visitorTypeId: r.visitor_type_id,
      visitorTypeName: r.visitor_type_name ?? undefined,
      badgeColor: (r.badge_color ?? undefined) as VisitorBadgeColor | undefined,
      requiresSafeguardingCheck: r.requires_safeguarding_check ?? undefined,
      firstName: r.first_name,
      lastName: r.last_name,
      company: r.company,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

/**
 * Per-school sign-in settings. UNIQUE(school_id) so each school
 * always carries exactly one settings row — auto-created on first
 * read with sane defaults.
 */
@Injectable()
export class SignInSettingsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-002:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Sign-in settings require saf-002:admin');
    }
  }

  async get(): Promise<SignInSettingsDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const tenant = getCurrentTenant();
      let rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, require_photo_id, require_purpose, auto_sign_out_hours, safeguarding_provider, badge_template, kiosk_welcome_message, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM vis_sign_in_settings WHERE school_id = $1::uuid LIMIT 1',
        tenant.schoolId,
      )) as SettingsRow[];
      if (rows.length === 0) {
        const id = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO vis_sign_in_settings (id, school_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING',
          id,
          tenant.schoolId,
        );
        rows = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id, school_id::text AS school_id, require_photo_id, require_purpose, auto_sign_out_hours, safeguarding_provider, badge_template, kiosk_welcome_message, ' +
            'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
            'FROM vis_sign_in_settings WHERE school_id = $1::uuid LIMIT 1',
          tenant.schoolId,
        )) as SettingsRow[];
      }
      return this.rowToDto(rows[0]!);
    });
  }

  async update(input: UpdateSignInSettingsDto, actor: ResolvedActor): Promise<SignInSettingsDto> {
    await this.assertAdmin(actor);
    await this.get(); // ensure row exists
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const tenant = getCurrentTenant();
      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      const map = (col: string, val: unknown) => {
        sets.push(col + ' = $' + p++);
        args.push(val);
      };
      if (input.requirePhotoId !== undefined) map('require_photo_id', input.requirePhotoId);
      if (input.requirePurpose !== undefined) map('require_purpose', input.requirePurpose);
      if (input.autoSignOutHours !== undefined) map('auto_sign_out_hours', input.autoSignOutHours);
      if (input.safeguardingProvider !== undefined)
        map('safeguarding_provider', input.safeguardingProvider);
      if (input.badgeTemplate !== undefined) map('badge_template', input.badgeTemplate);
      if (input.kioskWelcomeMessage !== undefined)
        map('kiosk_welcome_message', input.kioskWelcomeMessage);
      if (sets.length === 0) throw new BadRequestException('No fields to update');
      sets.push('updated_at = now()');
      args.push(tenant.schoolId);
      await tx.$executeRawUnsafe(
        'UPDATE vis_sign_in_settings SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          p +
          '::uuid',
        ...args,
      );
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, require_photo_id, require_purpose, auto_sign_out_hours, safeguarding_provider, badge_template, kiosk_welcome_message, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM vis_sign_in_settings WHERE school_id = $1::uuid LIMIT 1',
        tenant.schoolId,
      )) as SettingsRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private rowToDto(r: SettingsRow): SignInSettingsDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      requirePhotoId: r.require_photo_id,
      requirePurpose: r.require_purpose,
      autoSignOutHours: r.auto_sign_out_hours,
      safeguardingProvider: r.safeguarding_provider,
      badgeTemplate: r.badge_template,
      kioskWelcomeMessage: r.kiosk_welcome_message,
      updatedAt: r.updated_at,
    };
  }
}
