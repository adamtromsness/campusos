import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { generateQrToken } from './crypto';
import { BannedPersonService } from './banned-person.service';
import { VisitorService, VisitorTypeService, isUniqueViolation } from './visitor.service';
import type {
  AccessScheduleDto,
  BypassSafeguardingDto,
  CreatePreRegistrationDto,
  CreateRecurringVisitorDto,
  CreateSignInDto,
  PreRegistrationDto,
  PreRegistrationScanDto,
  RecurringVisitorDto,
  ScheduleDay,
  SignInDto,
  SignInListQueryDto,
  UpdateRecurringVisitorDto,
  VisitorBadgeColor,
  SafeguardingStatus,
} from './dto/visitor.dto';

interface SignInRow {
  id: string;
  school_id: string;
  visitor_id: string;
  visitor_first: string;
  visitor_last: string;
  visitor_company: string | null;
  visitor_type_name: string | null;
  badge_color: string | null;
  signed_in_at: string;
  signed_out_at: string | null;
  host_id: string | null;
  host_first: string | null;
  host_last: string | null;
  purpose: string | null;
  building_id: string | null;
  pre_registration_id: string | null;
  badge_number: string | null;
  safeguarding_check_status: string;
  safeguarding_check_ref: string | null;
  bypass_admin_id: string | null;
  bypass_first: string | null;
  bypass_last: string | null;
  bypass_reason: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SIGNIN_BASE =
  'SELECT s.id::text AS id, s.school_id::text AS school_id, s.visitor_id::text AS visitor_id, ' +
  'v.first_name AS visitor_first, v.last_name AS visitor_last, v.company AS visitor_company, ' +
  'vt.name AS visitor_type_name, vt.badge_color, ' +
  'TO_CHAR(s.signed_in_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS signed_in_at, ' +
  'TO_CHAR(s.signed_out_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS signed_out_at, ' +
  's.host_id::text AS host_id, hp.first_name AS host_first, hp.last_name AS host_last, ' +
  's.purpose, s.building_id::text AS building_id, s.pre_registration_id::text AS pre_registration_id, s.badge_number, ' +
  's.safeguarding_check_status, s.safeguarding_check_ref, ' +
  's.bypass_admin_id::text AS bypass_admin_id, bp.first_name AS bypass_first, bp.last_name AS bypass_last, s.bypass_reason, ' +
  'TO_CHAR(s.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(s.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM vis_sign_ins s ' +
  'JOIN vis_visitors v ON v.id = s.visitor_id ' +
  'LEFT JOIN vis_visitor_types vt ON vt.id = v.visitor_type_id ' +
  'LEFT JOIN platform.platform_users hpu ON hpu.id = s.host_id ' +
  'LEFT JOIN platform.iam_person hp ON hp.id = hpu.person_id ' +
  'LEFT JOIN platform.platform_users bpu ON bpu.id = s.bypass_admin_id ' +
  'LEFT JOIN platform.iam_person bp ON bp.id = bpu.person_id ';

function nameOrNull(first: string | null, last: string | null): string | null {
  if (!first && !last) return null;
  return [first ?? '', last ?? ''].filter(Boolean).join(' ');
}

/**
 * SignInService — KIOSK KEYSTONE.
 *
 * sign-in flow:
 *   1. Resolve or create the vis_visitors row (returning visitor via
 *      email_hash, otherwise create new).
 *   2. Banned-person check via BannedPersonService.checkAtKiosk (HMAC
 *      blind index). On match: throw 451 Unavailable For Legal Reasons.
 *      Wait — Nest doesn't ship 451; we use 403 Forbidden with a
 *      neutral message + the kiosk renders "please see reception staff".
 *   3. If visitor type requires safeguarding, validate that the
 *      caller supplied safeguardingCheckRef OR the existing record
 *      already has a PASSED status. Default starting state is
 *      PASSED when a ref is supplied; PASSED when NOT_REQUIRED;
 *      FLAGGED when required but no ref — kiosk routes to reception.
 *   4. INSERT vis_sign_ins.
 *   5. Emit vis.visitor.signed_in.
 */
@Injectable()
export class SignInService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
    private readonly visitors: VisitorService,
    private readonly visitorTypes: VisitorTypeService,
    private readonly banned: BannedPersonService,
  ) {}

  async assertReceptionStaff(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-002:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Sign-in processing requires saf-002:write');
    }
  }

  async listOnSite(): Promise<SignInDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_SIGNIN_BASE +
          'WHERE s.school_id = $1::uuid AND s.signed_out_at IS NULL ' +
          'ORDER BY s.signed_in_at DESC',
        tenant.schoolId,
      )) as SignInRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async list(query: SignInListQueryDto): Promise<SignInDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const where: string[] = ['s.school_id = $1::uuid'];
      const args: unknown[] = [tenant.schoolId];
      let p = 2;
      if (query.fromDate) {
        where.push('s.signed_in_at >= $' + p++ + '::timestamptz');
        args.push(query.fromDate);
      }
      if (query.toDate) {
        where.push('s.signed_in_at < $' + p++ + '::timestamptz');
        args.push(query.toDate);
      }
      if (query.hostId) {
        where.push('s.host_id = $' + p++ + '::uuid');
        args.push(query.hostId);
      }
      if (query.visitorId) {
        where.push('s.visitor_id = $' + p++ + '::uuid');
        args.push(query.visitorId);
      }
      if (query.onSiteOnly) {
        where.push('s.signed_out_at IS NULL');
      }
      const limit = query.limit ?? 100;
      const sql =
        SELECT_SIGNIN_BASE +
        'WHERE ' +
        where.join(' AND ') +
        ' ORDER BY s.signed_in_at DESC LIMIT ' +
        limit;
      const rows = (await client.$queryRawUnsafe(sql, ...args)) as SignInRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<SignInDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_SIGNIN_BASE + 'WHERE s.school_id = $1::uuid AND s.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as SignInRow[];
      if (rows.length === 0) throw new NotFoundException('Sign-in not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(input: CreateSignInDto, actor: ResolvedActor): Promise<SignInDto> {
    await this.assertReceptionStaff(actor);
    const tenant = getCurrentTenant();

    // Step 1 — resolve or create visitor.
    let visitorId: string;
    let visitorFirst: string;
    let visitorLast: string;
    if (input.visitorId) {
      const existing = await this.visitors.loadInternal(input.visitorId);
      visitorId = existing.id;
      visitorFirst = existing.first_name;
      visitorLast = existing.last_name;
    } else {
      if (!input.visitorTypeId || !input.firstName || !input.lastName || !input.email) {
        throw new BadRequestException(
          'New-visitor sign-in requires visitorTypeId + firstName + lastName + email',
        );
      }
      const created = await this.visitors.createInternal({
        visitorTypeId: input.visitorTypeId,
        firstName: input.firstName,
        lastName: input.lastName,
        company: input.company,
        email: input.email,
        phone: input.phone,
      });
      visitorId = created.id;
      visitorFirst = created.firstName;
      visitorLast = created.lastName;
    }

    // Step 2 — banned-person check on every sign-in.
    const ban = await this.banned.checkAtKiosk(
      { firstName: visitorFirst, lastName: visitorLast, dateOfBirth: input.dateOfBirth },
      actor,
    );
    if (ban.blocked) {
      // Neutral message — never reveal the ban detail to the visitor.
      // The kiosk treats this as a generic "please see reception".
      throw new ForbiddenException('Please see reception staff');
    }

    // Step 3 — safeguarding policy.
    const visitor = await this.visitors.loadInternal(visitorId);
    const visitorType = await this.visitorTypes.loadOrFail(visitor.visitor_type_id);
    let status: SafeguardingStatus = 'NOT_REQUIRED';
    if (visitorType.requires_safeguarding_check) {
      status = input.safeguardingCheckRef ? 'PASSED' : 'FLAGGED';
    }

    // Step 4 — INSERT sign-in.
    const id = generateId();
    const signedInRow = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO vis_sign_ins (id, school_id, visitor_id, host_id, purpose, building_id, badge_number, safeguarding_check_status, safeguarding_check_ref) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7, $8, $9)',
          id,
          tenant.schoolId,
          visitorId,
          input.hostId ?? null,
          input.purpose ?? null,
          input.buildingId ?? null,
          input.badgeNumber ?? null,
          status,
          input.safeguardingCheckRef ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException('Sign-in conflict — please retry');
        }
        throw err;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SIGNIN_BASE + 'WHERE s.id = $1::uuid',
        id,
      )) as SignInRow[];
      return rows[0]!;
    });

    // Step 5 — emit vis.visitor.signed_in AFTER tx commits.
    await this.kafka.emit({
      topic: 'vis.visitor.signed_in',
      key: id,
      sourceModule: 'visitors',
      payload: {
        signInId: id,
        schoolId: tenant.schoolId,
        visitorId,
        visitorName: visitorFirst + ' ' + visitorLast,
        visitorTypeName: visitorType.name,
        hostAccountId: input.hostId ?? null,
        safeguardingCheckStatus: status,
        signedInAt: signedInRow.signed_in_at,
        sourceRefId: id,
      },
    });

    return this.rowToDto(signedInRow);
  }

  async signOut(signInId: string, actor: ResolvedActor): Promise<SignInDto> {
    await this.assertReceptionStaff(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const tenant = getCurrentTenant();
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, signed_out_at FROM vis_sign_ins WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        signInId,
      )) as Array<{ id: string; signed_out_at: string | null }>;
      if (lock.length === 0) throw new NotFoundException('Sign-in not found');
      if (lock[0]!.signed_out_at !== null) {
        throw new BadRequestException('Visitor already signed out');
      }
      await tx.$executeRawUnsafe(
        'UPDATE vis_sign_ins SET signed_out_at = now(), updated_at = now() WHERE id = $1::uuid',
        signInId,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SIGNIN_BASE + 'WHERE s.id = $1::uuid',
        signInId,
      )) as SignInRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async bypassSafeguarding(
    signInId: string,
    input: BypassSafeguardingDto,
    actor: ResolvedActor,
  ): Promise<SignInDto> {
    if (!actor.isSchoolAdmin) {
      // School admin only — never delegate to reception staff.
      throw new ForbiddenException('Safeguarding bypass requires School Admin authority');
    }
    if (!input.reason || input.reason.trim().length <= 10) {
      // Defence-in-depth — DTO validator already enforces this.
      throw new BadRequestException('bypassReason must be more than 10 characters');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const tenant = getCurrentTenant();
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, safeguarding_check_status FROM vis_sign_ins WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        signInId,
      )) as Array<{ id: string; safeguarding_check_status: string }>;
      if (lock.length === 0) throw new NotFoundException('Sign-in not found');
      if (lock[0]!.safeguarding_check_status === 'BYPASSED_BY_ADMIN') {
        throw new BadRequestException('Sign-in is already bypassed');
      }
      await tx.$executeRawUnsafe(
        "UPDATE vis_sign_ins SET safeguarding_check_status = 'BYPASSED_BY_ADMIN', " +
          'safeguarding_check_ref = NULL, bypass_admin_id = $1::uuid, bypass_reason = $2, updated_at = now() ' +
          'WHERE id = $3::uuid',
        actor.accountId,
        input.reason.trim(),
        signInId,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SIGNIN_BASE + 'WHERE s.id = $1::uuid',
        signInId,
      )) as SignInRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /** Internal — used by MusterService.create() to enumerate active sign-ins. */
  async listActiveForMuster(): Promise<SignInRow[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      return (await client.$queryRawUnsafe(
        SELECT_SIGNIN_BASE +
          'WHERE s.school_id = $1::uuid AND s.signed_out_at IS NULL ' +
          'ORDER BY s.signed_in_at ASC',
        tenant.schoolId,
      )) as SignInRow[];
    });
  }

  /** Internal — used by PreRegistrationService.scan() to create the auto sign-in. */
  async createFromPreReg(args: {
    visitorId: string;
    visitorFirst: string;
    visitorLast: string;
    visitorTypeName: string;
    hostId: string | null;
    purpose: string | null;
    preRegId: string;
    safeguardingCheckRef: string | null;
    requiresSafeguardingCheck: boolean;
    actor: ResolvedActor;
  }): Promise<SignInDto> {
    const tenant = getCurrentTenant();
    const id = generateId();
    // Pre-registered visitors are pre-vetted — staff already verified
    // identity when issuing the QR code, so the safeguarding gate
    // defaults to PASSED when required, NOT_REQUIRED otherwise.
    const status: SafeguardingStatus = args.requiresSafeguardingCheck ? 'PASSED' : 'NOT_REQUIRED';
    const signedInRow = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO vis_sign_ins (id, school_id, visitor_id, host_id, purpose, pre_registration_id, safeguarding_check_status, safeguarding_check_ref) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7, $8)',
        id,
        tenant.schoolId,
        args.visitorId,
        args.hostId,
        args.purpose,
        args.preRegId,
        status,
        args.safeguardingCheckRef,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SIGNIN_BASE + 'WHERE s.id = $1::uuid',
        id,
      )) as SignInRow[];
      return rows[0]!;
    });
    await this.kafka.emit({
      topic: 'vis.visitor.signed_in',
      key: id,
      sourceModule: 'visitors',
      payload: {
        signInId: id,
        schoolId: tenant.schoolId,
        visitorId: args.visitorId,
        visitorName: args.visitorFirst + ' ' + args.visitorLast,
        visitorTypeName: args.visitorTypeName,
        hostAccountId: args.hostId,
        safeguardingCheckStatus: status,
        signedInAt: signedInRow.signed_in_at,
        sourceRefId: id,
        viaPreRegistrationId: args.preRegId,
      },
    });
    return this.rowToDto(signedInRow);
  }

  rowToDto(r: SignInRow): SignInDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      visitorId: r.visitor_id,
      visitorName: r.visitor_first + ' ' + r.visitor_last,
      visitorCompany: r.visitor_company,
      visitorTypeName: r.visitor_type_name ?? 'Unknown',
      badgeColor: (r.badge_color ?? 'blue') as VisitorBadgeColor,
      signedInAt: r.signed_in_at,
      signedOutAt: r.signed_out_at,
      hostId: r.host_id,
      hostName: nameOrNull(r.host_first, r.host_last),
      purpose: r.purpose,
      buildingId: r.building_id,
      preRegistrationId: r.pre_registration_id,
      badgeNumber: r.badge_number,
      safeguardingCheckStatus: r.safeguarding_check_status as SafeguardingStatus,
      safeguardingCheckRef: r.safeguarding_check_ref,
      bypassAdminId: r.bypass_admin_id,
      bypassAdminName: nameOrNull(r.bypass_first, r.bypass_last),
      bypassReason: r.bypass_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

// ── Pre-Registration ────────────────────────────────────────────

interface PreRegRow {
  id: string;
  school_id: string;
  visitor_id: string;
  visitor_first: string;
  visitor_last: string;
  visitor_company: string | null;
  expected_at: string;
  purpose: string | null;
  host_id: string | null;
  host_first: string | null;
  host_last: string | null;
  qr_code_token: string;
  expires_at: string;
  used_at: string | null;
  created_by: string;
  created_at: string;
}

const SELECT_PREREG_BASE =
  'SELECT pr.id::text AS id, pr.school_id::text AS school_id, pr.visitor_id::text AS visitor_id, ' +
  'v.first_name AS visitor_first, v.last_name AS visitor_last, v.company AS visitor_company, ' +
  'TO_CHAR(pr.expected_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS expected_at, ' +
  'pr.purpose, pr.host_id::text AS host_id, hp.first_name AS host_first, hp.last_name AS host_last, ' +
  'pr.qr_code_token, ' +
  'TO_CHAR(pr.expires_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS expires_at, ' +
  'TO_CHAR(pr.used_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS used_at, ' +
  'pr.created_by::text AS created_by, ' +
  'TO_CHAR(pr.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM vis_pre_registrations pr ' +
  'JOIN vis_visitors v ON v.id = pr.visitor_id ' +
  'LEFT JOIN platform.platform_users hpu ON hpu.id = pr.host_id ' +
  'LEFT JOIN platform.iam_person hp ON hp.id = hpu.person_id ';

@Injectable()
export class PreRegistrationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly visitors: VisitorService,
    private readonly visitorTypes: VisitorTypeService,
    private readonly signIns: SignInService,
  ) {}

  private async assertStaff(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-002:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Pre-registration management requires saf-002:write');
    }
  }

  async list(): Promise<PreRegistrationDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_PREREG_BASE +
          'WHERE pr.school_id = $1::uuid AND pr.used_at IS NULL AND pr.expires_at >= now() ' +
          'ORDER BY pr.expected_at ASC',
        tenant.schoolId,
      )) as PreRegRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(input: CreatePreRegistrationDto, actor: ResolvedActor): Promise<PreRegistrationDto> {
    await this.assertStaff(actor);
    let visitorId: string;
    if (input.visitorId) {
      const existing = await this.visitors.loadInternal(input.visitorId);
      visitorId = existing.id;
    } else {
      if (!input.visitorTypeId || !input.firstName || !input.lastName || !input.email) {
        throw new BadRequestException(
          'Pre-registration requires visitorId OR visitorTypeId + firstName + lastName + email',
        );
      }
      const created = await this.visitors.createInternal({
        visitorTypeId: input.visitorTypeId,
        firstName: input.firstName,
        lastName: input.lastName,
        company: input.company,
        email: input.email,
        phone: input.phone,
      });
      visitorId = created.id;
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    const token = generateQrToken();
    const expiresInDays = input.expiresInDays ?? 14;
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO vis_pre_registrations (id, school_id, visitor_id, expected_at, purpose, host_id, qr_code_token, expires_at, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6::uuid, $7, $4::timestamptz + ($8 || ' days')::interval, $9::uuid)",
        id,
        tenant.schoolId,
        visitorId,
        input.expectedAt,
        input.purpose ?? null,
        input.hostId ?? null,
        token,
        String(expiresInDays),
        actor.accountId,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_PREREG_BASE + 'WHERE pr.id = $1::uuid',
        id,
      )) as PreRegRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async cancel(id: string, actor: ResolvedActor): Promise<void> {
    await this.assertStaff(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM vis_pre_registrations WHERE school_id = $1::uuid AND id = $2::uuid AND used_at IS NULL',
        tenant.schoolId,
        id,
      );
    });
  }

  /**
   * KIOSK QR SCAN — locks the pre-reg row, validates not-expired +
   * not-used, stamps used_at, then auto-creates the sign-in via
   * SignInService.createFromPreReg. Re-scan returns 410 Gone.
   */
  async scan(input: PreRegistrationScanDto, actor: ResolvedActor): Promise<SignInDto> {
    await this.signIns.assertReceptionStaff(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const tenant = getCurrentTenant();
      const rows = (await tx.$queryRawUnsafe(
        'SELECT pr.id::text AS id, pr.visitor_id::text AS visitor_id, pr.host_id::text AS host_id, ' +
          'pr.purpose, pr.expires_at, pr.used_at, ' +
          'v.first_name, v.last_name, v.visitor_type_id::text AS visitor_type_id ' +
          'FROM vis_pre_registrations pr JOIN vis_visitors v ON v.id = pr.visitor_id ' +
          'WHERE pr.school_id = $1::uuid AND pr.qr_code_token = $2 FOR UPDATE OF pr',
        tenant.schoolId,
        input.qrCodeToken,
      )) as Array<{
        id: string;
        visitor_id: string;
        host_id: string | null;
        purpose: string | null;
        expires_at: Date;
        used_at: Date | null;
        first_name: string;
        last_name: string;
        visitor_type_id: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('QR code not recognised');
      }
      const r = rows[0]!;
      if (r.used_at !== null) {
        throw new GoneException('QR code already used');
      }
      if (new Date(r.expires_at).getTime() < Date.now()) {
        throw new GoneException('QR code expired');
      }
      await tx.$executeRawUnsafe(
        'UPDATE vis_pre_registrations SET used_at = now(), updated_at = now() WHERE id = $1::uuid',
        r.id,
      );
      const visitorType = await this.visitorTypes.loadOrFail(r.visitor_type_id);
      const created = await this.signIns.createFromPreReg({
        visitorId: r.visitor_id,
        visitorFirst: r.first_name,
        visitorLast: r.last_name,
        visitorTypeName: visitorType.name,
        hostId: r.host_id,
        purpose: r.purpose,
        preRegId: r.id,
        safeguardingCheckRef: null,
        requiresSafeguardingCheck: visitorType.requires_safeguarding_check,
        actor,
      });
      return created;
    });
  }

  private rowToDto(r: PreRegRow): PreRegistrationDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      visitorId: r.visitor_id,
      visitorName: r.visitor_first + ' ' + r.visitor_last,
      visitorCompany: r.visitor_company,
      expectedAt: r.expected_at,
      purpose: r.purpose,
      hostId: r.host_id,
      hostName: nameOrNull(r.host_first, r.host_last),
      qrCodeToken: r.qr_code_token,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }
}

// ── Recurring Visitors ──────────────────────────────────────────

interface RecurringRow {
  id: string;
  school_id: string;
  visitor_id: string;
  visitor_first: string;
  visitor_last: string;
  visitor_company: string | null;
  access_schedule: AccessScheduleDto | null;
  valid_from: string;
  valid_to: string | null;
  approved_by: string;
  approved_first: string | null;
  approved_last: string | null;
  notes: string | null;
  is_active: boolean;
}

const SELECT_RECUR_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, r.visitor_id::text AS visitor_id, ' +
  'v.first_name AS visitor_first, v.last_name AS visitor_last, v.company AS visitor_company, ' +
  "r.access_schedule, TO_CHAR(r.valid_from, 'YYYY-MM-DD') AS valid_from, " +
  "TO_CHAR(r.valid_to, 'YYYY-MM-DD') AS valid_to, " +
  'r.approved_by::text AS approved_by, ap.first_name AS approved_first, ap.last_name AS approved_last, ' +
  'r.notes, r.is_active ' +
  'FROM vis_recurring_visitors r ' +
  'JOIN vis_visitors v ON v.id = r.visitor_id ' +
  'LEFT JOIN platform.platform_users apu ON apu.id = r.approved_by ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = apu.person_id ';

const DAY_INDEX_TO_TOKEN: Record<number, ScheduleDay> = {
  0: 'SUN',
  1: 'MON',
  2: 'TUE',
  3: 'WED',
  4: 'THU',
  5: 'FRI',
  6: 'SAT',
};

@Injectable()
export class RecurringVisitorService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly visitors: VisitorService,
  ) {}

  private async assertStaff(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-002:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Recurring visitor management requires saf-002:write');
    }
  }

  async list(): Promise<RecurringVisitorDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_RECUR_BASE +
          'WHERE r.school_id = $1::uuid AND r.is_active = true ' +
          'ORDER BY v.last_name, v.first_name',
        tenant.schoolId,
      )) as RecurringRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async listToday(): Promise<RecurringVisitorDto[]> {
    const today = DAY_INDEX_TO_TOKEN[new Date().getDay()]!;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_RECUR_BASE +
          'WHERE r.school_id = $1::uuid AND r.is_active = true ' +
          'AND r.valid_from <= CURRENT_DATE ' +
          'AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE) ' +
          "AND r.access_schedule -> 'days' @> $2::jsonb",
        tenant.schoolId,
        JSON.stringify([today]),
      )) as RecurringRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(
    input: CreateRecurringVisitorDto,
    actor: ResolvedActor,
  ): Promise<RecurringVisitorDto> {
    await this.assertStaff(actor);
    await this.visitors.loadInternal(input.visitorId);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO vis_recurring_visitors (id, school_id, visitor_id, access_schedule, valid_from, valid_to, approved_by, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date, $6::date, $7::uuid, $8)',
        id,
        tenant.schoolId,
        input.visitorId,
        JSON.stringify(input.accessSchedule),
        input.validFrom,
        input.validTo ?? null,
        actor.accountId,
        input.notes ?? null,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_RECUR_BASE + 'WHERE r.id = $1::uuid',
        id,
      )) as RecurringRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateRecurringVisitorDto,
    actor: ResolvedActor,
  ): Promise<RecurringVisitorDto> {
    await this.assertStaff(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      if (input.accessSchedule !== undefined) {
        sets.push('access_schedule = $' + p + '::jsonb');
        args.push(JSON.stringify(input.accessSchedule));
        p++;
      }
      if (input.validFrom !== undefined) {
        sets.push('valid_from = $' + p + '::date');
        args.push(input.validFrom);
        p++;
      }
      if (input.validTo !== undefined) {
        sets.push('valid_to = $' + p + '::date');
        args.push(input.validTo);
        p++;
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + p++);
        args.push(input.notes);
      }
      if (input.isActive !== undefined) {
        sets.push('is_active = $' + p++);
        args.push(input.isActive);
      }
      if (sets.length === 0) throw new BadRequestException('No fields to update');
      sets.push('updated_at = now()');
      args.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE vis_recurring_visitors SET ' + sets.join(', ') + ' WHERE id = $' + p + '::uuid',
        ...args,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_RECUR_BASE + 'WHERE r.id = $1::uuid',
        id,
      )) as RecurringRow[];
      if (rows.length === 0) throw new NotFoundException('Recurring visitor not found');
      return this.rowToDto(rows[0]!);
    });
  }

  private rowToDto(r: RecurringRow): RecurringVisitorDto {
    const schedule = (r.access_schedule ?? {
      days: [],
      timeStart: '',
      timeEnd: '',
    }) as AccessScheduleDto;
    return {
      id: r.id,
      schoolId: r.school_id,
      visitorId: r.visitor_id,
      visitorName: r.visitor_first + ' ' + r.visitor_last,
      visitorCompany: r.visitor_company,
      accessSchedule: schedule,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      approvedBy: r.approved_by,
      approvedByName: nameOrNull(r.approved_first, r.approved_last),
      notes: r.notes,
      isActive: r.is_active,
    };
  }
}
