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
import {
  CreateScreeningReferralDto,
  ListReferralsQueryDto,
  REFERRAL_STATUSES,
  ReferralOutcome,
  ReferralStatus,
  ReferralType,
  ScreeningReferralDto,
  UpdateScreeningReferralDto,
} from '../records/dto/health-advanced.dto';

interface ReferralRow {
  id: string;
  screening_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  school_id: string;
  referral_type: string;
  reason: string;
  referred_to: string | null;
  referral_date: string;
  follow_up_date: string | null;
  follow_up_outcome: string | null;
  follow_up_notes: string | null;
  status: string;
  created_by: string;
  created_by_first: string | null;
  created_by_last: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_REFERRAL_BASE =
  'SELECT r.id::text AS id, r.screening_id::text AS screening_id, ' +
  '       r.student_id::text AS student_id, ' +
  '       sip.first_name AS student_first, sip.last_name AS student_last, ' +
  '       r.school_id::text AS school_id, r.referral_type, r.reason, r.referred_to, ' +
  '       r.referral_date::text AS referral_date, ' +
  '       r.follow_up_date::text AS follow_up_date, ' +
  '       r.follow_up_outcome, r.follow_up_notes, r.status, ' +
  '       r.created_by::text AS created_by, ' +
  '       cip.first_name AS created_by_first, cip.last_name AS created_by_last, ' +
  '       r.created_at::text AS created_at, r.updated_at::text AS updated_at ' +
  'FROM hlth_screening_referrals r ' +
  'LEFT JOIN sis_students sst ON sst.id = r.student_id ' +
  'LEFT JOIN platform.platform_students sps ON sps.id = sst.platform_student_id ' +
  'LEFT JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN platform.platform_users cu ON cu.id = r.created_by ' +
  'LEFT JOIN platform.iam_person cip ON cip.id = cu.person_id ';

@Injectable()
export class ScreeningReferralService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Nurse creates a referral from a hlth_screenings record. We resolve
   * the parent screening to grab its school_id + student_id and verify
   * the screening is in this tenant.
   */
  async createFromScreening(
    screeningId: string,
    input: CreateScreeningReferralDto,
    actor: ResolvedActor,
  ): Promise<ScreeningReferralDto> {
    await this.assertNurseScope(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const screening = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, student_id::text AS student_id ' +
          'FROM hlth_screenings WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        screeningId,
      )) as Array<{ id: string; school_id: string; student_id: string }>;
      if (screening.length === 0) {
        throw new BadRequestException('Screening not found in this school');
      }

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO hlth_screening_referrals ' +
          '(id, screening_id, student_id, school_id, referral_type, reason, referred_to, ' +
          ' referral_date, follow_up_date, status, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9::date, ' +
          " 'REFERRED', $10::uuid)",
        id,
        screeningId,
        screening[0]!.student_id,
        tenant.schoolId,
        input.referralType,
        input.reason,
        input.referredTo ?? null,
        input.referralDate,
        input.followUpDate ?? null,
        actor.accountId,
      );

      // Mark the parent screening as having follow-up required (if it
      // wasn't already) so the dashboard surfaces the dependency.
      await tx.$executeRawUnsafe(
        'UPDATE hlth_screenings SET follow_up_required = true, updated_at = now() ' +
          'WHERE id = $1::uuid',
        screeningId,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_REFERRAL_BASE + 'WHERE r.id = $1::uuid LIMIT 1',
        id,
      )) as ReferralRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async list(args: ListReferralsQueryDto): Promise<ScreeningReferralDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(args.limit ?? 100, 500);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE r.school_id = $1::uuid';
    if (args.status) {
      params.push(args.status);
      where += ' AND r.status = $' + params.length;
    }
    if (args.referralType) {
      params.push(args.referralType);
      where += ' AND r.referral_type = $' + params.length;
    }
    if (args.studentId) {
      params.push(args.studentId);
      where += ' AND r.student_id = $' + params.length + '::uuid';
    }

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REFERRAL_BASE + where + ' ORDER BY r.referral_date DESC LIMIT ' + limit,
        ...params,
      )) as ReferralRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<ScreeningReferralDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REFERRAL_BASE + 'WHERE r.school_id = $1::uuid AND r.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ReferralRow[];
      if (rows.length === 0) throw new NotFoundException('Referral not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateScreeningReferralDto,
    actor: ResolvedActor,
  ): Promise<ScreeningReferralDto> {
    await this.assertNurseScope(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status, follow_up_date, follow_up_outcome ' +
          'FROM hlth_screening_referrals ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{
        id: string;
        status: string;
        follow_up_date: string | null;
        follow_up_outcome: string | null;
      }>;
      if (lock.length === 0) throw new NotFoundException('Referral not found');

      const cur = lock[0]!;
      const targetStatus = (input.status ?? cur.status) as ReferralStatus;
      const targetOutcome = input.followUpOutcome ?? cur.follow_up_outcome;
      const targetFollowUpDate = input.followUpDate ?? cur.follow_up_date;

      // Schema CHECK requires follow_up_date + follow_up_outcome both
      // populated when status=FOLLOW_UP_COMPLETE. App-layer pre-check
      // gives a friendlier 400.
      if (targetStatus === 'FOLLOW_UP_COMPLETE') {
        if (!targetFollowUpDate || !targetOutcome) {
          throw new BadRequestException(
            'FOLLOW_UP_COMPLETE requires both follow_up_date and follow_up_outcome to be set.',
          );
        }
      }
      if (!REFERRAL_STATUSES.includes(targetStatus)) {
        throw new BadRequestException('Invalid status target ' + targetStatus);
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.status !== undefined) push('status', input.status);
      if (input.followUpOutcome !== undefined) push('follow_up_outcome', input.followUpOutcome);
      if (input.followUpDate !== undefined) {
        sets.push('follow_up_date = $' + n + '::date');
        values.push(input.followUpDate);
        n += 1;
      }
      if (input.followUpNotes !== undefined) push('follow_up_notes', input.followUpNotes);
      if (input.referredTo !== undefined) push('referred_to', input.referredTo);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_REFERRAL_BASE + 'WHERE r.id = $1::uuid LIMIT 1',
          id,
        )) as ReferralRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);

      await tx.$executeRawUnsafe(
        'UPDATE hlth_screening_referrals SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          n +
          '::uuid AND id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_REFERRAL_BASE + 'WHERE r.id = $1::uuid LIMIT 1',
        id,
      )) as ReferralRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Referrals where status='REFERRED' AND follow_up_date < today —
   * the partial INDEX hlth_referrals_overdue_idx is the seek path.
   */
  async overdue(): Promise<ScreeningReferralDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REFERRAL_BASE +
          "WHERE r.school_id = $1::uuid AND r.status = 'REFERRED' " +
          '  AND r.follow_up_date IS NOT NULL AND r.follow_up_date < CURRENT_DATE ' +
          'ORDER BY r.follow_up_date ASC',
        tenant.schoolId,
      )) as ReferralRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  private async assertNurseScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hlt-004:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Creating or updating screening referrals requires hlt-004:write or school admin.',
      );
    }
  }

  private rowToDto(r: ReferralRow): ScreeningReferralDto {
    const studentName =
      r.student_first || r.student_last
        ? [r.student_first, r.student_last].filter(Boolean).join(' ')
        : null;
    const createdByName =
      r.created_by_first || r.created_by_last
        ? [r.created_by_first, r.created_by_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      screeningId: r.screening_id,
      studentId: r.student_id,
      studentName,
      schoolId: r.school_id,
      referralType: r.referral_type as ReferralType,
      reason: r.reason,
      referredTo: r.referred_to,
      referralDate: r.referral_date,
      followUpDate: r.follow_up_date,
      followUpOutcome: r.follow_up_outcome as ReferralOutcome | null,
      followUpNotes: r.follow_up_notes,
      status: r.status as ReferralStatus,
      createdBy: r.created_by,
      createdByName,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
