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
import {
  AllergenAlertResponseDto,
  AllergenSeverity,
  CreateDietaryUpdateRequestDto,
  CreateEligibilityApplicationDto,
  CreateProductionRecordDto,
  CreateTemperatureLogDto,
  DetermineEligibilityDto,
  DietaryMealPlan,
  DietaryProfileResponseDto,
  DietaryUpdateChangeType,
  DietaryUpdateRequestResponseDto,
  DietaryUpdateStatus,
  EligibilityApplicationResponseDto,
  EligibilityApplicationType,
  EligibilityCategory,
  EligibilityDeterminationResponseDto,
  EligibilityStatus,
  GenerateUsdaClaimDto,
  MealType,
  ProductionRecordResponseDto,
  ReviewDietaryUpdateDto,
  TempCheckLocation,
  TemperatureLogResponseDto,
  UpdateDietaryProfileDto,
  UsdaClaimResponseDto,
  UsdaClaimStatus,
} from './dto/food-service.dto';

function assertCanManage(actor: ResolvedActor): void {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'STAFF') return;
  throw new ForbiddenException('Only school admins or food service staff can manage this resource');
}

@Injectable()
export class DietaryProfileService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Row-scope: admin/staff sees any student. Parent sees own children only.
   * Student sees own profile.
   */
  private async assertCanReadStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') return;
    if (actor.personType === 'STUDENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) throw new NotFoundException('Dietary profile not found');
      return;
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) throw new NotFoundException('Dietary profile not found');
      return;
    }
    throw new NotFoundException('Dietary profile not found');
  }

  async getByStudent(studentId: string, actor: ResolvedActor): Promise<DietaryProfileResponseDto> {
    await this.assertCanReadStudent(studentId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id, school_id::text AS school_id, ' +
          'dietary_restrictions, allergens, free_meal_eligible, meal_plan_type ' +
          'FROM fds_student_dietary_profiles WHERE student_id = $1::uuid LIMIT 1',
        studentId,
      );
    })) as Array<{
      id: string;
      student_id: string;
      school_id: string;
      dietary_restrictions: string[];
      allergens: string[];
      free_meal_eligible: boolean;
      meal_plan_type: string;
    }>;
    if (rows.length === 0) throw new NotFoundException('Dietary profile not found');
    const r = rows[0]!;
    return {
      id: r.id,
      studentId: r.student_id,
      schoolId: r.school_id,
      dietaryRestrictions: r.dietary_restrictions,
      allergens: r.allergens,
      freeMealEligible: r.free_meal_eligible,
      mealPlanType: r.meal_plan_type as DietaryMealPlan,
    };
  }

  async patch(
    studentId: string,
    input: UpdateDietaryProfileDto,
    actor: ResolvedActor,
  ): Promise<DietaryProfileResponseDto> {
    assertCanManage(actor);
    await this.upsertInner(studentId, input);
    return this.getByStudent(studentId, actor);
  }

  /**
   * Internal upsert used by patch + dietary update request approval.
   * Inserts a fresh profile if none exists yet, otherwise PATCHes
   * the supplied fields. We don't expose this directly — callers go
   * through patch() which gates on assertCanManage.
   */
  private async upsertInner(studentId: string, input: UpdateDietaryProfileDto): Promise<void> {
    const tenant = getCurrentTenant();
    const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id FROM fds_student_dietary_profiles WHERE student_id = $1::uuid LIMIT 1',
        studentId,
      );
    })) as Array<{ id: string }>;

    if (existing.length === 0) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_student_dietary_profiles (id, student_id, school_id, dietary_restrictions, allergens, free_meal_eligible, meal_plan_type) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], $5::text[], $6, $7)',
          generateId(),
          studentId,
          tenant.schoolId,
          input.dietaryRestrictions ?? [],
          input.allergens ?? [],
          input.freeMealEligible ?? false,
          input.mealPlanType ?? 'STANDARD',
        );
      });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.dietaryRestrictions !== undefined) {
      sets.push('dietary_restrictions = $' + (params.length + 1) + '::text[]');
      params.push(input.dietaryRestrictions);
    }
    if (input.allergens !== undefined) {
      sets.push('allergens = $' + (params.length + 1) + '::text[]');
      params.push(input.allergens);
    }
    if (input.freeMealEligible !== undefined) {
      sets.push('free_meal_eligible = $' + (params.length + 1));
      params.push(input.freeMealEligible);
    }
    if (input.mealPlanType !== undefined) {
      sets.push('meal_plan_type = $' + (params.length + 1));
      params.push(input.mealPlanType);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = now()');
    params.push(studentId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE fds_student_dietary_profiles SET ' +
          sets.join(', ') +
          ' WHERE student_id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
  }

  /**
   * Used by EligibilityService.determine to flip free_meal_eligible
   * inside the same tenant tx that lands the determination.
   */
  async setFreeMealEligibleInTx(
    tx: { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    studentId: string,
    eligible: boolean,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    // Try update first; if no row, insert with the right defaults.
    await tx.$executeRawUnsafe(
      'UPDATE fds_student_dietary_profiles SET free_meal_eligible = $1, updated_at = now() WHERE student_id = $2::uuid',
      eligible,
      studentId,
    );
    // Insert defensively in case no row exists yet
    await tx.$executeRawUnsafe(
      'INSERT INTO fds_student_dietary_profiles (id, student_id, school_id, free_meal_eligible, meal_plan_type) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'STANDARD') " +
        'ON CONFLICT (student_id) DO NOTHING',
      generateId(),
      studentId,
      tenant.schoolId,
      eligible,
    );
  }
}

@Injectable()
export class DietaryUpdateRequestService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly profiles: DietaryProfileService,
  ) {}

  async list(
    actor: ResolvedActor,
    args: { status?: DietaryUpdateStatus },
  ): Promise<DietaryUpdateRequestResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['r.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      where.push('r.status = $' + (params.length + 1));
      params.push(args.status);
    }
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      where.push('r.submitted_by = $' + (params.length + 1) + '::uuid');
      params.push(actor.accountId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        DUR_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY r.created_at DESC LIMIT 200',
        ...params,
      );
    })) as DurRow[];
    return rows.map(durRowToDto);
  }

  async submit(
    input: CreateDietaryUpdateRequestDto,
    actor: ResolvedActor,
  ): Promise<DietaryUpdateRequestResponseDto> {
    if (actor.personType !== 'GUARDIAN' && !actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only parents (or staff on their behalf) can submit dietary update requests',
      );
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          input.studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new ForbiddenException(
          'You can only submit dietary update requests for your own children',
        );
      }
    }
    const studentExists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      );
    })) as Array<{ ok: number }>;
    if (studentExists.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }

    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fds_dietary_update_requests (id, school_id, submitted_by, student_id, change_type, proposed_value, reason, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, 'PENDING')",
        id,
        tenant.schoolId,
        actor.accountId,
        input.studentId,
        input.changeType,
        input.proposedValue,
        input.reason ?? null,
      );
    });
    return this.getById(id, actor);
  }

  async getById(id: string, actor: ResolvedActor): Promise<DietaryUpdateRequestResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(DUR_SELECT + 'WHERE r.id = $1::uuid LIMIT 1', id);
    })) as DurRow[];
    if (rows.length === 0) throw new NotFoundException('Dietary update request not found');
    const dto = durRowToDto(rows[0]!);
    if (
      !actor.isSchoolAdmin &&
      actor.personType !== 'STAFF' &&
      dto.submittedBy !== actor.accountId
    ) {
      throw new NotFoundException('Dietary update request not found');
    }
    return dto;
  }

  async review(
    id: string,
    input: ReviewDietaryUpdateDto,
    actor: ResolvedActor,
  ): Promise<DietaryUpdateRequestResponseDto> {
    assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, status, student_id::text AS student_id, change_type, proposed_value FROM fds_dietary_update_requests WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        id: string;
        status: string;
        student_id: string;
        change_type: string;
        proposed_value: string;
      }>;
      if (locked.length === 0) throw new NotFoundException('Request not found');
      if (locked[0]!.status !== 'PENDING') {
        throw new BadRequestException(
          'Request is in status ' + locked[0]!.status + '; only PENDING requests can be reviewed',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE fds_dietary_update_requests SET status = $1, reviewed_by = $2::uuid, reviewed_at = now(), review_notes = $3, updated_at = now() WHERE id = $4::uuid',
        input.status,
        actor.accountId,
        input.reviewNotes ?? null,
        id,
      );

      // On APPROVED, apply the change to the dietary profile
      if (input.status === 'APPROVED') {
        const studentId = locked[0]!.student_id;
        const changeType = locked[0]!.change_type as DietaryUpdateChangeType;
        const value = locked[0]!.proposed_value;
        await this.applyApproved(tx, studentId, changeType, value);
      }
    });
    return this.getById(id, actor);
  }

  private async applyApproved(
    tx: { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    studentId: string,
    changeType: DietaryUpdateChangeType,
    value: string,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    // Ensure profile exists
    await tx.$executeRawUnsafe(
      'INSERT INTO fds_student_dietary_profiles (id, student_id, school_id) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid) ' +
        'ON CONFLICT (student_id) DO NOTHING',
      generateId(),
      studentId,
      tenant.schoolId,
    );

    if (changeType === 'ADD_RESTRICTION') {
      await tx.$executeRawUnsafe(
        'UPDATE fds_student_dietary_profiles SET dietary_restrictions = ' +
          'array_append(dietary_restrictions, $1) WHERE student_id = $2::uuid AND NOT (dietary_restrictions @> ARRAY[$1])',
        value,
        studentId,
      );
    } else if (changeType === 'REMOVE_RESTRICTION') {
      await tx.$executeRawUnsafe(
        'UPDATE fds_student_dietary_profiles SET dietary_restrictions = ' +
          'array_remove(dietary_restrictions, $1) WHERE student_id = $2::uuid',
        value,
        studentId,
      );
    } else if (changeType === 'ADD_ALLERGEN') {
      await tx.$executeRawUnsafe(
        'UPDATE fds_student_dietary_profiles SET allergens = ' +
          'array_append(allergens, $1) WHERE student_id = $2::uuid AND NOT (allergens @> ARRAY[$1])',
        value,
        studentId,
      );
    } else if (changeType === 'REMOVE_ALLERGEN') {
      await tx.$executeRawUnsafe(
        'UPDATE fds_student_dietary_profiles SET allergens = ' +
          'array_remove(allergens, $1) WHERE student_id = $2::uuid',
        value,
        studentId,
      );
    } else if (changeType === 'CHANGE_MEAL_PLAN') {
      await tx.$executeRawUnsafe(
        'UPDATE fds_student_dietary_profiles SET meal_plan_type = $1 WHERE student_id = $2::uuid',
        value,
        studentId,
      );
    }
    // UPDATE_ELIGIBILITY is handled by EligibilityService.determine path,
    // not the dietary update request workflow.
    void this.profiles;
  }
}

@Injectable()
export class AllergenAlertService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listForStudent(studentId: string): Promise<AllergenAlertResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        ALERT_SELECT +
          'WHERE a.student_id = $1::uuid AND a.is_active = true ORDER BY a.severity DESC, a.allergen_code',
        studentId,
      );
    })) as AlertRow[];
    return rows.map(alertRowToDto);
  }

  async listAll(actor: ResolvedActor): Promise<AllergenAlertResponseDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only admins or staff can read the school-wide allergen list');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        ALERT_SELECT +
          'WHERE a.school_id = $1::uuid AND a.is_active = true ORDER BY a.severity DESC, a.allergen_code, a.student_id',
        tenant.schoolId,
      );
    })) as AlertRow[];
    return rows.map(alertRowToDto);
  }

  /**
   * Manual sync from hlth_health_alerts. The Phase 2 Kafka consumer
   * on hlth.allergy_alert.changed replaces this admin-triggered path.
   * Reads hlth_health_alerts directly (the only place Food Service
   * touches hlth_* tables — at sync time only). Upserts on
   * source_health_alert_id so a re-run is idempotent.
   *
   * The hlth_health_alerts shape is forward-compatible: this service
   * tolerates the schema not being present yet (returns 0 if the
   * relation doesn't exist) so the cycle's seed path is the single
   * source of truth until Cycle 10.5 ships the hlth_health_alerts
   * table.
   */
  async syncFromHealth(actor: ResolvedActor): Promise<{ synced: number }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can trigger the allergen sync');
    }
    const tenant = getCurrentTenant();
    let synced = 0;
    try {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT id::text AS id, student_id::text AS student_id, allergen_code, allergen_display_name, severity, is_active ' +
            'FROM hlth_health_alerts WHERE alert_type = $1',
          'ALLERGY',
        );
      })) as Array<{
        id: string;
        student_id: string;
        allergen_code: string;
        allergen_display_name: string;
        severity: string;
        is_active: boolean;
      }>;
      for (const r of rows) {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'INSERT INTO fds_student_allergen_alerts (id, student_id, school_id, allergen_code, allergen_display_name, severity, source_health_alert_id, is_active, last_synced_at) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, now()) ' +
              'ON CONFLICT DO NOTHING',
            generateId(),
            r.student_id,
            tenant.schoolId,
            r.allergen_code,
            r.allergen_display_name,
            r.severity,
            r.id,
            r.is_active,
          );
        });
        synced++;
      }
    } catch (err: unknown) {
      // Health alerts table not available yet — return 0 synced.
      const message = (err as { message?: string }).message ?? '';
      if (!message.includes('does not exist')) throw err;
    }
    return { synced };
  }
}

@Injectable()
export class EligibilityService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly profiles: DietaryProfileService,
  ) {}

  async list(args: {
    status?: EligibilityStatus;
    academicYearId?: string;
  }): Promise<EligibilityApplicationResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['a.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      where.push('a.status = $' + (params.length + 1));
      params.push(args.status);
    }
    if (args.academicYearId) {
      where.push('a.academic_year_id = $' + (params.length + 1) + '::uuid');
      params.push(args.academicYearId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        APP_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY a.submitted_at DESC LIMIT 200',
        ...params,
      );
    })) as AppRow[];
    const out: EligibilityApplicationResponseDto[] = [];
    for (const r of rows) {
      const det = await this.getDetermination(r.id);
      out.push({ ...appRowToDto(r), determination: det ?? undefined });
    }
    return out;
  }

  async submit(
    input: CreateEligibilityApplicationDto,
    actor: ResolvedActor,
  ): Promise<EligibilityApplicationResponseDto> {
    if (actor.personType !== 'GUARDIAN' && !actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only parents (or staff on their behalf) can submit NSLP applications',
      );
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          input.studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new ForbiddenException('You can only submit NSLP applications for your own children');
      }
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fds_eligibility_applications (id, school_id, student_id, submitted_by, academic_year_id, household_size, annual_household_income, snap_benefit_case_number, application_type, status, submitted_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, 'SUBMITTED', now())",
        id,
        tenant.schoolId,
        input.studentId,
        actor.accountId,
        input.academicYearId ?? null,
        input.householdSize,
        input.annualHouseholdIncome ?? null,
        input.snapBenefitCaseNumber ?? null,
        input.applicationType,
      );
    });
    const list = await this.list({});
    return list.find((a) => a.id === id)!;
  }

  async determine(
    applicationId: string,
    input: DetermineEligibilityDto,
    actor: ResolvedActor,
  ): Promise<EligibilityApplicationResponseDto> {
    assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, student_id::text AS student_id, status FROM fds_eligibility_applications WHERE id = $1::uuid FOR UPDATE',
        applicationId,
      )) as Array<{ id: string; student_id: string; status: string }>;
      if (locked.length === 0) throw new NotFoundException('Application not found');
      if (locked[0]!.status !== 'SUBMITTED' && locked[0]!.status !== 'UNDER_REVIEW') {
        throw new BadRequestException(
          'Application is in status ' +
            locked[0]!.status +
            '; only SUBMITTED or UNDER_REVIEW applications can be determined',
        );
      }
      const studentId = locked[0]!.student_id;
      const newStatus = input.eligibilityCategory === 'DENIED' ? 'DENIED' : 'APPROVED';
      await tx.$executeRawUnsafe(
        'UPDATE fds_eligibility_applications SET status = $1, updated_at = now() WHERE id = $2::uuid',
        newStatus,
        applicationId,
      );
      // Upsert determination
      await tx.$executeRawUnsafe(
        'INSERT INTO fds_eligibility_determinations (id, application_id, determined_by, determined_at, eligibility_category, effective_from, effective_to, notification_sent, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE, $4, $5::date, $6::date, false, $7) ' +
          'ON CONFLICT (application_id) DO UPDATE SET eligibility_category = EXCLUDED.eligibility_category, effective_from = EXCLUDED.effective_from, effective_to = EXCLUDED.effective_to, determined_at = CURRENT_DATE, determined_by = EXCLUDED.determined_by, updated_at = now()',
        generateId(),
        applicationId,
        actor.accountId,
        input.eligibilityCategory,
        input.effectiveFrom,
        input.effectiveTo,
        input.notes ?? null,
      );

      const eligible =
        input.eligibilityCategory === 'FREE' || input.eligibilityCategory === 'REDUCED';
      await this.profiles.setFreeMealEligibleInTx(tx as never, studentId, eligible);
    });
    const list = await this.list({});
    return list.find((a) => a.id === applicationId)!;
  }

  private async getDetermination(
    applicationId: string,
  ): Promise<EligibilityDeterminationResponseDto | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, application_id::text AS application_id, determined_by::text AS determined_by, ' +
          'determined_at, eligibility_category, effective_from, effective_to, notification_sent ' +
          'FROM fds_eligibility_determinations WHERE application_id = $1::uuid LIMIT 1',
        applicationId,
      );
    })) as Array<{
      id: string;
      application_id: string;
      determined_by: string;
      determined_at: Date;
      eligibility_category: string;
      effective_from: Date;
      effective_to: Date;
      notification_sent: boolean;
    }>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      applicationId: r.application_id,
      determinedBy: r.determined_by,
      determinedAt: r.determined_at.toISOString().slice(0, 10),
      eligibilityCategory: r.eligibility_category as EligibilityCategory,
      effectiveFrom: r.effective_from.toISOString().slice(0, 10),
      effectiveTo: r.effective_to.toISOString().slice(0, 10),
      notificationSent: r.notification_sent,
    };
  }

  // ── USDA monthly claims ──
  async listClaims(): Promise<UsdaClaimResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, academic_year_id::text AS academic_year_id, ' +
          'month_year, free_meals_count, reduced_meals_count, paid_meals_count, ' +
          'reimbursement_amount, status, submitted_at ' +
          'FROM fds_usda_reimbursement_claims WHERE school_id = $1::uuid ORDER BY month_year DESC',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      academic_year_id: string | null;
      month_year: Date;
      free_meals_count: number;
      reduced_meals_count: number;
      paid_meals_count: number;
      reimbursement_amount: number | null;
      status: string;
      submitted_at: Date | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      academicYearId: r.academic_year_id,
      monthYear: r.month_year.toISOString().slice(0, 10),
      freeMealsCount: r.free_meals_count,
      reducedMealsCount: r.reduced_meals_count,
      paidMealsCount: r.paid_meals_count,
      reimbursementAmount: r.reimbursement_amount !== null ? Number(r.reimbursement_amount) : null,
      status: r.status as UsdaClaimStatus,
      submittedAt: r.submitted_at ? r.submitted_at.toISOString() : null,
    }));
  }

  async generateClaim(
    input: GenerateUsdaClaimDto,
    actor: ResolvedActor,
  ): Promise<UsdaClaimResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can generate USDA reimbursement claims');
    }
    const tenant = getCurrentTenant();
    // Aggregate transactions for the month
    const month = input.monthYear.slice(0, 7); // YYYY-MM
    const counts = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT COUNT(*) FILTER (WHERE payment_method = 'FREE_MEAL')::int AS free_count, " +
          "COUNT(*) FILTER (WHERE payment_method = 'INVOICE' AND total > 0 AND total < 3.00)::int AS reduced_count, " +
          "COUNT(*) FILTER (WHERE payment_method IN ('LUNCH_ACCOUNT', 'CASH', 'STAFF_ACCOUNT'))::int AS paid_count " +
          'FROM fds_meal_transactions WHERE to_char(served_at, $1) = $2',
        'YYYY-MM',
        month,
      );
    })) as Array<{ free_count: number; reduced_count: number; paid_count: number }>;
    const c = counts[0]!;

    // Upsert
    const id = generateId();
    const reimbursement = c.free_count * 4.0 + c.reduced_count * 3.5 + c.paid_count * 0.4;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fds_usda_reimbursement_claims (id, school_id, academic_year_id, month_year, free_meals_count, reduced_meals_count, paid_meals_count, reimbursement_amount, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, 'DRAFT') " +
          'ON CONFLICT (school_id, academic_year_id, month_year) DO UPDATE SET ' +
          'free_meals_count = EXCLUDED.free_meals_count, reduced_meals_count = EXCLUDED.reduced_meals_count, ' +
          'paid_meals_count = EXCLUDED.paid_meals_count, reimbursement_amount = EXCLUDED.reimbursement_amount, ' +
          'updated_at = now()',
        id,
        tenant.schoolId,
        input.academicYearId ?? null,
        month + '-01',
        c.free_count,
        c.reduced_count,
        c.paid_count,
        reimbursement,
      );
    });
    const list = await this.listClaims();
    return list.find((cl) => cl.monthYear.startsWith(month))!;
  }
}

@Injectable()
export class TemperatureLogService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(args: {
    fromDate?: string;
    toDate?: string;
    location?: TempCheckLocation;
    onlyNonCompliant?: boolean;
  }): Promise<TemperatureLogResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['t.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.fromDate) {
      where.push('t.logged_at >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('t.logged_at <= $' + (params.length + 1) + "::date + INTERVAL '1 day'");
      params.push(args.toDate);
    }
    if (args.location) {
      where.push('t.check_location = $' + (params.length + 1));
      params.push(args.location);
    }
    if (args.onlyNonCompliant) where.push('t.is_compliant = false');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        TEMP_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY t.logged_at DESC LIMIT 200',
        ...params,
      );
    })) as TempRow[];
    return rows.map(tempRowToDto);
  }

  async create(
    input: CreateTemperatureLogDto,
    actor: ResolvedActor,
  ): Promise<TemperatureLogResponseDto> {
    assertCanManage(actor);
    if (input.safeRangeMax < input.safeRangeMin) {
      throw new BadRequestException('safeRangeMax must be >= safeRangeMin');
    }
    const isCompliant =
      input.temperatureCelsius >= input.safeRangeMin &&
      input.temperatureCelsius <= input.safeRangeMax;
    if (!isCompliant && !input.correctiveAction) {
      throw new BadRequestException(
        'correctiveAction is required when the temperature is outside the safe range',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fds_temperature_logs (id, school_id, check_location, location_name, temperature_celsius, safe_range_min, safe_range_max, is_compliant, corrective_action, logged_by, logged_at, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid, now(), $11)',
        id,
        tenant.schoolId,
        input.checkLocation,
        input.locationName,
        input.temperatureCelsius,
        input.safeRangeMin,
        input.safeRangeMax,
        isCompliant,
        input.correctiveAction ?? null,
        actor.accountId,
        input.notes ?? null,
      );
    });
    const list = await this.list({});
    return list.find((l) => l.id === id)!;
  }
}

@Injectable()
export class ProductionRecordService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(args: {
    fromDate?: string;
    toDate?: string;
    mealType?: MealType;
  }): Promise<ProductionRecordResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['p.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.fromDate) {
      where.push('p.meal_service_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('p.meal_service_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    if (args.mealType) {
      where.push('p.meal_type = $' + (params.length + 1));
      params.push(args.mealType);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT p.id::text AS id, p.school_id::text AS school_id, p.meal_service_date, p.meal_type, ' +
          'p.menu_item_id::text AS menu_item_id, mi.name AS menu_item_name, ' +
          'p.quantity_prepared, p.quantity_served, p.quantity_leftover, p.quantity_wasted, p.meets_meal_pattern ' +
          'FROM fds_production_records p LEFT JOIN fds_menu_items mi ON mi.id = p.menu_item_id ' +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY p.meal_service_date DESC, p.meal_type LIMIT 200',
        ...params,
      );
    })) as Array<{
      id: string;
      school_id: string;
      meal_service_date: Date;
      meal_type: string;
      menu_item_id: string;
      menu_item_name: string | null;
      quantity_prepared: number;
      quantity_served: number;
      quantity_leftover: number;
      quantity_wasted: number;
      meets_meal_pattern: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      mealServiceDate: r.meal_service_date.toISOString().slice(0, 10),
      mealType: r.meal_type as MealType,
      menuItemId: r.menu_item_id,
      menuItemName: r.menu_item_name,
      quantityPrepared: r.quantity_prepared,
      quantityServed: r.quantity_served,
      quantityLeftover: r.quantity_leftover,
      quantityWasted: r.quantity_wasted,
      meetsMealPattern: r.meets_meal_pattern,
    }));
  }

  async create(
    input: CreateProductionRecordDto,
    actor: ResolvedActor,
  ): Promise<ProductionRecordResponseDto> {
    assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_production_records (id, school_id, meal_service_date, meal_type, menu_item_id, quantity_prepared, quantity_served, quantity_leftover, quantity_wasted, meets_meal_pattern, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::uuid, $6, $7, $8, $9, $10, $11::uuid)',
          id,
          tenant.schoolId,
          input.mealServiceDate,
          input.mealType,
          input.menuItemId,
          input.quantityPrepared,
          input.quantityServed,
          input.quantityLeftover ?? 0,
          input.quantityWasted ?? 0,
          input.meetsMealPattern ?? false,
          actor.accountId,
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
          'A production record already exists for this (date, meal_type, menu_item)',
        );
      }
      throw err;
    }
    const list = await this.list({});
    return list.find((p) => p.id === id)!;
  }
}

// ── shared row helpers ──

interface DurRow {
  id: string;
  student_id: string;
  student_name: string | null;
  submitted_by: string;
  submitted_by_name: string | null;
  change_type: string;
  proposed_value: string;
  reason: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  created_at: Date;
}

const DUR_SELECT =
  'SELECT r.id::text AS id, r.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = r.student_id) AS student_name, ' +
  'r.submitted_by::text AS submitted_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = r.submitted_by) AS submitted_by_name, ' +
  'r.change_type, r.proposed_value, r.reason, r.status, r.reviewed_by::text AS reviewed_by, r.reviewed_at, r.review_notes, r.created_at ' +
  'FROM fds_dietary_update_requests r ';

function durRowToDto(r: DurRow): DietaryUpdateRequestResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    submittedBy: r.submitted_by,
    submittedByName: r.submitted_by_name,
    changeType: r.change_type as DietaryUpdateChangeType,
    proposedValue: r.proposed_value,
    reason: r.reason,
    status: r.status as DietaryUpdateStatus,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    reviewNotes: r.review_notes,
    createdAt: r.created_at.toISOString(),
  };
}

interface AlertRow {
  id: string;
  student_id: string;
  student_name: string | null;
  school_id: string;
  allergen_code: string;
  allergen_display_name: string;
  severity: string;
  source_health_alert_id: string;
  is_active: boolean;
  last_synced_at: Date;
}

const ALERT_SELECT =
  'SELECT a.id::text AS id, a.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = a.student_id) AS student_name, ' +
  'a.school_id::text AS school_id, a.allergen_code, a.allergen_display_name, a.severity, ' +
  'a.source_health_alert_id::text AS source_health_alert_id, a.is_active, a.last_synced_at ' +
  'FROM fds_student_allergen_alerts a ';

function alertRowToDto(r: AlertRow): AllergenAlertResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    schoolId: r.school_id,
    allergenCode: r.allergen_code,
    allergenDisplayName: r.allergen_display_name,
    severity: r.severity as AllergenSeverity,
    sourceHealthAlertId: r.source_health_alert_id,
    isActive: r.is_active,
    lastSyncedAt: r.last_synced_at.toISOString(),
  };
}

interface AppRow {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string | null;
  submitted_by: string;
  household_size: number;
  annual_household_income: number | null;
  snap_benefit_case_number: string | null;
  application_type: string;
  status: string;
  submitted_at: Date;
}

const APP_SELECT =
  'SELECT a.id::text AS id, a.school_id::text AS school_id, a.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = a.student_id) AS student_name, ' +
  'a.submitted_by::text AS submitted_by, a.household_size, a.annual_household_income, ' +
  'a.snap_benefit_case_number, a.application_type, a.status, a.submitted_at ' +
  'FROM fds_eligibility_applications a ';

function appRowToDto(r: AppRow): EligibilityApplicationResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentName: r.student_name,
    submittedBy: r.submitted_by,
    householdSize: r.household_size,
    annualHouseholdIncome:
      r.annual_household_income !== null ? Number(r.annual_household_income) : null,
    snapBenefitCaseNumber: r.snap_benefit_case_number,
    applicationType: r.application_type as EligibilityApplicationType,
    status: r.status as EligibilityStatus,
    submittedAt: r.submitted_at.toISOString(),
  };
}

interface TempRow {
  id: string;
  school_id: string;
  check_location: string;
  location_name: string;
  temperature_celsius: number;
  safe_range_min: number;
  safe_range_max: number;
  is_compliant: boolean;
  corrective_action: string | null;
  logged_by: string;
  logged_by_name: string | null;
  logged_at: Date;
}

const TEMP_SELECT =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, t.check_location, t.location_name, ' +
  't.temperature_celsius, t.safe_range_min, t.safe_range_max, t.is_compliant, t.corrective_action, ' +
  't.logged_by::text AS logged_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = t.logged_by) AS logged_by_name, ' +
  't.logged_at ' +
  'FROM fds_temperature_logs t ';

function tempRowToDto(r: TempRow): TemperatureLogResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    checkLocation: r.check_location as TempCheckLocation,
    locationName: r.location_name,
    temperatureCelsius: Number(r.temperature_celsius),
    safeRangeMin: Number(r.safe_range_min),
    safeRangeMax: Number(r.safe_range_max),
    isCompliant: r.is_compliant,
    correctiveAction: r.corrective_action,
    loggedBy: r.logged_by,
    loggedByName: r.logged_by_name,
    loggedAt: r.logged_at.toISOString(),
  };
}
