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
import {
  ApplicationStatus,
  AwardStatus,
  CreateFinancialAidApplicationDto,
  CreateFinancialAidProgramDto,
  FinancialAidApplicationResponseDto,
  FinancialAidAwardResponseDto,
  FinancialAidProgramResponseDto,
  IncomeBand,
  ListFinancialAidApplicationsQueryDto,
  ReductionType,
  ReviewFinancialAidApplicationDto,
  UpdateFinancialAidApplicationDto,
  UpdateFinancialAidProgramDto,
  WithdrawFinancialAidApplicationDto,
} from './dto/financial-aid.dto';

interface ProgramRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  reduction_type: string;
  reduction_value: string;
  total_fund_amount: string | null;
  fund_remaining: string | null;
  academic_year_id: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ApplicationRow {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string | null;
  program_id: string;
  program_name: string | null;
  guardian_id: string;
  guardian_name: string | null;
  academic_year_id: string;
  household_income_band: string | null;
  supporting_documents: unknown;
  application_statement: string | null;
  status: string;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  award_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AwardRow {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string | null;
  program_id: string;
  program_name: string | null;
  academic_year_id: string;
  award_amount: string;
  approved_by: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PROGRAM_BASE =
  'SELECT id, school_id, name, description, reduction_type, reduction_value::text, ' +
  'total_fund_amount::text, fund_remaining::text, academic_year_id, is_active, created_by, ' +
  'created_at, updated_at FROM pay_financial_aid_programs ';

const SELECT_APPLICATION_BASE =
  'SELECT a.id, a.school_id, a.student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_students ps " +
  ' JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  ' JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = a.student_id LIMIT 1) AS student_name, ' +
  'a.program_id, p.name AS program_name, ' +
  'a.guardian_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_guardians g " +
  ' JOIN platform.iam_person ip ON ip.id = g.person_id WHERE g.id = a.guardian_id LIMIT 1) AS guardian_name, ' +
  'a.academic_year_id, a.household_income_band, a.supporting_documents, a.application_statement, ' +
  'a.status, a.submitted_at, a.reviewed_by, a.reviewed_at, a.reviewer_notes, a.award_id, ' +
  'a.created_at, a.updated_at ' +
  'FROM pay_financial_aid_applications a JOIN pay_financial_aid_programs p ON p.id = a.program_id ';

const SELECT_AWARD_BASE =
  'SELECT a.id, a.school_id, a.student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_students ps " +
  ' JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  ' JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = a.student_id LIMIT 1) AS student_name, ' +
  'a.program_id, p.name AS program_name, a.academic_year_id, a.award_amount::text, a.approved_by, ' +
  'a.effective_from, a.effective_to, a.status, a.notes, a.created_at, a.updated_at ' +
  'FROM pay_financial_aid_awards a JOIN pay_financial_aid_programs p ON p.id = a.program_id ';

function programRowToDto(r: ProgramRow): FinancialAidProgramResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    reductionType: r.reduction_type as ReductionType,
    reductionValue: Number(r.reduction_value),
    totalFundAmount: r.total_fund_amount === null ? null : Number(r.total_fund_amount),
    fundRemaining: r.fund_remaining === null ? null : Number(r.fund_remaining),
    academicYearId: r.academic_year_id,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function applicationRowToDto(r: ApplicationRow): FinancialAidApplicationResponseDto {
  let docs: Array<{ s3Key: string; label: string }> = [];
  try {
    if (Array.isArray(r.supporting_documents)) {
      docs = r.supporting_documents as Array<{ s3Key: string; label: string }>;
    } else if (typeof r.supporting_documents === 'string') {
      docs = JSON.parse(r.supporting_documents);
    } else if (r.supporting_documents && typeof r.supporting_documents === 'object') {
      docs = r.supporting_documents as Array<{ s3Key: string; label: string }>;
    }
  } catch {
    docs = [];
  }
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentName: r.student_name,
    programId: r.program_id,
    programName: r.program_name,
    guardianId: r.guardian_id,
    guardianName: r.guardian_name,
    academicYearId: r.academic_year_id,
    householdIncomeBand: r.household_income_band as IncomeBand | null,
    supportingDocuments: docs,
    applicationStatement: r.application_statement,
    status: r.status as ApplicationStatus,
    submittedAt: r.submitted_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewerNotes: r.reviewer_notes,
    awardId: r.award_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function awardRowToDto(r: AwardRow): FinancialAidAwardResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentName: r.student_name,
    programId: r.program_id,
    programName: r.program_name,
    academicYearId: r.academic_year_id,
    awardAmount: Number(r.award_amount),
    approvedBy: r.approved_by,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    status: r.status as AwardStatus,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * FinancialAidService — Phase 2 Cycle 6 (P2-6).
 *
 * Manages M84 .1 financial-aid programmes, parent-submitted aid
 * applications, and the awards that approval creates. The fund
 * pool decrement is atomic with the award INSERT inside one
 * locked tenant tx so a programme cannot oversell its fund.
 *
 * Authorisation contract:
 *   - fin-002:read   — admin sees all programmes + applications;
 *                      parent (GUARDIAN persona) sees own
 *                      submitted applications + own children's
 *                      applications (row-scoped via sis_guardians.
 *                      person_id = actor.personId).
 *   - fin-002:write  — parent submits + edits own DRAFT
 *                      applications.
 *   - fin-002:admin  — admin creates programmes, reviews
 *                      applications (APPROVE / REJECT / UNDER
 *                      _REVIEW), and creates awards directly.
 *                      Approval creates award + decrements fund_
 *                      remaining atomically inside a locked tx.
 *
 * The schema-side multi-column reviewed_chk on
 * pay_financial_aid_applications keeps reviewed_by + reviewed_at
 * populated together for APPROVED and REJECTED statuses, and
 * the multi-column award_chk requires award_id NOT NULL on
 * APPROVED. The service stamps both atomically inside the same
 * tx that creates the award.
 */
@Injectable()
export class FinancialAidService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /** ───── Programmes ───── */

  async listPrograms(includeInactive = false): Promise<FinancialAidProgramResponseDto[]> {
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_PROGRAM_BASE + 'WHERE school_id = $1::uuid ';
      if (!includeInactive) sql += 'AND is_active = true ';
      sql += 'ORDER BY name';
      return client.$queryRawUnsafe<ProgramRow[]>(sql, schoolId);
    });
    return rows.map(programRowToDto);
  }

  // REVIEW-P2-6 BLOCKING 1 — every read/write is school-scoped via the
  // tenant.schoolId predicate. Cross-school UUID guesses collapse to 404
  // (don't-leak-existence), matching the convention in other Phase 2
  // cycles (P2C1 visitors, P2C5 enrolment, P2C3 health).
  async getProgramById(id: string): Promise<FinancialAidProgramResponseDto> {
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgramRow[]>(
        SELECT_PROGRAM_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        schoolId,
        id,
      );
    });
    if (rows.length === 0)
      throw new NotFoundException('Financial aid programme ' + id + ' not found');
    return programRowToDto(rows[0]!);
  }

  async createProgram(
    body: CreateFinancialAidProgramDto,
    actor: ResolvedActor,
  ): Promise<FinancialAidProgramResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can create financial aid programmes');
    const programId = generateId();
    const schoolId = getCurrentTenant().schoolId;
    const totalFund = body.totalFundAmount ?? null;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO pay_financial_aid_programs ' +
            '(id, school_id, name, description, reduction_type, reduction_value, total_fund_amount, fund_remaining, academic_year_id, is_active, created_by) ' +
            // Wave 1 Finding 9: explicit ::numeric cast on $7. Prisma
            // sends nullable string parameters as TEXT and Postgres
            // won't auto-coerce TEXT → NUMERIC for column assignment
            // (42804). The reused $7 placeholder needs the cast in
            // both positions.
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7::numeric, $7::numeric, $8, $9, $10::uuid)',
          programId,
          schoolId,
          body.name,
          body.description ?? null,
          body.reductionType,
          body.reductionValue.toFixed(2),
          totalFund === null ? null : totalFund.toFixed(2),
          body.academicYearId ?? null,
          body.isActive ?? true,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A financial aid programme with name "' + body.name + '" already exists',
          );
        }
        throw err;
      }
    });
    return this.getProgramById(programId);
  }

  async updateProgram(
    id: string,
    body: UpdateFinancialAidProgramDto,
    actor: ResolvedActor,
  ): Promise<FinancialAidProgramResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can update financial aid programmes');
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (body.name !== undefined) {
      sets.push('name = $' + idx);
      params.push(body.name);
      idx++;
    }
    if (body.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(body.description);
      idx++;
    }
    if (body.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(body.isActive);
      idx++;
    }
    if (body.totalFundAmount !== undefined) {
      // When raising the cap, also raise fund_remaining by the delta so
      // the schema-side fund_chk stays satisfied. School-scoped read
      // (REVIEW-P2-6 BLOCKING 1).
      const existingRows = (await this.tenantPrisma.executeInTenantContext(async (c) =>
        c.$queryRawUnsafe<Array<{ total: string | null; remaining: string | null }>>(
          'SELECT total_fund_amount::text AS total, fund_remaining::text AS remaining FROM pay_financial_aid_programs WHERE school_id = $1::uuid AND id = $2::uuid',
          getCurrentTenant().schoolId,
          id,
        ),
      )) as Array<{ total: string | null; remaining: string | null }>;
      if (existingRows.length === 0)
        throw new NotFoundException('Financial aid programme ' + id + ' not found');
      const oldTotal = Number(existingRows[0]!.total ?? '0');
      const oldRemaining = Number(existingRows[0]!.remaining ?? '0');
      const newTotal = body.totalFundAmount;
      if (newTotal < oldTotal - oldRemaining) {
        throw new BadRequestException(
          'Cannot reduce total_fund_amount below already-allocated awards ($' +
            (oldTotal - oldRemaining).toFixed(2) +
            ')',
        );
      }
      const newRemaining = oldRemaining + (newTotal - oldTotal);
      sets.push('total_fund_amount = $' + idx + '::numeric');
      params.push(newTotal.toFixed(2));
      idx++;
      sets.push('fund_remaining = $' + idx + '::numeric');
      params.push(newRemaining.toFixed(2));
      idx++;
    }
    if (sets.length === 0) return this.getProgramById(id);
    sets.push('updated_at = now()');
    // REVIEW-P2-6 BLOCKING 1 — school_id predicate on the UPDATE so a
    // cross-school UUID guess is a no-op rather than a silent overwrite.
    const schoolIdForUpdate = getCurrentTenant().schoolId;
    params.push(schoolIdForUpdate);
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE pay_financial_aid_programs SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          idx +
          '::uuid AND id = $' +
          (idx + 1) +
          '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Financial aid programme ' + id + ' not found');
    });
    return this.getProgramById(id);
  }

  /** ───── Applications ───── */

  async listApplications(
    query: ListFinancialAidApplicationsQueryDto,
    actor: ResolvedActor,
  ): Promise<FinancialAidApplicationResponseDto[]> {
    // REVIEW-P2-6 BLOCKING 1 — school-scope every list query.
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_APPLICATION_BASE + 'WHERE a.school_id = $1::uuid ';
      const params: unknown[] = [schoolId];
      let idx = 2;
      if (!actor.isSchoolAdmin) {
        // Non-admin: row-scope to applications submitted by the calling
        // guardian OR for any of their children. The sub-select goes
        // through sis_guardians + sis_student_guardians.
        if (actor.personType !== 'GUARDIAN' || !actor.personId) {
          throw new ForbiddenException(
            'Only admins or guardians can list financial aid applications',
          );
        }
        sql +=
          'AND (a.guardian_id IN (SELECT id FROM sis_guardians WHERE person_id = $' +
          idx +
          '::uuid) ';
        params.push(actor.personId);
        idx++;
        sql +=
          ' OR a.student_id IN (SELECT sg.student_id FROM sis_student_guardians sg ' +
          ' JOIN sis_guardians g ON g.id = sg.guardian_id WHERE g.person_id = $' +
          idx +
          '::uuid)) ';
        params.push(actor.personId);
        idx++;
      }
      if (query.status) {
        sql += 'AND a.status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      if (query.academicYearId) {
        sql += 'AND a.academic_year_id = $' + idx + '::uuid ';
        params.push(query.academicYearId);
        idx++;
      }
      if (query.studentId) {
        sql += 'AND a.student_id = $' + idx + '::uuid ';
        params.push(query.studentId);
        idx++;
      }
      sql += 'ORDER BY a.created_at DESC';
      return client.$queryRawUnsafe<ApplicationRow[]>(sql, ...params);
    });
    return rows.map(applicationRowToDto);
  }

  async getApplicationById(
    id: string,
    actor: ResolvedActor,
  ): Promise<FinancialAidApplicationResponseDto> {
    // REVIEW-P2-6 BLOCKING 1 — school-scoped read; cross-school UUID
    // collapses to 404 don't-leak-existence (matches the row-scope
    // convention used by the rest of Phase 2).
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ApplicationRow[]>(
        SELECT_APPLICATION_BASE + 'WHERE a.school_id = $1::uuid AND a.id = $2::uuid',
        schoolId,
        id,
      );
    });
    if (rows.length === 0)
      throw new NotFoundException('Financial aid application ' + id + ' not found');
    const dto = applicationRowToDto(rows[0]!);
    if (!actor.isSchoolAdmin) {
      if (actor.personType !== 'GUARDIAN' || !actor.personId) {
        throw new NotFoundException('Financial aid application ' + id + ' not found');
      }
      // Verify the calling guardian is either the submitter or the
      // student's guardian.
      const allowed = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const r = (await client.$queryRawUnsafe(
          'SELECT 1 FROM sis_guardians g WHERE g.id = $1::uuid AND g.person_id = $2::uuid ' +
            'UNION ALL ' +
            'SELECT 1 FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            ' WHERE sg.student_id = $3::uuid AND g.person_id = $2::uuid LIMIT 1',
          dto.guardianId,
          actor.personId,
          dto.studentId,
        )) as Array<unknown>;
        return r.length > 0;
      });
      if (!allowed) {
        // Don't leak existence to non-related guardians.
        throw new NotFoundException('Financial aid application ' + id + ' not found');
      }
    }
    return dto;
  }

  async createApplication(
    body: CreateFinancialAidApplicationDto,
    actor: ResolvedActor,
  ): Promise<FinancialAidApplicationResponseDto> {
    if (!actor.personId)
      throw new BadRequestException('actor must have a personId to submit an application');
    const schoolId = getCurrentTenant().schoolId;
    const applicationId = generateId();
    const docs = body.supportingDocuments ?? [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate programme is active and in the same school.
      const programRows = (await tx.$queryRawUnsafe(
        'SELECT id, is_active FROM pay_financial_aid_programs WHERE id = $1::uuid AND school_id = $2::uuid',
        body.programId,
        schoolId,
      )) as Array<{ id: string; is_active: boolean }>;
      if (programRows.length === 0)
        throw new BadRequestException(
          'programId does not match a financial aid programme in this school',
        );
      if (!programRows[0]!.is_active)
        throw new BadRequestException('Financial aid programme is not active');

      // REVIEW-P2-6 BLOCKING 2 — validate the supplied studentId belongs
      // to the current school. Without this, a parent could submit a
      // School A application against a School B student/guardian and
      // create cross-school orphan rows.
      const studentRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid',
        body.studentId,
        schoolId,
      )) as Array<{ id: string }>;
      if (studentRows.length === 0)
        throw new BadRequestException('studentId does not match a student in this school');

      // REVIEW-P2-6 BLOCKING 2 — validate the supplied academicYearId
      // belongs to the current school.
      const yearRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM sis_academic_years WHERE id = $1::uuid AND school_id = $2::uuid',
        body.academicYearId,
        schoolId,
      )) as Array<{ id: string }>;
      if (yearRows.length === 0)
        throw new BadRequestException(
          'academicYearId does not match an academic year in this school',
        );

      // REVIEW-P2-6 BLOCKING 2 — guardian/student linkage validation
      // joins through sis_students with the school_id predicate, so a
      // School A actor can never resolve a School B student through a
      // shared guardian record.
      let guardianId: string | null = null;
      if (actor.isSchoolAdmin) {
        // Admin path — accept any guardian for the student, but the
        // join still requires the student to be in this school.
        const gRows = (await tx.$queryRawUnsafe(
          'SELECT g.id FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE sg.student_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
          body.studentId,
          schoolId,
        )) as Array<{ id: string }>;
        if (gRows.length === 0)
          throw new BadRequestException(
            'studentId does not have a guardian on record; admin can manually attach one',
          );
        guardianId = gRows[0]!.id;
      } else {
        const gRows = (await tx.$queryRawUnsafe(
          'SELECT g.id FROM sis_guardians g ' +
            'JOIN sis_student_guardians sg ON sg.guardian_id = g.id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE g.person_id = $1::uuid AND sg.student_id = $2::uuid AND s.school_id = $3::uuid LIMIT 1',
          actor.personId,
          body.studentId,
          schoolId,
        )) as Array<{ id: string }>;
        if (gRows.length === 0)
          throw new ForbiddenException(
            'You can only submit financial aid applications for your own children',
          );
        guardianId = gRows[0]!.id;
      }

      const status: ApplicationStatus = body.submit ? 'SUBMITTED' : 'DRAFT';
      const submittedAt = body.submit ? 'now()' : 'NULL';
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_financial_aid_applications ' +
          '(id, school_id, student_id, program_id, guardian_id, academic_year_id, household_income_band, ' +
          ' supporting_documents, application_statement, status, submitted_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::jsonb, $9, $10, ' +
          submittedAt +
          ')',
        applicationId,
        schoolId,
        body.studentId,
        body.programId,
        guardianId,
        body.academicYearId,
        body.householdIncomeBand ?? null,
        JSON.stringify(docs),
        body.applicationStatement ?? null,
        status,
      );
    });
    return this.getApplicationById(applicationId, actor);
  }

  async updateApplication(
    id: string,
    body: UpdateFinancialAidApplicationDto,
    actor: ResolvedActor,
  ): Promise<FinancialAidApplicationResponseDto> {
    const application = await this.getApplicationById(id, actor);
    if (application.status !== 'DRAFT' && !actor.isSchoolAdmin) {
      throw new BadRequestException(
        'Application is in status ' +
          application.status +
          '; only DRAFT applications can be edited by parents',
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (body.householdIncomeBand !== undefined) {
      sets.push('household_income_band = $' + idx);
      params.push(body.householdIncomeBand);
      idx++;
    }
    if (body.supportingDocuments !== undefined) {
      sets.push('supporting_documents = $' + idx + '::jsonb');
      params.push(JSON.stringify(body.supportingDocuments));
      idx++;
    }
    if (body.applicationStatement !== undefined) {
      sets.push('application_statement = $' + idx);
      params.push(body.applicationStatement);
      idx++;
    }
    if (sets.length === 0) return application;
    sets.push('updated_at = now()');
    // REVIEW-P2-6 BLOCKING 1 — UPDATE carries school_id predicate.
    const schoolIdForUpdate = getCurrentTenant().schoolId;
    params.push(schoolIdForUpdate);
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE pay_financial_aid_applications SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          idx +
          '::uuid AND id = $' +
          (idx + 1) +
          '::uuid',
        ...params,
      );
    });
    return this.getApplicationById(id, actor);
  }

  async submitApplication(
    id: string,
    actor: ResolvedActor,
  ): Promise<FinancialAidApplicationResponseDto> {
    const app = await this.getApplicationById(id, actor);
    if (app.status !== 'DRAFT') {
      throw new BadRequestException(
        'Application is in status ' + app.status + '; only DRAFT applications can be submitted',
      );
    }
    // REVIEW-P2-6 BLOCKING 1 — UPDATE carries school_id predicate.
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "UPDATE pay_financial_aid_applications SET status = 'SUBMITTED', submitted_at = now(), updated_at = now() WHERE school_id = $1::uuid AND id = $2::uuid AND status = 'DRAFT'",
        schoolId,
        id,
      );
    });
    return this.getApplicationById(id, actor);
  }

  async withdrawApplication(
    id: string,
    body: WithdrawFinancialAidApplicationDto,
    actor: ResolvedActor,
  ): Promise<FinancialAidApplicationResponseDto> {
    const app = await this.getApplicationById(id, actor);
    if (app.status === 'WITHDRAWN' || app.status === 'APPROVED' || app.status === 'REJECTED') {
      throw new BadRequestException(
        'Application is in terminal status ' + app.status + ' and cannot be withdrawn',
      );
    }
    const reason = body.reason ?? null;
    // REVIEW-P2-6 BLOCKING 1 — UPDATE carries school_id predicate.
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE pay_financial_aid_applications SET status = 'WITHDRAWN', reviewer_notes = COALESCE(reviewer_notes, '') || CASE WHEN $3::text IS NOT NULL THEN E'\\n[withdrawn] ' || $3::text ELSE '' END, updated_at = now() WHERE school_id = $1::uuid AND id = $2::uuid",
        schoolId,
        id,
        reason,
      );
    });
    return this.getApplicationById(id, actor);
  }

  /**
   * Admin reviews an application. APPROVE creates an award and
   * decrements pay_financial_aid_programs.fund_remaining atomically
   * inside one locked tenant tx so the fund cannot oversell. REJECT
   * marks the application REJECTED. UNDER_REVIEW is a no-action
   * intermediate flag.
   */
  async reviewApplication(
    id: string,
    body: ReviewFinancialAidApplicationDto,
    actor: ResolvedActor,
  ): Promise<FinancialAidApplicationResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can review financial aid applications');
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2-6 BLOCKING 1 — lock query carries the school_id
      // predicate. Cross-school UUID guesses collapse to 404 instead of
      // a service-layer rejection AFTER acquiring the row lock.
      const appRows = (await tx.$queryRawUnsafe(
        'SELECT id, school_id, student_id, program_id, academic_year_id, status FROM pay_financial_aid_applications WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        schoolId,
        id,
      )) as Array<{
        id: string;
        school_id: string;
        student_id: string;
        program_id: string;
        academic_year_id: string;
        status: string;
      }>;
      if (appRows.length === 0)
        throw new NotFoundException('Financial aid application ' + id + ' not found');
      const app = appRows[0]!;
      if (app.status === 'APPROVED' || app.status === 'REJECTED' || app.status === 'WITHDRAWN') {
        throw new BadRequestException(
          'Application is in terminal status ' + app.status + ' and cannot be re-reviewed',
        );
      }

      if (body.action === 'UNDER_REVIEW') {
        if (app.status !== 'SUBMITTED' && app.status !== 'UNDER_REVIEW') {
          throw new BadRequestException(
            'Cannot mark UNDER_REVIEW: application is in status ' + app.status,
          );
        }
        await tx.$executeRawUnsafe(
          "UPDATE pay_financial_aid_applications SET status = 'UNDER_REVIEW', reviewer_notes = $3, updated_at = now() WHERE school_id = $1::uuid AND id = $2::uuid",
          schoolId,
          id,
          body.reviewerNotes ?? null,
        );
        return;
      }

      if (body.action === 'REJECT') {
        await tx.$executeRawUnsafe(
          "UPDATE pay_financial_aid_applications SET status = 'REJECTED', reviewed_by = $3::uuid, reviewed_at = now(), reviewer_notes = $4, updated_at = now() WHERE school_id = $1::uuid AND id = $2::uuid",
          schoolId,
          id,
          actor.accountId,
          body.reviewerNotes ?? null,
        );
        return;
      }

      // APPROVE path — lock programme, validate fund remaining, create
      // award, decrement fund_remaining, link award_id to application.
      // School-scoped programme lookup so we can never decrement a
      // foreign-school programme's fund.
      if (!body.awardAmount || body.awardAmount <= 0)
        throw new BadRequestException('awardAmount > 0 is required to APPROVE an application');
      const programRows = (await tx.$queryRawUnsafe(
        'SELECT id, fund_remaining::text, total_fund_amount::text FROM pay_financial_aid_programs WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        schoolId,
        app.program_id,
      )) as Array<{ id: string; fund_remaining: string | null; total_fund_amount: string | null }>;
      if (programRows.length === 0)
        throw new NotFoundException('Financial aid programme ' + app.program_id + ' not found');
      const program = programRows[0]!;
      const totalFund =
        program.total_fund_amount === null ? null : Number(program.total_fund_amount);
      const remaining = program.fund_remaining === null ? null : Number(program.fund_remaining);
      if (remaining !== null && body.awardAmount > remaining + 0.001) {
        throw new BadRequestException(
          'awardAmount $' +
            body.awardAmount.toFixed(2) +
            ' exceeds programme fund_remaining $' +
            remaining.toFixed(2),
        );
      }

      const awardId = generateId();
      const effectiveFrom = body.awardEffectiveFrom ?? new Date().toISOString().split('T')[0];
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_financial_aid_awards ' +
            '(id, school_id, student_id, program_id, academic_year_id, award_amount, approved_by, effective_from, status, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7::uuid, $8::date, 'ACTIVE', $9)",
          awardId,
          schoolId,
          app.student_id,
          app.program_id,
          app.academic_year_id,
          body.awardAmount.toFixed(2),
          actor.accountId,
          effectiveFrom,
          body.reviewerNotes ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'Student already has an award from this programme for this academic year',
          );
        }
        throw err;
      }

      if (totalFund !== null && remaining !== null) {
        const newRemaining = Number((remaining - body.awardAmount).toFixed(2));
        await tx.$executeRawUnsafe(
          'UPDATE pay_financial_aid_programs SET fund_remaining = $1::numeric, updated_at = now() WHERE school_id = $2::uuid AND id = $3::uuid',
          newRemaining.toFixed(2),
          schoolId,
          app.program_id,
        );
      }

      await tx.$executeRawUnsafe(
        "UPDATE pay_financial_aid_applications SET status = 'APPROVED', reviewed_by = $3::uuid, reviewed_at = now(), reviewer_notes = $4, award_id = $5::uuid, updated_at = now() WHERE school_id = $1::uuid AND id = $2::uuid",
        schoolId,
        id,
        actor.accountId,
        body.reviewerNotes ?? null,
        awardId,
      );
    });
    return this.getApplicationById(id, actor);
  }

  /** ───── Awards ───── */

  async listAwardsForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<FinancialAidAwardResponseDto[]> {
    // REVIEW-P2-6 BLOCKING 1 — school-scope the student lookup AND the
    // awards read so cross-school student UUIDs collapse to 404.
    const schoolId = getCurrentTenant().schoolId;
    if (!actor.isSchoolAdmin) {
      // Parent: must be linked to the student AND the student must be
      // in the current school.
      if (actor.personType !== 'GUARDIAN' || !actor.personId) {
        throw new ForbiddenException('Only admins or linked guardians can list student awards');
      }
      const allowed = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const r = (await client.$queryRawUnsafe(
          'SELECT 1 FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid AND s.school_id = $3::uuid LIMIT 1',
          studentId,
          actor.personId,
          schoolId,
        )) as Array<unknown>;
        return r.length > 0;
      });
      if (!allowed) throw new ForbiddenException('You are not linked to this student');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AwardRow[]>(
        SELECT_AWARD_BASE +
          'WHERE a.school_id = $1::uuid AND a.student_id = $2::uuid ORDER BY a.effective_from DESC',
        schoolId,
        studentId,
      );
    });
    return rows.map(awardRowToDto);
  }

  async getAwardById(id: string): Promise<FinancialAidAwardResponseDto> {
    // REVIEW-P2-6 BLOCKING 1 — school-scoped award read.
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AwardRow[]>(
        SELECT_AWARD_BASE + 'WHERE a.school_id = $1::uuid AND a.id = $2::uuid',
        schoolId,
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Financial aid award ' + id + ' not found');
    return awardRowToDto(rows[0]!);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2002') return true;
  if (e.meta?.code === '23505') return true;
  if (e.message && /23505|unique constraint/i.test(e.message)) return true;
  return false;
}
