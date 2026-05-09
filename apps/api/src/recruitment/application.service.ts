import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { JobPostingService } from './job-posting.service';
import {
  APPLICATION_STATUSES,
  ApplicationDto,
  ApplicationStatus,
  ApplyToJobDto,
  ListApplicationsQueryDto,
  UpdateApplicationDto,
} from './dto/recruitment.dto';

interface ApplicationRow {
  id: string;
  posting_id: string;
  posting_title: string;
  person_id: string;
  applicant_first: string | null;
  applicant_last: string | null;
  applicant_email: string | null;
  status: string;
  resume_s3_key: string | null;
  cover_letter_s3_key: string | null;
  submitted_at: string;
  not_selected_reason: string | null;
  withdrawn_reason: string | null;
}

const SELECT_APPLICATION_BASE =
  'SELECT a.id::text AS id, a.posting_id::text AS posting_id, p.position_title AS posting_title, ' +
  '       a.person_id::text AS person_id, ip.first_name AS applicant_first, ' +
  '       ip.last_name AS applicant_last, pu.email AS applicant_email, ' +
  '       a.status, a.resume_s3_key, a.cover_letter_s3_key, ' +
  '       a.submitted_at::text AS submitted_at, ' +
  '       a.not_selected_reason, a.withdrawn_reason ' +
  'FROM hr_applications a ' +
  'JOIN hr_job_postings p ON p.id = a.posting_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = a.person_id ' +
  'LEFT JOIN platform.platform_users pu ON pu.person_id = a.person_id ';

/**
 * Application lifecycle.
 *
 * `apply()` is the public-facing path: an external candidate POSTs
 * their email + name + optional resume/cover-letter S3 keys. The
 * service looks up an existing iam_person by email (no PII strip —
 * this is the auth identity, not a school user record); if none,
 * it creates an iam_person + a platform_users row tied to the
 * tenant subdomain. Then it INSERTs hr_applications. The caller
 * MUST be authenticated as an external candidate or via the public
 * route — controller-side @Public() flag handles the public path.
 *
 * Admin lifecycle methods (`patch`) require hr-002:write.
 */
@Injectable()
export class ApplicationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly postings: JobPostingService,
  ) {}

  async list(args: ListApplicationsQueryDto, actor: ResolvedActor): Promise<ApplicationDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE p.school_id = $1::uuid';
    if (args.postingId) {
      params.push(args.postingId);
      where += ' AND a.posting_id = $' + params.length + '::uuid';
    }
    if (args.status) {
      params.push(args.status);
      where += ' AND a.status = $' + params.length;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_APPLICATION_BASE + where + ' ORDER BY a.submitted_at DESC',
        ...params,
      )) as ApplicationRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<ApplicationDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_APPLICATION_BASE + 'WHERE p.school_id = $1::uuid AND a.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ApplicationRow[];
      if (rows.length === 0) throw new NotFoundException('Application not found');
      const row = rows[0]!;
      // Non-admin readers see own applications only (matches the
      // P2C3 actor-aware narrowing convention). Admin holders of
      // hr-002:read see every application.
      const isAdmin = await this.isAdmin(actor);
      if (!isAdmin && row.person_id !== actor.personId) {
        throw new NotFoundException('Application not found');
      }
      return this.rowToDto(row);
    });
  }

  async listForPosting(postingId: string, actor: ResolvedActor): Promise<ApplicationDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_APPLICATION_BASE +
          'WHERE p.school_id = $1::uuid AND a.posting_id = $2::uuid ' +
          'ORDER BY a.submitted_at DESC',
        tenant.schoolId,
        postingId,
      )) as ApplicationRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  /**
   * Public application path. The candidate may or may not have an
   * existing iam_person — we look up by email and create on miss.
   * UNIQUE(posting_id, person_id) on hr_applications prevents the
   * same person from applying twice; the service translates the
   * 23505 into a friendly 400.
   */
  async apply(postingId: string, input: ApplyToJobDto): Promise<ApplicationDto> {
    // Validate posting is open. Throws BadRequest on closed / unknown.
    await this.postings.loadOpenForApply(postingId);

    const personId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Look up existing iam_person by email. Cross-school identity
      // already de-duplicates because email is globally unique on
      // platform_users (the auth row), so the candidate's
      // application history follows them across schools.
      const existing = (await tx.$queryRawUnsafe(
        'SELECT ip.id::text AS id ' +
          'FROM platform.iam_person ip ' +
          'JOIN platform.platform_users pu ON pu.person_id = ip.id ' +
          'WHERE LOWER(pu.email) = LOWER($1) LIMIT 1',
        input.applicantEmail,
      )) as Array<{ id: string }>;
      if (existing.length > 0) return existing[0]!.id;
      // Create new iam_person + platform_users (no auth — the
      // candidate hasn't logged in yet). Use a stable email
      // lowercasing to keep the unique constraint clean.
      const newPersonId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO platform.iam_person (id, first_name, last_name, primary_phone, person_type) ' +
          "VALUES ($1::uuid, $2, $3, $4, 'STAFF')",
        newPersonId,
        input.firstName,
        input.lastName,
        input.phone ?? null,
      );
      const newUserId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO platform.platform_users (id, person_id, email, account_status, account_type) ' +
          "VALUES ($1::uuid, $2::uuid, LOWER($3), 'PENDING_VERIFICATION', 'HUMAN')",
        newUserId,
        newPersonId,
        input.applicantEmail,
      );
      return newPersonId;
    });

    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_applications ' +
            '(id, posting_id, person_id, status, resume_s3_key, cover_letter_s3_key) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', $4, $5)",
          id,
          postingId,
          personId,
          input.resumeS3Key ?? null,
          input.coverLetterS3Key ?? null,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('You have already applied to this posting.');
        }
        throw e;
      }
      const tenant = getCurrentTenant();
      const rows = (await tx.$queryRawUnsafe(
        SELECT_APPLICATION_BASE + 'WHERE p.school_id = $1::uuid AND a.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ApplicationRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateApplicationDto,
    actor: ResolvedActor,
  ): Promise<ApplicationDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT a.id, a.status FROM hr_applications a ' +
          'JOIN hr_job_postings p ON p.id = a.posting_id ' +
          'WHERE p.school_id = $1::uuid AND a.id = $2::uuid FOR UPDATE OF a',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Application not found');
      const cur = lock[0]!.status as ApplicationStatus;

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.status !== undefined && input.status !== cur) {
        if (!APPLICATION_STATUSES.includes(input.status)) {
          throw new BadRequestException('Invalid application status target.');
        }
        push('status', input.status);
      }
      if (input.notSelectedReason !== undefined)
        push('not_selected_reason', input.notSelectedReason);
      if (input.withdrawnReason !== undefined) push('withdrawn_reason', input.withdrawnReason);

      if (sets.length === 0) return this.getById(id, actor);
      sets.push('updated_at = now()');
      values.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE hr_applications SET ' + sets.join(', ') + ' WHERE id = $' + n + '::uuid',
        ...values,
      );
      return this.getById(id, actor);
    });
  }

  /**
   * Internal advance — used by InterviewService.schedule to flip
   * SUBMITTED/UNDER_REVIEW/SCREENING -> INTERVIEW_SCHEDULED, by
   * OfferService.extendOffer to flip INTERVIEW_COMPLETED ->
   * OFFER_EXTENDED, etc. Admin gate already enforced by the caller.
   */
  async advanceStatusInTx(
    tx: any,
    applicationId: string,
    target: ApplicationStatus,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      'UPDATE hr_applications SET status = $1, updated_at = now() WHERE id = $2::uuid',
      target,
      applicationId,
    );
  }

  /**
   * Loader used by InterviewService + OfferService — returns the
   * application with the parent posting's school_id so callers can
   * verify tenant scope before mutating.
   */
  async loadInternal(applicationId: string): Promise<{
    id: string;
    postingId: string;
    schoolId: string;
    personId: string;
    status: ApplicationStatus;
  } | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.posting_id::text AS posting_id, ' +
          '       p.school_id::text AS school_id, a.person_id::text AS person_id, a.status ' +
          'FROM hr_applications a ' +
          'JOIN hr_job_postings p ON p.id = a.posting_id ' +
          'WHERE p.school_id = $1::uuid AND a.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        applicationId,
      )) as Array<{
        id: string;
        posting_id: string;
        school_id: string;
        person_id: string;
        status: string;
      }>;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        id: r.id,
        postingId: r.posting_id,
        schoolId: r.school_id,
        personId: r.person_id,
        status: r.status as ApplicationStatus,
      };
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (await this.isAdmin(actor)) return;
    throw new ForbiddenException(
      'Recruitment administration requires hr-002:write or school admin.',
    );
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-002:admin',
      'hr-002:write',
    ]);
  }

  private rowToDto(r: ApplicationRow): ApplicationDto {
    const name =
      r.applicant_first || r.applicant_last
        ? [r.applicant_first, r.applicant_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      postingId: r.posting_id,
      postingTitle: r.posting_title,
      personId: r.person_id,
      applicantName: name,
      applicantEmail: r.applicant_email,
      status: r.status as ApplicationStatus,
      resumeS3Key: r.resume_s3_key,
      coverLetterS3Key: r.cover_letter_s3_key,
      submittedAt: r.submitted_at,
      notSelectedReason: r.not_selected_reason,
      withdrawnReason: r.withdrawn_reason,
    };
  }

  private isUniqueViolation(err: any): boolean {
    if (!err) return false;
    if (err.code === 'P2010' && err.meta?.code === '23505') return true;
    if (typeof err.message === 'string' && /unique/i.test(err.message)) return true;
    return false;
  }
}
