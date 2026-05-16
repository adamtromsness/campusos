import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AgencyReferralResponseDto,
  AgencyReferralStatus,
  CreateAgencyReferralDto,
  ListAgencyReferralsQueryDto,
  UpdateAgencyReferralDto,
} from './dto/student-services-advanced.dto';

interface AgencyRow {
  id: string;
  referral_id: string;
  agency_name: string;
  agency_contact: string | null;
  agency_phone: string | null;
  agency_email: string | null;
  referral_date: Date;
  reason: string;
  status: string;
  consent_obtained: boolean;
  follow_up_date: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_BASE =
  'SELECT ar.id::text AS id, ar.referral_id::text AS referral_id, ar.agency_name, ' +
  'ar.agency_contact, ar.agency_phone, ar.agency_email, ar.referral_date, ar.reason, ' +
  'ar.status, ar.consent_obtained, ar.follow_up_date, ar.notes, ar.created_at, ar.updated_at ' +
  'FROM svc_agency_referrals ar ' +
  'JOIN svc_referrals r ON r.id = ar.referral_id ';

const ALLOWED_TRANSITIONS: Record<AgencyReferralStatus, AgencyReferralStatus[]> = {
  REFERRED: ['CONTACTED', 'DISCHARGED'],
  CONTACTED: ['ACTIVE_SERVICE', 'DISCHARGED'],
  ACTIVE_SERVICE: ['DISCHARGED'],
  DISCHARGED: [],
};

/**
 * AgencyReferralService — P2-28c external-agency referral workflow.
 *
 * External agency referrals attach to a parent svc_referrals row (the
 * counsellor's internal record) and track the outside-school provider
 * (therapy, social services, etc.) through a 4-state lifecycle
 * REFERRED → CONTACTED → ACTIVE_SERVICE → DISCHARGED.
 *
 * CONSENT GATE: schools cannot release student information to an
 * outside agency without parent consent. consent_obtained is required
 * (true) before the row can transition past CONTACTED into
 * ACTIVE_SERVICE. The Step 6 service refuses the transition until the
 * flag is flipped.
 *
 * School scope is enforced through the parent svc_referrals row via
 * the SELECT base JOIN on svc_referrals. Cross-school agency rows
 * collapse to 404 at the SELECT level.
 */
@Injectable()
export class AgencyReferralService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('External agency referrals are staff-only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Staff actor must have an hr_employees row');
    }
  }

  async list(
    query: ListAgencyReferralsQueryDto,
    actor: ResolvedActor,
  ): Promise<AgencyReferralResponseDto[]> {
    this.assertStaff(actor);
    const filters: string[] = [];
    const args: unknown[] = [];
    if (query.referralId) {
      args.push(query.referralId);
      filters.push('ar.referral_id = $' + args.length + '::uuid');
    }
    if (query.status) {
      args.push(query.status);
      filters.push('ar.status = $' + args.length);
    }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') + ' ' : '';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE + where + 'ORDER BY ar.referral_date DESC',
        ...args,
      );
    })) as AgencyRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<AgencyReferralResponseDto> {
    this.assertStaff(actor);
    return this.loadOrFail(id);
  }

  private async loadOrFail(id: string): Promise<AgencyReferralResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_BASE + 'WHERE ar.id = $1::uuid', id);
    })) as AgencyRow[];
    if (rows.length === 0) throw new NotFoundException('Agency referral not found');
    return this.rowToDto(rows[0]!);
  }

  async create(
    input: CreateAgencyReferralDto,
    actor: ResolvedActor,
  ): Promise<AgencyReferralResponseDto> {
    this.assertStaff(actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const parent = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM svc_referrals WHERE id = $1::uuid',
        input.referralId,
      )) as Array<{ ok: number }>;
      if (parent.length === 0) {
        throw new BadRequestException('referralId does not match a parent referral in this school');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO svc_agency_referrals (id, referral_id, agency_name, agency_contact, ' +
          'agency_phone, agency_email, referral_date, reason, status, consent_obtained, ' +
          'follow_up_date, notes) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8, ' +
          "'REFERRED', $9, $10::date, $11)",
        id,
        input.referralId,
        input.agencyName,
        input.agencyContact ?? null,
        input.agencyPhone ?? null,
        input.agencyEmail ?? null,
        input.referralDate,
        input.reason,
        input.consentObtained ?? false,
        input.followUpDate ?? null,
        input.notes ?? null,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * State-machine PATCH with consent gate. CONTACTED → ACTIVE_SERVICE
   * requires consent_obtained=true. ALLOWED_TRANSITIONS pins the
   * forward path.
   */
  async patch(
    id: string,
    input: UpdateAgencyReferralDto,
    actor: ResolvedActor,
  ): Promise<AgencyReferralResponseDto> {
    this.assertStaff(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const current = (await tx.$queryRawUnsafe(
        'SELECT ar.status, ar.consent_obtained FROM svc_agency_referrals ar ' +
          'JOIN svc_referrals r ON r.id = ar.referral_id ' +
          'WHERE ar.id = $1::uuid FOR UPDATE OF ar',
        id,
      )) as Array<{ status: string; consent_obtained: boolean }>;
      if (current.length === 0) throw new NotFoundException('Agency referral not found');
      const currentStatus = current[0]!.status as AgencyReferralStatus;
      const currentConsent = current[0]!.consent_obtained;

      if (input.status && input.status !== currentStatus) {
        const allowed = ALLOWED_TRANSITIONS[currentStatus];
        if (!allowed.includes(input.status)) {
          throw new BadRequestException(
            'Illegal transition from ' + currentStatus + ' to ' + input.status,
          );
        }
        const willHaveConsent =
          input.consentObtained !== undefined ? input.consentObtained : currentConsent;
        if (input.status === 'ACTIVE_SERVICE' && !willHaveConsent) {
          throw new BadRequestException(
            'Cannot transition to ACTIVE_SERVICE without consent_obtained=true. ' +
              'Parent consent is required before sharing student information with an outside agency.',
          );
        }
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.status !== undefined) {
        params.push(input.status);
        sets.push('status = $' + params.length);
      }
      if (input.consentObtained !== undefined) {
        params.push(input.consentObtained);
        sets.push('consent_obtained = $' + params.length);
      }
      if (input.followUpDate !== undefined) {
        params.push(input.followUpDate);
        sets.push('follow_up_date = $' + params.length + '::date');
      }
      if (input.notes !== undefined) {
        params.push(input.notes);
        sets.push('notes = $' + params.length);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE svc_agency_referrals SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    return this.loadOrFail(id);
  }

  private rowToDto(r: AgencyRow): AgencyReferralResponseDto {
    return {
      id: r.id,
      referralId: r.referral_id,
      agencyName: r.agency_name,
      agencyContact: r.agency_contact,
      agencyPhone: r.agency_phone,
      agencyEmail: r.agency_email,
      referralDate: r.referral_date.toISOString().slice(0, 10),
      reason: r.reason,
      status: r.status as AgencyReferralStatus,
      consentObtained: r.consent_obtained,
      followUpDate: r.follow_up_date ? r.follow_up_date.toISOString().slice(0, 10) : null,
      notes: r.notes,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }
}
