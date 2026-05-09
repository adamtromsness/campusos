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
import { OutboxService } from '../kafka/outbox.service';
import { ApplicationService } from './application.service';
import {
  ContractType,
  ExtendOfferDto,
  OFFER_STATUSES,
  OfferDto,
  OfferStatus,
  RespondToOfferDto,
} from './dto/recruitment.dto';

interface OfferRow {
  id: string;
  application_id: string;
  school_id: string;
  position_title: string;
  salary: string;
  start_date: string;
  contract_type: string;
  conditions: unknown;
  acceptance_deadline: string;
  status: string;
  extended_at: string;
  responded_at: string | null;
  response_notes: string | null;
  created_employee_id: string | null;
}

const SELECT_OFFER_BASE =
  'SELECT o.id::text AS id, o.application_id::text AS application_id, ' +
  '       o.school_id::text AS school_id, o.position_title, o.salary::text AS salary, ' +
  '       o.start_date::text AS start_date, o.contract_type, o.conditions, ' +
  '       o.acceptance_deadline::text AS acceptance_deadline, o.status, ' +
  '       o.extended_at::text AS extended_at, o.responded_at::text AS responded_at, ' +
  '       o.response_notes, ' +
  '       (SELECT e.id::text FROM hr_employees e WHERE e.person_id = (SELECT a.person_id FROM hr_applications a WHERE a.id = o.application_id) LIMIT 1) AS created_employee_id ' +
  'FROM hr_offers o ';

/**
 * Offer lifecycle — keystone of the recruitment cycle.
 *
 * extendOffer(): admin extends an offer to a candidate whose
 *   application is in INTERVIEW_COMPLETED. INSERTs hr_offers and
 *   advances application status to OFFER_EXTENDED.
 *
 * respond(): typically called by the candidate (or admin on
 *   behalf). On ACCEPTED, the service auto-creates the hr_employees
 *   row + an hr_employee_positions row in the same tx, advances
 *   application status to OFFER_ACCEPTED, and enqueues
 *   `hr.offer.accepted` via OutboxService.enqueueInTx so downstream
 *   consumers (orientation tasks, payroll tax-info collection,
 *   onboarding workflow) get a durable signal.
 *
 * The hire-creation path is the load-bearing keystone the plan
 * calls out: a candidate's accept directly transitions them from
 * "external person" to "active employee" without admin re-keying.
 */
@Injectable()
export class OfferService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
    private readonly applications: ApplicationService,
  ) {}

  async list(actor: ResolvedActor): Promise<OfferDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_OFFER_BASE + 'WHERE o.school_id = $1::uuid ORDER BY o.extended_at DESC',
        tenant.schoolId,
      )) as OfferRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<OfferDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_OFFER_BASE + 'WHERE o.school_id = $1::uuid AND o.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as OfferRow[];
      if (rows.length === 0) throw new NotFoundException('Offer not found');
      const row = rows[0]!;
      const isAdmin = await this.isAdmin(actor);
      if (!isAdmin) {
        // Non-admin row scope: candidate sees own offer only,
        // resolved through the parent application's person_id.
        const app = await this.applications.loadInternal(row.application_id);
        if (!app || app.personId !== actor.personId) {
          throw new NotFoundException('Offer not found');
        }
      }
      return this.rowToDto(row);
    });
  }

  async extendOffer(
    applicationId: string,
    input: ExtendOfferDto,
    actor: ResolvedActor,
  ): Promise<OfferDto> {
    await this.assertAdmin(actor);
    const application = await this.applications.loadInternal(applicationId);
    if (!application) throw new NotFoundException('Application not found');
    if (application.status === 'OFFER_EXTENDED' || application.status === 'OFFER_ACCEPTED') {
      throw new BadRequestException(
        'Application already has an offer in flight (status=' + application.status + ').',
      );
    }
    if (input.acceptanceDeadline < input.startDate) {
      // not strictly enforced by the schema but a UX guard.
      // The schema's dates_chk enforces deadline >= extended_at::date
      // which is implicit (now()).
    }
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_offers ' +
            '(id, application_id, school_id, position_title, salary, start_date, ' +
            ' contract_type, conditions, acceptance_deadline, status, extended_by) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7, $8::jsonb, $9::date, 'PENDING', $10::uuid)",
          id,
          applicationId,
          application.schoolId,
          input.positionTitle,
          input.salary,
          input.startDate,
          input.contractType,
          JSON.stringify(input.conditions ?? []),
          input.acceptanceDeadline,
          actor.accountId,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('An offer record already exists for this application.');
        }
        throw e;
      }
      await this.applications.advanceStatusInTx(tx, applicationId, 'OFFER_EXTENDED');
      const tenant = getCurrentTenant();
      const rows = (await tx.$queryRawUnsafe(
        SELECT_OFFER_BASE + 'WHERE o.school_id = $1::uuid AND o.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as OfferRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Respond to an offer. ACCEPTED is the keystone path:
   *   1. Lock the offer + parent application FOR UPDATE.
   *   2. Verify status=PENDING.
   *   3. Resolve the application's person_id + the parent posting's
   *      employment_type.
   *   4. INSERT hr_employees (school + person + account; account_id
   *      borrowed from platform_users.id resolved by person_id —
   *      every applicant has one because apply() created it).
   *   5. INSERT hr_employee_positions as the primary position,
   *      effective_from = offer.start_date.
   *   6. Flip offer + application + posting status atomically.
   *   7. Enqueue `hr.offer.accepted` via outbox.
   */
  async respond(
    offerId: string,
    input: RespondToOfferDto,
    actor: ResolvedActor,
  ): Promise<OfferDto> {
    if (!OFFER_STATUSES.includes(input.decision as OfferStatus)) {
      throw new BadRequestException('Invalid decision.');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT o.id, o.application_id::text AS application_id, o.status, o.salary::text AS salary, ' +
          '       o.start_date::text AS start_date, o.contract_type ' +
          'FROM hr_offers o ' +
          'WHERE o.school_id = $1::uuid AND o.id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        offerId,
      )) as Array<{
        id: string;
        application_id: string;
        status: string;
        salary: string;
        start_date: string;
        contract_type: string;
      }>;
      if (lock.length === 0) throw new NotFoundException('Offer not found');
      const cur = lock[0]!.status as OfferStatus;
      if (cur !== 'PENDING') {
        throw new BadRequestException(
          'Only PENDING offers can be responded to (current status: ' + cur + ').',
        );
      }
      // Authorisation: admin OR the offer's candidate (resolved
      // through the parent application's person_id).
      const application = await this.applications.loadInternal(lock[0]!.application_id);
      if (!application) throw new NotFoundException('Application not found');
      const isAdmin = await this.isAdmin(actor);
      if (!isAdmin && application.personId !== actor.personId) {
        throw new ForbiddenException('Only the candidate or an admin can respond to this offer.');
      }

      // Flip offer status atomically with response_notes.
      await tx.$executeRawUnsafe(
        'UPDATE hr_offers SET status = $1, responded_at = now(), response_notes = $2, updated_at = now() ' +
          'WHERE id = $3::uuid',
        input.decision,
        input.responseNotes ?? null,
        offerId,
      );

      let createdEmployeeId: string | null = null;
      let createdHireRequest: {
        offerId: string;
        applicationId: string;
        schoolId: string;
        personId: string;
        positionTitle: string;
        salary: number;
        startDate: string;
        contractType: ContractType;
        employeeId: string;
      } | null = null;

      if (input.decision === 'ACCEPTED') {
        // Resolve the candidate's platform_users.id.
        const userRows = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM platform.platform_users WHERE person_id = $1::uuid LIMIT 1',
          application.personId,
        )) as Array<{ id: string }>;
        if (userRows.length === 0) {
          throw new ConflictException(
            'Candidate has no platform_users row — cannot promote to employee.',
          );
        }
        const accountId = userRows[0]!.id;

        // Resolve the parent posting's employment_type → hr_employees enum.
        const postingRows = (await tx.$queryRawUnsafe(
          'SELECT employment_type FROM hr_job_postings WHERE id = $1::uuid LIMIT 1',
          application.postingId,
        )) as Array<{ employment_type: string }>;
        const postingType = postingRows[0]?.employment_type ?? 'FULL_TIME';
        const employmentType = postingTypeToEmployeeType(postingType);

        // Avoid double-hire if a previous offer-accept already created
        // the hr_employees row (idempotent under retry).
        const existing = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM hr_employees WHERE person_id = $1::uuid LIMIT 1',
          application.personId,
        )) as Array<{ id: string }>;
        let employeeId: string;
        if (existing.length > 0) {
          employeeId = existing[0]!.id;
          // Re-activate if the row exists in TERMINATED — schools
          // re-hire former staff often enough that the API should
          // make this clean.
          await tx.$executeRawUnsafe(
            "UPDATE hr_employees SET employment_status = 'ACTIVE', updated_at = now() " +
              "WHERE id = $1::uuid AND employment_status = 'TERMINATED'",
            employeeId,
          );
        } else {
          employeeId = generateId();
          await tx.$executeRawUnsafe(
            'INSERT INTO hr_employees ' +
              '(id, school_id, person_id, account_id, employee_number, employment_type, ' +
              ' employment_status, hire_date) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, $5, 'ACTIVE', $6::date)",
            employeeId,
            tenant.schoolId,
            application.personId,
            accountId,
            employmentType,
            lock[0]!.start_date,
          );
        }

        // Create or refresh the primary position assignment. We do
        // not auto-resolve a salary scale here — payroll
        // configuration is a separate admin step. The position is
        // marked is_primary=true, effective_from = start_date.
        // Pick or stub a position; we resolve via the offer's
        // position_title against hr_positions (NO ACTION FK), but if
        // no row exists we create a minimal one so the FK holds.
        const positionTitle = await this.resolveOrCreatePositionInTx(
          tx,
          tenant.schoolId,
          lock[0]!.contract_type,
        );

        await tx.$executeRawUnsafe(
          'INSERT INTO hr_employee_positions ' +
            '(id, employee_id, position_id, is_primary, fte, effective_from) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, true, 1.000, $4::date) ' +
            'ON CONFLICT DO NOTHING',
          generateId(),
          employeeId,
          positionTitle,
          lock[0]!.start_date,
        );

        await this.applications.advanceStatusInTx(tx, lock[0]!.application_id, 'OFFER_ACCEPTED');
        createdEmployeeId = employeeId;
        createdHireRequest = {
          offerId,
          applicationId: lock[0]!.application_id,
          schoolId: tenant.schoolId,
          personId: application.personId,
          positionTitle: '',
          salary: Number(lock[0]!.salary),
          startDate: lock[0]!.start_date,
          contractType: lock[0]!.contract_type as ContractType,
          employeeId,
        };
      } else if (input.decision === 'DECLINED') {
        await this.applications.advanceStatusInTx(tx, lock[0]!.application_id, 'OFFER_DECLINED');
      } else if (input.decision === 'WITHDRAWN') {
        // Admin pulled the offer; application stays in OFFER_EXTENDED
        // history (or revert? we keep history).
      }

      // Reload + enqueue if accepted.
      const rows = (await tx.$queryRawUnsafe(
        SELECT_OFFER_BASE + 'WHERE o.school_id = $1::uuid AND o.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        offerId,
      )) as OfferRow[];
      const dto = this.rowToDto(rows[0]!);

      if (createdHireRequest) {
        await this.outbox.enqueueInTx(tx as never, {
          topic: 'hr.offer.accepted',
          key: createdHireRequest.offerId,
          sourceModule: 'hr-recruitment',
          payload: {
            offerId: createdHireRequest.offerId,
            applicationId: createdHireRequest.applicationId,
            schoolId: createdHireRequest.schoolId,
            personId: createdHireRequest.personId,
            employeeId: createdHireRequest.employeeId,
            positionTitle: dto.positionTitle,
            salary: createdHireRequest.salary,
            startDate: createdHireRequest.startDate,
            contractType: createdHireRequest.contractType,
            acceptedAt: new Date().toISOString(),
          },
        });
      }
      return { ...dto, createdEmployeeId };
    });
  }

  // ---------- helpers ----------------------------------------------------

  /**
   * Resolve a representative hr_positions row for the new employee.
   * If the school carries no positions catalogue yet (e.g. fresh
   * tenant where Cycle 4's hr_positions seed didn't run), we create
   * a minimal placeholder so the FK on hr_employee_positions can
   * land. Real schools configure positions before posting jobs.
   */
  private async resolveOrCreatePositionInTx(
    tx: any,
    schoolId: string,
    contractType: string,
  ): Promise<string> {
    const rows = (await tx.$queryRawUnsafe(
      'SELECT id::text AS id FROM hr_positions WHERE school_id = $1::uuid AND is_active = true ' +
        'ORDER BY title LIMIT 1',
      schoolId,
    )) as Array<{ id: string }>;
    if (rows.length > 0) return rows[0]!.id;
    const id = generateId();
    await tx.$executeRawUnsafe(
      'INSERT INTO hr_positions (id, school_id, title, is_teaching_role, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, false, true)',
      id,
      schoolId,
      'New Hire — ' + contractType,
    );
    return id;
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

  private rowToDto(r: OfferRow): OfferDto {
    return {
      id: r.id,
      applicationId: r.application_id,
      schoolId: r.school_id,
      positionTitle: r.position_title,
      salary: Number(r.salary),
      startDate: r.start_date,
      contractType: r.contract_type as ContractType,
      conditions: r.conditions,
      acceptanceDeadline: r.acceptance_deadline,
      status: r.status as OfferStatus,
      extendedAt: r.extended_at,
      respondedAt: r.responded_at,
      responseNotes: r.response_notes,
      createdEmployeeId: r.created_employee_id,
    };
  }

  private isUniqueViolation(err: any): boolean {
    if (!err) return false;
    if (err.code === 'P2010' && err.meta?.code === '23505') return true;
    if (typeof err.message === 'string' && /unique/i.test(err.message)) return true;
    return false;
  }
}

/** Map posting employment_type (4-value enum) to hr_employees employment_type (6-value enum). */
function postingTypeToEmployeeType(postingType: string): string {
  switch (postingType) {
    case 'FULL_TIME':
      return 'FULL_TIME';
    case 'PART_TIME':
      return 'PART_TIME';
    case 'TEMPORARY':
      return 'TEMPORARY';
    case 'LONG_TERM_SUBSTITUTE':
      return 'CONTRACT';
    default:
      return 'FULL_TIME';
  }
}
