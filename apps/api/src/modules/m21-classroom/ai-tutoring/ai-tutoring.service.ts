import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { AIUsageService } from './ai-usage.service';
import { AIOptOutService } from './ai-opt-out.service';
import { AIGatewayService } from './ai-gateway.service';
import {
  AILearningSignalResponseDto,
  AIMessageDto,
  AITutoringMessageResponseDto,
  AITutoringSessionResponseDto,
  AITutoringSessionWithMessagesDto,
  CompleteAISessionDto,
  StartAITutoringSessionDto,
} from './dto/ai-tutoring.dto';

interface SessionRow {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string | null;
  class_id: string | null;
  class_name: string | null;
  subject: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  started_at: Date | string;
  ended_at: Date | string | null;
  total_messages: number;
  learning_signals_extracted: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: 'STUDENT' | 'ASSISTANT';
  content: string;
  sent_at: Date | string;
  tokens_used: number | null;
  created_at: Date | string;
}

interface SignalRow {
  id: string;
  session_id: string;
  signal_type: 'MISCONCEPTION' | 'STRENGTH' | 'STRUGGLE' | 'INTEREST' | 'ENGAGEMENT';
  signal_description: string;
  standard_id: string | null;
  confidence: string | null;
  extracted_at: Date | string;
  created_at: Date | string;
}

function toIso(v: Date | string | null): string {
  if (v === null) return '';
  return typeof v === 'string' ? v : v.toISOString();
}

function sessionRowToDto(row: SessionRow): AITutoringSessionResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    studentId: row.student_id,
    studentName: row.student_name,
    classId: row.class_id,
    className: row.class_name,
    subject: row.subject,
    status: row.status,
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at === null ? null : toIso(row.ended_at),
    totalMessages: row.total_messages,
    learningSignalsExtracted: row.learning_signals_extracted,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function messageRowToDto(row: MessageRow): AITutoringMessageResponseDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    sentAt: toIso(row.sent_at),
    tokensUsed: row.tokens_used,
    createdAt: toIso(row.created_at),
  };
}

function signalRowToDto(row: SignalRow): AILearningSignalResponseDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    signalType: row.signal_type,
    signalDescription: row.signal_description,
    standardId: row.standard_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    extractedAt: toIso(row.extracted_at),
    createdAt: toIso(row.created_at),
  };
}

const SELECT_SESSION_BASE =
  'SELECT s.id, s.school_id, s.student_id, ' +
  "(ip_s.first_name || ' ' || ip_s.last_name) AS student_name, " +
  's.class_id, ' +
  "(co.name || ' (' || c.section_code || ')') AS class_name, " +
  's.subject, s.status, s.started_at, s.ended_at, s.total_messages, ' +
  's.learning_signals_extracted, s.created_at, s.updated_at ' +
  'FROM cls_ai_tutoring_sessions s ' +
  'LEFT JOIN sis_students st ON st.id = s.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_s ON ip_s.id = ps.person_id ' +
  'LEFT JOIN sis_classes c ON c.id = s.class_id ' +
  'LEFT JOIN sis_courses co ON co.id = c.course_id ';

/**
 * AITutoringService — P2-7c Step 6 keystone.
 *
 * Three load-bearing AI safety rules from ADR-004 enforced at the
 * service layer (the schema cannot enforce them but the service
 * spec pins them as regression tests):
 *
 *   1. AI MUST NEVER write to cls_grades. This service reads from
 *      cls_grades for context but never inserts or updates a grade
 *      row. Only teacher action via the Cycle 2 GradeService writes
 *      the cls_grades table.
 *   2. AI MUST NEVER receive student PII in prompts. The
 *      `toAnonymousId()` helper hashes student_id plus session_id
 *      into a deterministic but opaque token before sending any
 *      prompt to the AI Gateway. The system prompt contains the
 *      subject only, never the student name or any PII.
 *   3. AI tutoring opt-out is hard-gated. The service checks
 *      cls_ai_tutoring_opt_outs.UNIQUE(student_id) before every
 *      session start AND every message. An opted-out student
 *      receives 403 with the canonical message — no exceptions
 *      even for school admin override.
 */
@Injectable()
export class AITutoringService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly usage: AIUsageService,
    private readonly optOuts: AIOptOutService,
    private readonly gateway: AIGatewayService,
  ) {}

  /**
   * SAFETY RULE 2 — anonymisation contract. The AI Gateway must NEVER
   * see a real student_id or any PII. Hash the studentId + sessionId
   * into a deterministic 16-hex token so a single conversation has a
   * stable "user" id from the model's perspective without leaking
   * identity. The hash is one-way — the model cannot reverse-engineer
   * the studentId. Service tests pin this contract.
   */
  private toAnonymousId(studentId: string, sessionId: string): string {
    return createHash('sha256')
      .update(studentId + ':' + sessionId)
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Resolve the student id the calling actor is allowed to start a
   * session for. STUDENT actors must use their own id; teachers + admins
   * can pass an explicit studentId — but the authorisation check
   * (assertCanCreateSessionForStudent) runs SEPARATELY before the INSERT
   * so we cannot resolve a student that the actor is not authorised
   * for. The student must also exist in the CURRENT TENANT — REVIEW-P2C7
   * BLOCKING 3 added the school-scoped sis_students predicate.
   */
  private async resolveStudentForActor(
    requestedStudentId: string | undefined,
    actor: ResolvedActor,
  ): Promise<string> {
    const tenant = getCurrentTenant();
    if (actor.personType === 'STUDENT') {
      const own = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid',
          actor.personId,
          tenant.schoolId,
        );
      });
      if (own.length === 0) {
        throw new ForbiddenException('Calling user is not linked to a student record.');
      }
      const ownId = own[0]!.id;
      if (requestedStudentId && requestedStudentId !== ownId) {
        throw new ForbiddenException(
          'Students may only start AI tutoring sessions for themselves.',
        );
      }
      return ownId;
    }
    if (!requestedStudentId) {
      throw new BadRequestException('studentId is required for non-student actors.');
    }
    // Verify the student exists in this tenant — school-scoped predicate
    const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid',
        requestedStudentId,
        tenant.schoolId,
      );
    });
    if (exists.length === 0) {
      throw new NotFoundException('Student ' + requestedStudentId + ' not found');
    }
    return requestedStudentId;
  }

  /**
   * REVIEW-P2C7 BLOCKING 3 — caller authorisation gate that runs BEFORE
   * the session INSERT. Students may only start their own session
   * (already enforced in resolveStudentForActor). For non-student
   * actors:
   *   - school admin: any student in the school.
   *   - teacher (STAFF + employeeId): only students enrolled in
   *     classes the teacher teaches (joined through sis_class_teachers
   *     + sis_enrollments status=ACTIVE).
   *   - counsellor: only students on their active caseload.
   *   - other staff with tch-007:write: denied (no obvious teaching /
   *     counselling relationship to the student).
   * If `classId` is supplied the teacher path additionally requires
   * the (student, class) pair to be enrolled AND the teacher to teach
   * that class.
   */
  private async assertCanCreateSessionForStudent(
    studentId: string,
    classId: string | null,
    actor: ResolvedActor,
  ): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT') return; // already validated in resolveStudentForActor
    if (actor.personType !== 'STAFF' || !actor.employeeId) {
      throw new ForbiddenException(
        'Only students, assigned teachers, counsellors, or school admins may start an AI tutoring session.',
      );
    }
    const tenant = getCurrentTenant();
    const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
      if (classId) {
        // Teacher must teach the supplied class AND the student must be enrolled in it
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers ct ' +
            "JOIN sis_enrollments e ON e.class_id = ct.class_id AND e.status = 'ACTIVE' " +
            'JOIN sis_classes c ON c.id = ct.class_id AND c.school_id = $4::uuid ' +
            'WHERE ct.class_id = $1::uuid AND ct.teacher_employee_id = $2::uuid AND e.student_id = $3::uuid LIMIT 1',
          classId,
          actor.employeeId,
          studentId,
          tenant.schoolId,
        );
      }
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ct ' +
          "JOIN sis_enrollments e ON e.class_id = ct.class_id AND e.status = 'ACTIVE' " +
          'WHERE ct.teacher_employee_id = $1::uuid AND e.student_id = $2::uuid LIMIT 1',
        actor.employeeId,
        studentId,
      );
    });
    if (teaches.length > 0) return;
    // Counsellor path — caseload-linked student
    const onCaseload = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM svc_caseloads ' +
          "WHERE counselor_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE' LIMIT 1",
        actor.employeeId,
        studentId,
      );
    });
    if (onCaseload.length > 0) return;
    throw new ForbiddenException(
      'You may only start AI tutoring sessions for students you teach or counsel.',
    );
  }

  /**
   * SAFETY RULE 3 — opt-out gate. Throw 403 with the canonical
   * message if the student has an opt-out row. Even school admins
   * cannot override — opt-out is a parental / student right.
   */
  private async assertNotOptedOut(studentId: string): Promise<void> {
    const optedOut = await this.optOuts.isOptedOut(studentId);
    if (optedOut) {
      throw new ForbiddenException(
        'AI tutoring is disabled for this student per the opt-out on file. Contact a parent or admin to opt back in.',
      );
    }
  }

  /** POST /classroom/ai-tutoring/sessions — start a new session. */
  async startSession(
    input: StartAITutoringSessionDto,
    actor: ResolvedActor,
  ): Promise<AITutoringSessionResponseDto> {
    const studentId = await this.resolveStudentForActor(input.studentId, actor);
    await this.assertNotOptedOut(studentId);

    const tenant = getCurrentTenant();
    const sessionId = generateId();

    if (input.classId) {
      const classExists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid AND school_id = $2::uuid',
          input.classId,
          tenant.schoolId,
        );
      });
      if (classExists.length === 0) {
        throw new BadRequestException('classId does not match a class in this school.');
      }
    }

    // REVIEW-P2C7 BLOCKING 3 — authorise BEFORE the INSERT so we never
    // create an orphaned session for an unauthorised teacher / staff.
    await this.assertCanCreateSessionForStudent(studentId, input.classId ?? null, actor);

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO cls_ai_tutoring_sessions ' +
          '(id, school_id, student_id, class_id, subject) VALUES ' +
          '($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
        sessionId,
        tenant.schoolId,
        studentId,
        input.classId ?? null,
        input.subject,
      );
    });

    return this.getSession(sessionId, actor);
  }

  /** POST /classroom/ai-tutoring/sessions/:id/message — student sends a message. */
  async postMessage(
    sessionId: string,
    input: AIMessageDto,
    actor: ResolvedActor,
  ): Promise<{ student: AITutoringMessageResponseDto; assistant: AITutoringMessageResponseDto }> {
    // Load session + verify it's active + scope check
    const session = await this.loadSessionRowOrThrow(sessionId);
    if (session.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Session is in status ' + session.status + ' and no longer accepts messages.',
      );
    }
    await this.assertCanWriteSession(session, actor);
    await this.assertNotOptedOut(session.student_id);

    // SAFETY RULE 1 — quota gate fires BEFORE the AI Gateway call.
    await this.usage.assertWithinQuota(session.school_id);

    // SAFETY RULE 2 — anonymisation. The Gateway sees only the opaque
    // anonId + the subject + the conversation transcript (no PII).
    const anonId = this.toAnonymousId(session.student_id, session.id);
    // REVIEW-P2C7 ROUND 2 BLOCKING — defence-in-depth school-scope JOIN.
    // The loader above already 404s on cross-school session UUIDs; this
    // JOIN means even a manually-inserted message row pointing at a
    // foreign-school session cannot leak into the AI Gateway prompt.
    const tenant = getCurrentTenant();
    const history = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MessageRow[]>(
        'SELECT m.id::text AS id, m.session_id::text AS session_id, m.role, m.content, ' +
          'm.sent_at, m.tokens_used, m.created_at ' +
          'FROM cls_ai_tutoring_messages m ' +
          'JOIN cls_ai_tutoring_sessions s ON s.id = m.session_id ' +
          'WHERE m.session_id = $1::uuid AND s.school_id = $2::uuid ORDER BY m.sent_at ASC',
        sessionId,
        tenant.schoolId,
      );
    });

    // Insert the student message
    const studentMsgId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO cls_ai_tutoring_messages ' +
          '(id, session_id, role, content) VALUES ' +
          "($1::uuid, $2::uuid, 'STUDENT', $3)",
        studentMsgId,
        sessionId,
        input.content,
      );
    });

    // Call AI Gateway (stubbed in dev — see AIGatewayService).
    // The history is mapped to {role, content} only, no ids leak.
    const reply = await this.gateway.tutoringReply({
      anonymousStudentId: anonId,
      subject: session.subject,
      history: history.map((h) => ({ role: h.role, content: h.content })),
      newMessage: input.content,
    });

    // Insert the assistant response
    const assistantMsgId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_ai_tutoring_messages ' +
          '(id, session_id, role, content, tokens_used) VALUES ' +
          "($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::int)",
        assistantMsgId,
        sessionId,
        reply.content,
        reply.tokensUsed,
      );
      // Bump total_messages by 2 (STUDENT + ASSISTANT). REVIEW-P2C7
      // ROUND 2 — school-scoped UPDATE predicate (defence-in-depth).
      await tx.$executeRawUnsafe(
        'UPDATE cls_ai_tutoring_sessions SET total_messages = total_messages + 2, ' +
          'updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid',
        sessionId,
        tenant.schoolId,
      );
    });

    // Log usage AFTER the reply commits — TUTORING type, references the session
    await this.usage.recordUsage({
      schoolId: session.school_id,
      jobType: 'TUTORING',
      tokensUsed: reply.tokensUsed,
      costUsd: reply.costUsd,
      referenceId: sessionId,
      actorAccountId: actor.accountId,
    });

    const studentDto = (await this.loadMessageOrThrow(
      studentMsgId,
    )) as AITutoringMessageResponseDto;
    const assistantDto = (await this.loadMessageOrThrow(
      assistantMsgId,
    )) as AITutoringMessageResponseDto;
    return { student: studentDto, assistant: assistantDto };
  }

  /** GET /classroom/ai-tutoring/sessions/:id — full session with messages inlined. */
  async getSessionWithMessages(
    sessionId: string,
    actor: ResolvedActor,
  ): Promise<AITutoringSessionWithMessagesDto> {
    const session = await this.loadSessionRowOrThrow(sessionId);
    await this.assertCanReadSession(session, actor);
    // REVIEW-P2C7 ROUND 2 — defence-in-depth school-scope JOIN.
    const tenant = getCurrentTenant();
    const messages = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MessageRow[]>(
        'SELECT m.id::text AS id, m.session_id::text AS session_id, m.role, m.content, ' +
          'm.sent_at, m.tokens_used, m.created_at FROM cls_ai_tutoring_messages m ' +
          'JOIN cls_ai_tutoring_sessions s ON s.id = m.session_id ' +
          'WHERE m.session_id = $1::uuid AND s.school_id = $2::uuid ORDER BY m.sent_at ASC',
        sessionId,
        tenant.schoolId,
      );
    });
    return {
      ...sessionRowToDto(session),
      messages: messages.map(messageRowToDto),
    };
  }

  /** GET /classroom/ai-tutoring/sessions/:id (no messages) */
  async getSession(id: string, actor: ResolvedActor): Promise<AITutoringSessionResponseDto> {
    const session = await this.loadSessionRowOrThrow(id);
    await this.assertCanReadSession(session, actor);
    return sessionRowToDto(session);
  }

  /**
   * GET /classroom/ai-tutoring/sessions — list with row scope.
   *
   * REVIEW-P2C7 ROUND 3 BLOCKING — school_id is the BASE predicate for
   * EVERY actor including school admin. Without it, a School A admin in
   * a multi-school tenant pool could list School B AI tutoring sessions
   * (student identity, class context, subject, status, message counts,
   * learning-signals-extracted flag are all sensitive). The
   * `s.school_id = $1::uuid` clause runs first; actor-specific
   * predicates AND on top.
   */
  async listSessions(actor: ResolvedActor): Promise<AITutoringSessionResponseDto[]> {
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = ' WHERE s.school_id = $1::uuid';
    let i = 2;

    if (!actor.isSchoolAdmin) {
      if (actor.personType === 'STUDENT') {
        where +=
          ' AND s.student_id = (SELECT s2.id FROM sis_students s2 ' +
          'JOIN platform.platform_students ps2 ON ps2.id = s2.platform_student_id ' +
          'WHERE ps2.person_id = $' +
          i++ +
          '::uuid)';
        params.push(actor.personId);
      } else if (actor.personType === 'STAFF' && actor.employeeId) {
        // Teachers see sessions for students in classes they teach
        where +=
          ' AND s.student_id IN (' +
          'SELECT DISTINCT e.student_id FROM sis_class_teachers ct ' +
          "JOIN sis_enrollments e ON e.class_id = ct.class_id AND e.status = 'ACTIVE' " +
          'WHERE ct.teacher_employee_id = $' +
          i++ +
          '::uuid)';
        params.push(actor.employeeId);
      } else {
        return [];
      }
    }

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SessionRow[]>(
        SELECT_SESSION_BASE + where + ' ORDER BY s.started_at DESC LIMIT 100',
        ...params,
      );
    });
    return rows.map(sessionRowToDto);
  }

  /** PATCH /classroom/ai-tutoring/sessions/:id/complete — mark COMPLETED. */
  async completeSession(
    id: string,
    _input: CompleteAISessionDto,
    actor: ResolvedActor,
  ): Promise<AITutoringSessionResponseDto> {
    // REVIEW-P2C7 ROUND 2 BLOCKING — school-scoped FOR UPDATE lock so a
    // cross-school session UUID cannot be transitioned by an out-of-school
    // admin who short-circuits assertCanWriteSession.
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<SessionRow[]>(
        'SELECT id, school_id, student_id::text AS student_id, class_id::text AS class_id, ' +
          'subject, status, started_at, ended_at, total_messages, learning_signals_extracted, ' +
          'created_at, updated_at FROM cls_ai_tutoring_sessions ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Session ' + id + ' not found');
      const row = rows[0]!;
      if (row.status !== 'ACTIVE') {
        throw new BadRequestException('Session is in status ' + row.status + ' — cannot complete.');
      }
      await this.assertCanWriteSession(row, actor);
      await tx.$executeRawUnsafe(
        "UPDATE cls_ai_tutoring_sessions SET status = 'COMPLETED', ended_at = now(), updated_at = now() " +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    return this.getSession(id, actor);
  }

  /** POST /classroom/ai-tutoring/sessions/:id/extract-signals — admin/teacher triggers signal extraction. */
  async extractSignals(id: string, actor: ResolvedActor): Promise<AILearningSignalResponseDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only teachers and school admins can extract learning signals.');
    }
    const session = await this.loadSessionRowOrThrow(id);
    // REVIEW-P2C7 BLOCKING 2 — extraction must additionally pass the
    // session row-scope check (assigned teacher OR caseload-linked
    // counsellor OR admin). Without this any STAFF actor could trigger
    // expensive AI analysis on any session.
    await this.assertCanReadSession(session, actor);
    if (session.learning_signals_extracted) {
      throw new BadRequestException('Learning signals already extracted for this session.');
    }
    if (session.status === 'ACTIVE') {
      throw new BadRequestException(
        'Session must be COMPLETED or ABANDONED before extracting learning signals.',
      );
    }
    await this.usage.assertWithinQuota(session.school_id);

    // REVIEW-P2C7 ROUND 2 — defence-in-depth school-scope JOIN. Same
    // shape as the postMessage history fetch.
    const tenant = getCurrentTenant();
    const messages = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MessageRow[]>(
        'SELECT m.id::text AS id, m.session_id::text AS session_id, m.role, m.content, ' +
          'm.sent_at, m.tokens_used, m.created_at FROM cls_ai_tutoring_messages m ' +
          'JOIN cls_ai_tutoring_sessions s ON s.id = m.session_id ' +
          'WHERE m.session_id = $1::uuid AND s.school_id = $2::uuid ORDER BY m.sent_at ASC',
        id,
        tenant.schoolId,
      );
    });

    if (messages.length === 0) {
      // No messages — flip the flag so we don't try again. School-scoped
      // UPDATE predicate per REVIEW-P2C7 ROUND 2.
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE cls_ai_tutoring_sessions SET learning_signals_extracted = true, ' +
            'updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid',
          id,
          tenant.schoolId,
        );
      });
      return [];
    }

    const anonId = this.toAnonymousId(session.student_id, session.id);
    const extraction = await this.gateway.extractLearningSignals({
      anonymousStudentId: anonId,
      subject: session.subject,
      transcript: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      for (const sig of extraction.signals) {
        await tx.$executeRawUnsafe(
          'INSERT INTO cls_ai_tutoring_learning_signals ' +
            '(id, session_id, signal_type, signal_description, standard_id, confidence) VALUES ' +
            '($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::numeric)',
          generateId(),
          id,
          sig.signalType,
          sig.description,
          sig.standardId ?? null,
          sig.confidence ?? null,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE cls_ai_tutoring_sessions SET learning_signals_extracted = true, ' +
          'updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });

    await this.usage.recordUsage({
      schoolId: session.school_id,
      jobType: 'STUDENT_SUMMARY',
      tokensUsed: extraction.tokensUsed,
      costUsd: extraction.costUsd,
      referenceId: id,
      actorAccountId: actor.accountId,
    });

    return this.listSignals(id, actor);
  }

  /** GET /classroom/ai-tutoring/sessions/:id/signals — list extracted signals. */
  async listSignals(
    sessionId: string,
    actor: ResolvedActor,
  ): Promise<AILearningSignalResponseDto[]> {
    const session = await this.loadSessionRowOrThrow(sessionId);
    await this.assertCanReadSession(session, actor);
    // Per ADR-004, signals are visible to teacher + admin + counsellor.
    // Students must not see their own signals (avoids labelling).
    if (actor.personType === 'STUDENT') {
      throw new ForbiddenException('Students cannot view extracted learning signals.');
    }
    // REVIEW-P2C7 ROUND 2 BLOCKING — school-scoped JOIN as defence-in-
    // depth. The loader above already 404s on cross-school session UUIDs;
    // this JOIN means the query itself can never return signals for a
    // session outside the calling tenant.
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SignalRow[]>(
        'SELECT ls.id::text AS id, ls.session_id::text AS session_id, ls.signal_type, ' +
          'ls.signal_description, ls.standard_id::text AS standard_id, ls.confidence, ' +
          'ls.extracted_at, ls.created_at ' +
          'FROM cls_ai_tutoring_learning_signals ls ' +
          'JOIN cls_ai_tutoring_sessions s ON s.id = ls.session_id ' +
          'WHERE ls.session_id = $1::uuid AND s.school_id = $2::uuid ' +
          'ORDER BY ls.extracted_at DESC',
        sessionId,
        tenant.schoolId,
      );
    });
    return rows.map(signalRowToDto);
  }

  /**
   * GET /classroom/students/:studentId/learning-signals — aggregated
   * across sessions.
   *
   * REVIEW-P2C7 BLOCKING 1 — actor-scoped row scope. The previous
   * implementation allowed any STAFF actor with `tch-007:read` to
   * retrieve sensitive AI inferences (misconceptions, struggles,
   * confidence) for any student in the tenant. This is now strictly
   * row-scoped:
   *   - school admin: any student in this school.
   *   - teacher (STAFF + employeeId): only when the student is enrolled
   *     in an active class the teacher teaches.
   *   - counsellor: only when the student is on the counsellor's
   *     active caseload (svc_caseloads from Cycle 11).
   *   - other staff with tch-007:read: 403 — no teaching or counselling
   *     relationship.
   *   - student: 403 (per Cycle 7 policy — students do not see own signals).
   */
  async listSignalsForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<AILearningSignalResponseDto[]> {
    if (actor.personType === 'STUDENT') {
      throw new ForbiddenException('Students cannot view extracted learning signals.');
    }
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only teachers, counsellors, and admins can view learning signals.',
      );
    }
    const tenant = getCurrentTenant();
    // Validate student exists in this tenant (school-scoped)
    const studentExists = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid',
        studentId,
        tenant.schoolId,
      );
    });
    if (studentExists.length === 0) {
      throw new NotFoundException('Student ' + studentId + ' not found');
    }
    if (!actor.isSchoolAdmin) {
      // STAFF + employeeId required (counsellor / teacher both have this)
      if (!actor.employeeId) {
        throw new ForbiddenException(
          'You must be an assigned teacher, caseload-linked counsellor, or admin to view learning signals.',
        );
      }
      const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers ct ' +
            "JOIN sis_enrollments e ON e.class_id = ct.class_id AND e.status = 'ACTIVE' " +
            'WHERE ct.teacher_employee_id = $1::uuid AND e.student_id = $2::uuid LIMIT 1',
          actor.employeeId,
          studentId,
        );
      });
      if (teaches.length === 0) {
        const onCaseload = await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM svc_caseloads ' +
              "WHERE counselor_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE' LIMIT 1",
            actor.employeeId,
            studentId,
          );
        });
        if (onCaseload.length === 0) {
          throw new ForbiddenException(
            'You may only view learning signals for students you teach or counsel.',
          );
        }
      }
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SignalRow[]>(
        'SELECT ls.id::text AS id, ls.session_id::text AS session_id, ls.signal_type, ' +
          'ls.signal_description, ls.standard_id::text AS standard_id, ls.confidence, ' +
          'ls.extracted_at, ls.created_at ' +
          'FROM cls_ai_tutoring_learning_signals ls ' +
          'JOIN cls_ai_tutoring_sessions s ON s.id = ls.session_id ' +
          'WHERE s.student_id = $1::uuid AND s.school_id = $2::uuid ' +
          'ORDER BY ls.extracted_at DESC LIMIT 200',
        studentId,
        tenant.schoolId,
      );
    });
    return rows.map(signalRowToDto);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /**
   * REVIEW-P2C7 ROUND 2 BLOCKING — school-scoped session loader. Without
   * this, school admins (who short-circuit `assertCanReadSession`) could
   * read a foreign-school session by guessing or leaking its UUID. The
   * tenant context's schoolId predicate is the actual access boundary
   * for direct-object reference paths and must live on the loader, not
   * on a downstream filter.
   */
  private async loadSessionRowOrThrow(id: string): Promise<SessionRow> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SessionRow[]>(
        SELECT_SESSION_BASE + ' WHERE s.id = $1::uuid AND s.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Session ' + id + ' not found');
    return rows[0]!;
  }

  /**
   * REVIEW-P2C7 ROUND 2 BLOCKING — school-scoped message loader so a
   * leaked message UUID from another tenant collapses to 404 don't-leak-
   * existence. Resolves the parent session.school_id then validates
   * against the calling tenant.
   */
  private async loadMessageOrThrow(id: string): Promise<AITutoringMessageResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MessageRow[]>(
        'SELECT m.id::text AS id, m.session_id::text AS session_id, m.role, m.content, ' +
          'm.sent_at, m.tokens_used, m.created_at FROM cls_ai_tutoring_messages m ' +
          'JOIN cls_ai_tutoring_sessions s ON s.id = m.session_id ' +
          'WHERE m.id = $1::uuid AND s.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Message ' + id + ' not found');
    return messageRowToDto(rows[0]!);
  }

  private async assertCanReadSession(session: SessionRow, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT') {
      // Verify own session
      const own = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $1::uuid',
          actor.personId,
        );
      });
      if (own.length === 0 || own[0]!.id !== session.student_id) {
        throw new NotFoundException('Session ' + session.id + ' not found');
      }
      return;
    }
    if (actor.personType === 'STAFF' && actor.employeeId) {
      // Teacher sees if student is in a class they teach
      const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers ct ' +
            "JOIN sis_enrollments e ON e.class_id = ct.class_id AND e.status = 'ACTIVE' " +
            'WHERE ct.teacher_employee_id = $1::uuid AND e.student_id = $2::uuid LIMIT 1',
          actor.employeeId,
          session.student_id,
        );
      });
      if (teaches.length > 0) return;
      // Counsellor sees if student is on their active caseload
      const onCaseload = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM svc_caseloads ' +
            "WHERE counselor_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE' LIMIT 1",
          actor.employeeId,
          session.student_id,
        );
      });
      if (onCaseload.length > 0) return;
    }
    throw new NotFoundException('Session ' + session.id + ' not found');
  }

  private async assertCanWriteSession(session: SessionRow, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT') {
      const own = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $1::uuid',
          actor.personId,
        );
      });
      if (own.length === 0 || own[0]!.id !== session.student_id) {
        throw new ForbiddenException('You can only post messages to your own AI tutoring session.');
      }
      return;
    }
    if (actor.personType === 'STAFF') {
      // Teachers can post on behalf of a student in a class they teach (e.g. demo mode)
      if (!actor.employeeId) throw new ForbiddenException('Teacher has no hr_employees record.');
      const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers ct ' +
            "JOIN sis_enrollments e ON e.class_id = ct.class_id AND e.status = 'ACTIVE' " +
            'WHERE ct.teacher_employee_id = $1::uuid AND e.student_id = $2::uuid LIMIT 1',
          actor.employeeId,
          session.student_id,
        );
      });
      if (teaches.length === 0) {
        throw new ForbiddenException('You are not assigned to a class containing this student.');
      }
      return;
    }
    throw new ForbiddenException('Only the session owner, an assigned teacher, or admin can post.');
  }
}
