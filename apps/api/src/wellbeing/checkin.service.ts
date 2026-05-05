import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  AlertType,
  CheckinResponseDto,
  ListCheckinsQueryDto,
  SubmitCheckinDto,
  WellbeingDomain,
  WellbeingResponseDto,
  QuestionType,
} from './dto/wellbeing.dto';

interface CheckinRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  template_id: string;
  template_name: string | null;
  deployment_id: string | null;
  completed_at: string | null;
  flagged_for_follow_up: boolean;
  assigned_counselor_id: string | null;
  counselor_first: string | null;
  counselor_last: string | null;
  created_at: string;
  updated_at: string;
}

interface ResponseRow {
  id: string;
  checkin_id: string;
  question_id: string;
  numeric_response: number | null;
  text_response: string | null;
  created_at: string;
}

interface QuestionLookupRow {
  id: string;
  template_id: string;
  question_text: string;
  question_type: string;
  domain: string;
}

const SELECT_CHECKIN_BASE =
  'SELECT c.id::text AS id, c.school_id::text AS school_id, ' +
  'c.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'c.template_id::text AS template_id, t.name AS template_name, ' +
  'c.deployment_id::text AS deployment_id, ' +
  'TO_CHAR(c.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'c.flagged_for_follow_up, ' +
  'c.assigned_counselor_id::text AS assigned_counselor_id, ' +
  'cp.first_name AS counselor_first, cp.last_name AS counselor_last, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_wellbeing_checkins c ' +
  'JOIN sis_students s ON s.id = c.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN svc_wellbeing_survey_templates t ON t.id = c.template_id ' +
  'LEFT JOIN hr_employees ce ON ce.id = c.assigned_counselor_id ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = ce.person_id ';

const SELECT_RESPONSE_BASE =
  'SELECT r.id::text AS id, r.checkin_id::text AS checkin_id, ' +
  'r.question_id::text AS question_id, r.numeric_response, r.text_response, ' +
  'TO_CHAR(r.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM svc_wellbeing_responses r ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToCheckinDto(r: CheckinRow): CheckinResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentName: fullName(r.student_first, r.student_last),
    templateId: r.template_id,
    templateName: r.template_name,
    deploymentId: r.deployment_id,
    completedAt: r.completed_at,
    flaggedForFollowUp: r.flagged_for_follow_up,
    assignedCounselorId: r.assigned_counselor_id,
    assignedCounselorName: fullName(r.counselor_first, r.counselor_last),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToResponseDto(r: ResponseRow): WellbeingResponseDto {
  return {
    id: r.id,
    checkinId: r.checkin_id,
    questionId: r.question_id,
    numericResponse: r.numeric_response,
    textResponse: r.text_response,
    createdAt: r.created_at,
  };
}

/**
 * Apply the per-persona DTO strip. Teachers (cou-004:read holders that
 * are not counsellors and not students) see only aggregated trend
 * data — the service strips student name + assigned counsellor + the
 * `flagged_for_follow_up` flag from every check-in row before
 * returning. Pending vs completed status is preserved (`completedAt`)
 * so the teacher dashboard can still display "1 of 1 completed". The
 * Step 6 counsellor / admin UI receives the full DTO; Step 7 student UI
 * receives own-only DTOs unstripped.
 */
function stripCheckinForTeacher(dto: CheckinResponseDto): CheckinResponseDto {
  return {
    ...dto,
    studentId: '',
    studentName: null,
    assignedCounselorId: null,
    assignedCounselorName: null,
    flaggedForFollowUp: false,
  };
}

@Injectable()
export class CheckinService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-004:write — same canonical
   * counsellor signal SurveyTemplateService + DeploymentService use.
   */
  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-004:write',
    ]);
  }

  /**
   * Resolve the calling student's sis_students.id from actor.personId.
   * Returns null when the actor is not a STUDENT persona or does not
   * have a corresponding sis_students row in this tenant.
   */
  private async resolveCallerStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
    });
    return rows.length > 0 ? rows[0]!.id : null;
  }

  async list(query: ListCheckinsQueryDto, actor: ResolvedActor): Promise<CheckinResponseDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(query.limit ?? 100, 200);
    const isCounsellor = await this.hasCounsellorScope(actor);
    const sql: string[] = [SELECT_CHECKIN_BASE, 'WHERE c.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    let idx = 2;

    if (actor.isSchoolAdmin) {
      // Admin sees everything in the school.
    } else if (isCounsellor) {
      // Counsellor (non-admin Staff) — caseload-linked students only.
      // Either assigned_counselor_id=me OR student is on an ACTIVE
      // caseload row owned by me.
      if (!actor.employeeId) {
        return [];
      }
      sql.push(
        'AND (c.assigned_counselor_id = $' +
          idx +
          '::uuid OR c.student_id IN (' +
          'SELECT student_id FROM svc_caseloads WHERE counselor_id = $' +
          idx +
          "::uuid AND status = 'ACTIVE')) ",
      );
      params.push(actor.employeeId);
      idx++;
    } else if (actor.personType === 'STUDENT') {
      // Student — own check-ins only.
      const myStudentId = await this.resolveCallerStudentId(actor);
      if (!myStudentId) return [];
      sql.push('AND c.student_id = $' + idx + '::uuid ');
      params.push(myStudentId);
      idx++;
    } else if (actor.personType === 'STAFF') {
      // Non-counsellor STAFF (a teacher) — aggregated trends only.
      // Service strips per-student detail at row mapping. Teachers see
      // every row in the tenant (count + completed/pending status)
      // but with student identity scrubbed.
    } else {
      // Parent / unknown — should already 403 at the gate, but guard.
      return [];
    }

    if (query.pending === 'true') sql.push('AND c.completed_at IS NULL ');
    if (query.pending === 'false') sql.push('AND c.completed_at IS NOT NULL ');
    if (query.flagged === 'true') sql.push('AND c.flagged_for_follow_up = true ');
    if (query.deploymentId) {
      sql.push('AND c.deployment_id = $' + idx + '::uuid ');
      params.push(query.deploymentId);
      idx++;
    }
    if (query.studentId) {
      sql.push('AND c.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    sql.push('ORDER BY c.completed_at DESC NULLS FIRST, c.created_at DESC LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CheckinRow[]>(sql.join(''), ...params);
    });
    const dtos = rows.map(rowToCheckinDto);
    if (!actor.isSchoolAdmin && !isCounsellor && actor.personType === 'STAFF') {
      return dtos.map(stripCheckinForTeacher);
    }
    return dtos;
  }

  async getById(id: string, actor: ResolvedActor): Promise<CheckinResponseDto> {
    // Teacher persona check fires BEFORE loadOrFail so non-counsellor
    // STAFF get a clear 403 with the redirect message instead of a
    // generic 404 from the row-scope filter.
    const isCounsellor = await this.hasCounsellorScope(actor);
    if (!actor.isSchoolAdmin && !isCounsellor && actor.personType === 'STAFF') {
      throw new ForbiddenException(
        'Teachers see aggregated wellbeing trends only — individual check-in detail is restricted to the counselling team.',
      );
    }
    const dto = await this.loadOrFail(id, actor);
    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ResponseRow[]>(
        SELECT_RESPONSE_BASE + 'WHERE r.checkin_id = $1::uuid ORDER BY r.created_at ASC',
        id,
      );
    });
    const responses = studentRows.map(rowToResponseDto);
    return { ...dto, responses };
  }

  /**
   * STUDENT-FACING KEYSTONE — submit responses to a PENDING check-in.
   * Validates every template question has a response. Bulk-INSERTs
   * responses inside one tenant tx. Stamps completed_at=now(). Runs
   * the alert evaluation logic. Updates the deployment's
   * total_completed counter. Emits svc.wellbeing.alert.created per
   * fired alert outside the tx so a broker hiccup doesn't roll back
   * the student's submission.
   *
   * Row scope: students may only submit their own check-ins. Admins
   * may submit on behalf of any student (used by Step 8 CAT). The
   * counsellor-scope path is intentionally NOT a submitter — counsellors
   * triage alerts but do not answer questions on a student's behalf.
   */
  async submit(
    checkinId: string,
    input: SubmitCheckinDto,
    actor: ResolvedActor,
  ): Promise<CheckinResponseDto> {
    const tenant = getCurrentTenant();

    // Resolve caller student id (null for non-students). Admins bypass.
    const callerStudentId = await this.resolveCallerStudentId(actor);
    if (!actor.isSchoolAdmin && !callerStudentId) {
      throw new ForbiddenException(
        'Only the student who owns this check-in (or an admin) can submit responses',
      );
    }

    // Load + validate the check-in pre-tx so we can fail fast with a
    // clear error before opening any transaction.
    const checkinRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          student_id: string;
          template_id: string;
          deployment_id: string | null;
          completed_at: string | null;
        }>
      >(
        'SELECT student_id::text AS student_id, template_id::text AS template_id, ' +
          'deployment_id::text AS deployment_id, completed_at ' +
          'FROM svc_wellbeing_checkins WHERE id = $1::uuid AND school_id = $2::uuid',
        checkinId,
        tenant.schoolId,
      );
    });
    if (checkinRows.length === 0) throw new NotFoundException('Check-in ' + checkinId);
    const checkin = checkinRows[0]!;

    if (!actor.isSchoolAdmin && callerStudentId !== checkin.student_id) {
      throw new ForbiddenException('You can only submit your own check-in');
    }
    if (checkin.completed_at !== null) {
      throw new BadRequestException(
        'This check-in has already been submitted. Cannot resubmit a completed check-in.',
      );
    }

    // Load the template's questions so we can verify every required
    // question has a response and so the alert evaluation has the
    // (domain, type) context per response.
    const questionRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<QuestionLookupRow[]>(
        'SELECT id::text AS id, template_id::text AS template_id, question_text, question_type, domain ' +
          'FROM svc_wellbeing_questions WHERE template_id = $1::uuid',
        checkin.template_id,
      );
    })) as QuestionLookupRow[];
    const questionsById = new Map(questionRows.map((q) => [q.id, q]));
    if (questionRows.length === 0) {
      throw new BadRequestException(
        'Template has no questions. Cannot submit a check-in against an empty template.',
      );
    }

    // Validate input shape:
    //   - every question_id in the template appears in the input
    //   - no foreign question_ids
    //   - response_shape: numeric or text required
    const inputByQuestion = new Map<string, { numericResponse?: number; textResponse?: string }>();
    for (const r of input.responses) {
      if (!questionsById.has(r.questionId)) {
        throw new BadRequestException(
          'Response references questionId ' +
            r.questionId +
            ' which does not belong to this check-in template',
        );
      }
      if (
        (r.numericResponse === undefined || r.numericResponse === null) &&
        (r.textResponse === undefined ||
          r.textResponse === null ||
          r.textResponse.trim().length === 0)
      ) {
        throw new BadRequestException(
          'Response for question ' + r.questionId + ' must include numericResponse or textResponse',
        );
      }
      inputByQuestion.set(r.questionId, {
        numericResponse: r.numericResponse,
        textResponse: r.textResponse,
      });
    }
    for (const q of questionRows) {
      if (!inputByQuestion.has(q.id)) {
        throw new BadRequestException(
          'Missing response for question "' +
            q.question_text +
            '" (id ' +
            q.id +
            '). Every template question must have a response on submit.',
        );
      }
    }

    // Bulk-INSERT responses + mark check-in completed + run alert
    // evaluation + bump deployment counter, all in one tenant tx.
    const triggers: AlertTrigger[] = [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the check-in row so a parallel submit can't double-stamp.
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT completed_at FROM svc_wellbeing_checkins WHERE id = $1::uuid FOR UPDATE',
        checkinId,
      )) as Array<{ completed_at: string | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Check-in ' + checkinId);
      if (lockRows[0]!.completed_at !== null) {
        throw new BadRequestException(
          'This check-in has already been submitted. Cannot resubmit a completed check-in.',
        );
      }

      // Bulk-INSERT responses, capturing the inserted response ids so
      // alerts can FK them.
      const responseIdByQuestion = new Map<string, string>();
      for (const q of questionRows) {
        const inp = inputByQuestion.get(q.id)!;
        const respId = generateId();
        const numeric = inp.numericResponse ?? null;
        const text = inp.textResponse ?? null;
        await tx.$executeRawUnsafe(
          'INSERT INTO svc_wellbeing_responses (id, checkin_id, question_id, numeric_response, text_response) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
          respId,
          checkinId,
          q.id,
          numeric,
          text,
        );
        responseIdByQuestion.set(q.id, respId);

        // Alert evaluation per response. SELF_HARM_INDICATOR takes
        // precedence over FEELS_UNSAFE on the same response so a
        // single SAFETY+SCALE_1_5+numeric=1 row creates one alert,
        // not two.
        const alertType = evaluateResponse(
          q.domain as WellbeingDomain,
          q.question_type as QuestionType,
          numeric,
        );
        if (alertType !== null) {
          triggers.push({
            alertType,
            responseId: respId,
            questionId: q.id,
            questionText: q.question_text,
            studentId: checkin.student_id,
          });
        }
      }

      // Stamp completed_at + flagged_for_follow_up.
      const flagged = triggers.length > 0;
      await tx.$executeRawUnsafe(
        'UPDATE svc_wellbeing_checkins SET completed_at = now(), flagged_for_follow_up = $2, updated_at = now() ' +
          'WHERE id = $1::uuid',
        checkinId,
        flagged,
      );

      // Insert alert rows.
      for (const t of triggers) {
        await tx.$executeRawUnsafe(
          'INSERT INTO svc_wellbeing_alerts (id, student_id, response_id, alert_type, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'NEW')",
          generateId(),
          t.studentId,
          t.responseId,
          t.alertType,
        );
      }

      // Bump deployment's total_completed if this check-in belongs to one.
      if (checkin.deployment_id) {
        await tx.$executeRawUnsafe(
          'UPDATE svc_wellbeing_deployments SET total_completed = COALESCE(total_completed, 0) + 1, updated_at = now() ' +
            'WHERE id = $1::uuid',
          checkin.deployment_id,
        );
      }
    });

    // Emit per-trigger alerts after the tx commits.
    for (const t of triggers) {
      void this.kafka.emit({
        topic: 'svc.wellbeing.alert.created',
        key: t.responseId,
        sourceModule: 'wellbeing',
        payload: {
          alertType: t.alertType,
          sourceRefId: t.responseId,
          schoolId: tenant.schoolId,
          studentId: t.studentId,
          checkinId,
          responseId: t.responseId,
          questionId: t.questionId,
          questionText: t.questionText,
          autoEscalate: t.alertType === 'SELF_HARM_INDICATOR',
          submittedByAccountId: actor.accountId,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    }

    return this.getById(checkinId, actor);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string, actor: ResolvedActor): Promise<CheckinResponseDto> {
    const tenant = getCurrentTenant();
    const isCounsellor = await this.hasCounsellorScope(actor);
    const sql: string[] = [
      SELECT_CHECKIN_BASE,
      'WHERE c.id = $1::uuid AND c.school_id = $2::uuid ',
    ];
    const params: unknown[] = [id, tenant.schoolId];
    let idx = 3;

    if (actor.isSchoolAdmin) {
      // Admin OK.
    } else if (isCounsellor) {
      if (!actor.employeeId) throw new NotFoundException('Check-in ' + id);
      sql.push(
        'AND (c.assigned_counselor_id = $' +
          idx +
          '::uuid OR c.student_id IN (' +
          'SELECT student_id FROM svc_caseloads WHERE counselor_id = $' +
          idx +
          "::uuid AND status = 'ACTIVE')) ",
      );
      params.push(actor.employeeId);
      idx++;
    } else if (actor.personType === 'STUDENT') {
      const myStudentId = await this.resolveCallerStudentId(actor);
      if (!myStudentId) throw new NotFoundException('Check-in ' + id);
      sql.push('AND c.student_id = $' + idx + '::uuid ');
      params.push(myStudentId);
      idx++;
    } else {
      throw new NotFoundException('Check-in ' + id);
    }

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CheckinRow[]>(sql.join(''), ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Check-in ' + id);
    return rowToCheckinDto(rows[0]!);
  }
}

interface AlertTrigger {
  alertType: AlertType;
  responseId: string;
  questionId: string;
  questionText: string;
  studentId: string;
}

/**
 * Per-response alert evaluation. Returns the matching alert_type or
 * null when the response does not trigger an alert.
 *
 * Precedence order — SELF_HARM_INDICATOR takes precedence over
 * FEELS_UNSAFE on the same response so a single SAFETY+SCALE_1_5+
 * numeric=1 row creates one alert, not two:
 *
 *   1. SELF_HARM_INDICATOR  — SAFETY + SCALE_1_5 + numeric=1
 *                             (the absolute-lowest rating on the 1-5
 *                             scale; auto-escalates to admin).
 *   2. FEELS_UNSAFE          — SAFETY + (SCALE_1_5 with numeric>1
 *                             but ≤2 OR SCALE_1_10 with numeric≤2).
 *                             The "low but not critical" band so we
 *                             still flag the response without firing
 *                             the auto-escalate path.
 *   3. WANTS_TO_TALK         — SAFETY or EMOTIONAL + YES_NO + numeric=1
 *                             (the YES branch).
 *
 * SIGNIFICANT_SCORE_DROP and PERSISTENT_LOW_SCORE require historical
 * comparison across deployments and are deferred per the plan — the
 * 5-value alert_type CHECK in the schema accepts them but no service
 * generates them this cycle.
 */
function evaluateResponse(
  domain: WellbeingDomain,
  questionType: QuestionType,
  numeric: number | null,
): AlertType | null {
  if (numeric === null) return null;

  // Rule 1: SELF_HARM_INDICATOR — strictest, takes precedence.
  if (domain === 'SAFETY' && questionType === 'SCALE_1_5' && numeric <= 1) {
    return 'SELF_HARM_INDICATOR';
  }

  // Rule 2: FEELS_UNSAFE — broader low-score band (excludes the
  // SCALE_1_5+numeric=1 case already caught above).
  if (
    domain === 'SAFETY' &&
    ((questionType === 'SCALE_1_5' && numeric === 2) ||
      (questionType === 'SCALE_1_10' && numeric <= 2))
  ) {
    return 'FEELS_UNSAFE';
  }

  // Rule 3: WANTS_TO_TALK — YES on a SAFETY or EMOTIONAL YES_NO
  // question.
  if (
    questionType === 'YES_NO' &&
    numeric === 1 &&
    (domain === 'SAFETY' || domain === 'EMOTIONAL')
  ) {
    return 'WANTS_TO_TALK';
  }

  return null;
}
