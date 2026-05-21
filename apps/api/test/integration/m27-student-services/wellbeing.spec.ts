import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import type { ResolvedActor } from '@modules/m00-platform';

import { CheckinService } from '@modules/m27-student-services/wellbeing/checkin.service';
import { AlertService } from '@modules/m27-student-services/wellbeing/alert.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

/**
 * Wave 3 — DB-backed integration tests for CheckinService + AlertService.
 *
 * Strategy doc Wave 3 KEYSTONE contracts:
 *   - submit() KEYSTONE: response INSERTs + alert INSERTs + outbox
 *     emit(s) for `svc.wellbeing.alert.created` all in ONE tenant tx
 *     (REVIEW-FINAL P2 — SHI auto-escalation is a clinical-safety
 *     control; previous best-effort emit could silently drop the
 *     escalation on broker outage).
 *   - Alert evaluation precedence: SELF_HARM_INDICATOR (SAFETY +
 *     SCALE_1_5 + numeric=1) > FEELS_UNSAFE (SAFETY + numeric near
 *     bottom) > WANTS_TO_TALK (SAFETY/EMOTIONAL + YES_NO + numeric=1).
 *     A SCALE_1_5+numeric=1 row creates one alert (SHI) not two.
 *   - REVIEW-CYCLE11.1 BLOCKING 1 — student row scope strips
 *     flaggedForFollowUp + assigned-counsellor metadata from the
 *     student's own view (privacy contract).
 *   - REVIEW-CYCLE11.1 MAJOR 3 — non-counsellor STAFF (teachers) are
 *     hard-403, not stripped (cardinality leakage avoidance).
 *   - REVIEW-CYCLE11.1 BLOCKING 2 — per-question-type response shape
 *     validation (YES_NO ∈ {0,1}, SCALE_1_5 ∈ [1,5], SCALE_1_10 ∈
 *     [1,10], FREE_TEXT non-blank text only).
 *   - SELECT FOR UPDATE on check-in row inside submit tx prevents
 *     double-stamping on concurrent submissions.
 *   - AlertService.acknowledge/resolve satisfy multi-column
 *     acknowledged_chk lockstep (status + acknowledged_by +
 *     acknowledged_at stamped atomically).
 */
describe('integration:m27-student-services/wellbeing', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let checkins: CheckinService;
  let alerts: AlertService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    checkins = new CheckinService(tenantPrisma, permCheck, outbox);
    alerts = new AlertService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  // ─── Per-test state we need to clean up ───
  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];
  const createdCaseloadIds: string[] = [];
  const createdTemplateIds: string[] = [];

  // Stable student-actor projection: persists across tests, deleted in afterAll.
  let studentActorSisId: string | null = null;
  let studentActorPlatformStudentId: string | null = null;

  // ─── Helpers ───
  async function seedStudent(label: string): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'WB', $2, 'STUDENT', true)`,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'WB', $3, true)`,
      platformStudentId,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '8')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'WB-TEST-' + studentId.slice(-12),
    );
    return studentId;
  }

  async function ensureStudentActorProjection(): Promise<string> {
    if (studentActorSisId) return studentActorSisId;
    const platformStudentId = generateId();
    const sisStudentId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Integration', 'StudentActor', true)
       ON CONFLICT (id) DO NOTHING`,
      platformStudentId,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '8')`,
      sisStudentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'WB-ACTOR-' + sisStudentId.slice(-12),
    );
    studentActorSisId = sisStudentId;
    studentActorPlatformStudentId = platformStudentId;
    return sisStudentId;
  }

  /**
   * Seed a survey template with questions. Returns { templateId,
   * questionIdsByType }. The default mix covers SAFETY+SCALE_1_5 (for
   * SHI / FEELS_UNSAFE), SAFETY+YES_NO (for WANTS_TO_TALK),
   * EMOTIONAL+YES_NO (also WANTS_TO_TALK), and ACADEMIC+FREE_TEXT (no
   * alert ever) plus ACADEMIC+SCALE_1_10 (no alert).
   */
  async function seedTemplate(): Promise<{
    templateId: string;
    safetyScale15: string;
    safetyYesNo: string;
    emotionalYesNo: string;
    academicFreeText: string;
    academicScale110: string;
  }> {
    const templateId = generateId();
    createdTemplateIds.push(templateId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_survey_templates
         (id, school_id, name, frequency_recommendation, created_by)
       VALUES ($1::uuid, $2::uuid, $3, 'WEEKLY', $4::uuid)`,
      templateId,
      TEST_SCHOOL_ID,
      'WB Test Template ' + templateId.slice(-6),
      TEST_ADMIN_EMPLOYEE_ID,
    );
    const ids = {
      safetyScale15: generateId(),
      safetyYesNo: generateId(),
      emotionalYesNo: generateId(),
      academicFreeText: generateId(),
      academicScale110: generateId(),
    };
    const questions: Array<[string, string, string, string, number]> = [
      [ids.safetyScale15, 'How safe do you feel? (1-5)', 'SCALE_1_5', 'SAFETY', 0],
      [ids.safetyYesNo, 'Do you want to talk?', 'YES_NO', 'SAFETY', 1],
      [ids.emotionalYesNo, 'Are you feeling overwhelmed?', 'YES_NO', 'EMOTIONAL', 2],
      [ids.academicFreeText, 'How is school?', 'FREE_TEXT', 'ACADEMIC', 3],
      [ids.academicScale110, 'Rate your week 1-10', 'SCALE_1_10', 'ACADEMIC', 4],
    ];
    for (const [id, text, type, domain, sort] of questions) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_questions
           (id, template_id, question_text, question_type, domain, sort_order)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
        id,
        templateId,
        text,
        type,
        domain,
        sort,
      );
    }
    return { templateId, ...ids };
  }

  async function seedCheckin(
    studentId: string,
    templateId: string,
    opts: {
      deploymentId?: string | null;
      assignedCounselorId?: string | null;
      completed?: boolean;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_checkins
         (id, school_id, student_id, template_id, deployment_id, assigned_counselor_id, completed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7)`,
      id,
      TEST_SCHOOL_ID,
      studentId,
      templateId,
      opts.deploymentId ?? null,
      opts.assignedCounselorId ?? null,
      opts.completed ? new Date() : null,
    );
    return id;
  }

  async function seedCaseload(studentId: string, counselorEmployeeId: string): Promise<string> {
    const id = generateId();
    createdCaseloadIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_caseloads
         (id, school_id, counselor_id, student_id, academic_year_id, primary_concern, opened_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ACADEMIC', '2025-09-01')`,
      id,
      TEST_SCHOOL_ID,
      counselorEmployeeId,
      studentId,
      TEST_ACADEMIC_YEAR_ID,
    );
    return id;
  }

  async function grantOfficerCounsellor(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['cou-004:write'],
    );
  }

  async function readOutbox() {
    return rawClient.$queryRawUnsafe<
      Array<{ topic: string; message_key: string; envelope: string }>
    >(
      `SELECT topic, message_key, envelope::text AS envelope
         FROM platform.platform_outbox
        WHERE topic = 'svc.wellbeing.alert.created' AND tenant_id = $1::uuid
        ORDER BY created_at`,
      TEST_SCHOOL_ID,
    );
  }

  async function readAlertsForStudent(studentId: string) {
    return rawClient.$queryRawUnsafe<
      Array<{ alert_type: string; status: string; response_id: string }>
    >(
      `SELECT alert_type, status, response_id::text AS response_id
         FROM ${TEST_SCHEMA}.svc_wellbeing_alerts WHERE student_id = $1::uuid`,
      studentId,
    );
  }

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'svc.wellbeing.alert.created' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    // Clean up alerts → responses → checkins (responses CASCADE from checkins)
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_alerts WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'WB-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'WB-%')`,
    );
    if (createdCaseloadIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_caseloads WHERE id = ANY($1::uuid[])`,
        createdCaseloadIds.splice(0),
      );
    }
    if (createdTemplateIds.length > 0) {
      // Questions cascade from template; deployments hold FK so deal with that.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_deployments WHERE template_id = ANY($1::uuid[])`,
        createdTemplateIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates WHERE id = ANY($1::uuid[])`,
        createdTemplateIds.splice(0),
      );
    }
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
  });

  // Per-test wiped student-actor projection cleanup runs in afterAll
  afterAll(async () => {
    if (studentActorSisId) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_alerts WHERE student_id = $1::uuid`,
        studentActorSisId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE student_id = $1::uuid`,
        studentActorSisId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
        studentActorSisId,
      );
    }
    if (studentActorPlatformStudentId) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
        studentActorPlatformStudentId,
      );
    }
  });

  // Helper that builds a "fully valid" response array for the default
  // template so individual tests can override only the values they care
  // about exercising.
  function fullValidResponses(
    q: {
      safetyScale15: string;
      safetyYesNo: string;
      emotionalYesNo: string;
      academicFreeText: string;
      academicScale110: string;
    },
    overrides: Partial<
      Record<keyof typeof q, { numericResponse?: number; textResponse?: string }>
    > = {},
  ) {
    return [
      {
        questionId: q.safetyScale15,
        numericResponse: overrides.safetyScale15?.numericResponse ?? 4,
        textResponse: overrides.safetyScale15?.textResponse,
      },
      {
        questionId: q.safetyYesNo,
        numericResponse: overrides.safetyYesNo?.numericResponse ?? 0,
        textResponse: overrides.safetyYesNo?.textResponse,
      },
      {
        questionId: q.emotionalYesNo,
        numericResponse: overrides.emotionalYesNo?.numericResponse ?? 0,
        textResponse: overrides.emotionalYesNo?.textResponse,
      },
      {
        questionId: q.academicFreeText,
        textResponse: overrides.academicFreeText?.textResponse ?? 'school is fine',
        numericResponse: overrides.academicFreeText?.numericResponse,
      },
      {
        questionId: q.academicScale110,
        numericResponse: overrides.academicScale110?.numericResponse ?? 7,
        textResponse: overrides.academicScale110?.textResponse,
      },
    ];
  }

  // ────────────────────────────────────────────────────────────────────
  // submit — KEYSTONE: response + alert + outbox in same tx
  // ────────────────────────────────────────────────────────────────────
  describe('submit (alert outbox-in-tx KEYSTONE)', () => {
    it('happy path with no alert-triggering values: completed_at stamped, flagged=false, ZERO outbox emits, 5 responses INSERTed', async () => {
      const studentId = await seedStudent('NoAlert');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await withTestTenant(async () =>
        checkins.submit(checkinId, { responses: fullValidResponses(tpl) } as any, adminActor()),
      );
      const row = (await rawClient.$queryRawUnsafe(
        `SELECT completed_at, flagged_for_follow_up FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE id = $1::uuid`,
        checkinId,
      )) as Array<{ completed_at: string; flagged_for_follow_up: boolean }>;
      expect(row[0]!.completed_at).not.toBeNull();
      expect(row[0]!.flagged_for_follow_up).toBe(false);
      const responseCount = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.svc_wellbeing_responses WHERE checkin_id = $1::uuid`,
        checkinId,
      )) as Array<{ n: number }>;
      expect(responseCount[0]!.n).toBe(5);
      expect(await readOutbox()).toHaveLength(0);
      expect(await readAlertsForStudent(studentId)).toHaveLength(0);
    });

    it('SELF_HARM_INDICATOR: SAFETY+SCALE_1_5+1 → ONE alert (SHI takes precedence over FEELS_UNSAFE), outbox emit with autoEscalate=true', async () => {
      const studentId = await seedStudent('SHI');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await withTestTenant(async () =>
        checkins.submit(
          checkinId,
          {
            responses: fullValidResponses(tpl, { safetyScale15: { numericResponse: 1 } }),
          } as any,
          adminActor(),
        ),
      );
      const stored = await readAlertsForStudent(studentId);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.alert_type).toBe('SELF_HARM_INDICATOR');
      expect(stored[0]!.status).toBe('NEW');
      const emits = await readOutbox();
      expect(emits).toHaveLength(1);
      const env = JSON.parse(emits[0]!.envelope);
      expect(env.payload.alertType).toBe('SELF_HARM_INDICATOR');
      expect(env.payload.autoEscalate).toBe(true);
      expect(env.payload.studentId).toBe(studentId);
      expect(env.payload.checkinId).toBe(checkinId);
      // flagged_for_follow_up gets stamped true
      const row = (await rawClient.$queryRawUnsafe(
        `SELECT flagged_for_follow_up FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE id = $1::uuid`,
        checkinId,
      )) as Array<{ flagged_for_follow_up: boolean }>;
      expect(row[0]!.flagged_for_follow_up).toBe(true);
    });

    it('FEELS_UNSAFE (precedence band): SAFETY+SCALE_1_5+2 → ONE alert, autoEscalate=false', async () => {
      const studentId = await seedStudent('FU');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await withTestTenant(async () =>
        checkins.submit(
          checkinId,
          {
            responses: fullValidResponses(tpl, { safetyScale15: { numericResponse: 2 } }),
          } as any,
          adminActor(),
        ),
      );
      const stored = await readAlertsForStudent(studentId);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.alert_type).toBe('FEELS_UNSAFE');
      const env = JSON.parse((await readOutbox())[0]!.envelope);
      expect(env.payload.autoEscalate).toBe(false);
    });

    it('WANTS_TO_TALK: SAFETY+YES_NO+1 AND EMOTIONAL+YES_NO+1 → TWO alerts, both autoEscalate=false', async () => {
      const studentId = await seedStudent('WTT');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await withTestTenant(async () =>
        checkins.submit(
          checkinId,
          {
            responses: fullValidResponses(tpl, {
              safetyYesNo: { numericResponse: 1 },
              emotionalYesNo: { numericResponse: 1 },
            }),
          } as any,
          adminActor(),
        ),
      );
      const stored = await readAlertsForStudent(studentId);
      expect(stored).toHaveLength(2);
      expect(stored.every((a) => a.alert_type === 'WANTS_TO_TALK')).toBe(true);
      expect(await readOutbox()).toHaveLength(2);
    });

    it('cannot resubmit completed check-in → BadRequest; no new outbox emits, no new alerts', async () => {
      const studentId = await seedStudent('Resubmit');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await withTestTenant(async () =>
        checkins.submit(checkinId, { responses: fullValidResponses(tpl) } as any, adminActor()),
      );
      const emitsBefore = (await readOutbox()).length;
      await expect(
        withTestTenant(async () =>
          checkins.submit(checkinId, { responses: fullValidResponses(tpl) } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await readOutbox()).length).toBe(emitsBefore);
    });

    it('missing question response → BadRequest; tx rolls back so no responses + no alerts + no outbox', async () => {
      const studentId = await seedStudent('Missing');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      // Drop the academicScale110 response
      const incomplete = fullValidResponses(tpl).filter(
        (r: any) => r.questionId !== tpl.academicScale110,
      );
      await expect(
        withTestTenant(async () =>
          checkins.submit(checkinId, { responses: incomplete } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const rc = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.svc_wellbeing_responses WHERE checkin_id = $1::uuid`,
        checkinId,
      )) as Array<{ n: number }>;
      expect(rc[0]!.n).toBe(0);
      expect(await readOutbox()).toHaveLength(0);
    });

    it('foreign question_id (not in template) → BadRequest', async () => {
      const studentId = await seedStudent('Foreign');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      const bad = [
        ...fullValidResponses(tpl),
        { questionId: '00000000-0000-0000-0000-000000000099', numericResponse: 3 },
      ];
      await expect(
        withTestTenant(async () =>
          checkins.submit(checkinId, { responses: bad } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('shape violation: YES_NO with numericResponse=7 → BadRequest (rejects out-of-range)', async () => {
      const studentId = await seedStudent('Shape1');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      const responses = fullValidResponses(tpl, { safetyYesNo: { numericResponse: 7 } });
      await expect(
        withTestTenant(async () => checkins.submit(checkinId, { responses } as any, adminActor())),
      ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/YES_NO/) });
    });

    it('shape violation: SCALE_1_5 with numericResponse=999 → BadRequest', async () => {
      const studentId = await seedStudent('Shape2');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      const responses = fullValidResponses(tpl, { safetyScale15: { numericResponse: 999 } });
      await expect(
        withTestTenant(async () => checkins.submit(checkinId, { responses } as any, adminActor())),
      ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/SCALE_1_5/) });
    });

    it('shape violation: FREE_TEXT with numericResponse → BadRequest', async () => {
      const studentId = await seedStudent('Shape3');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      const responses = fullValidResponses(tpl, {
        academicFreeText: { numericResponse: 5, textResponse: undefined as any },
      });
      await expect(
        withTestTenant(async () => checkins.submit(checkinId, { responses } as any, adminActor())),
      ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/FREE_TEXT/) });
    });

    it('shape violation: SCALE_1_10 with numericResponse=15 → BadRequest', async () => {
      const studentId = await seedStudent('Shape4');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      const responses = fullValidResponses(tpl, { academicScale110: { numericResponse: 15 } });
      await expect(
        withTestTenant(async () => checkins.submit(checkinId, { responses } as any, adminActor())),
      ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/SCALE_1_10/) });
    });

    it("STUDENT actor can submit their OWN check-in; cannot submit another student's", async () => {
      const myStudentId = await ensureStudentActorProjection();
      const other = await seedStudent('OtherStu');
      const tpl = await seedTemplate();
      const myCheckin = await seedCheckin(myStudentId, tpl.templateId);
      const otherCheckin = await seedCheckin(other, tpl.templateId);
      // own submission works
      await withTestTenant(async () =>
        checkins.submit(myCheckin, { responses: fullValidResponses(tpl) } as any, studentActor()),
      );
      // other student's submission denied
      await expect(
        withTestTenant(async () =>
          checkins.submit(
            otherCheckin,
            { responses: fullValidResponses(tpl) } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-STUDENT, non-admin actor without student projection cannot submit → Forbidden', async () => {
      const studentId = await seedStudent('TeacherSubmit');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await expect(
        withTestTenant(async () =>
          checkins.submit(checkinId, { responses: fullValidResponses(tpl) } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('deployment counter bumps on successful submit', async () => {
      const studentId = await seedStudent('DeployCount');
      const tpl = await seedTemplate();
      // Seed a deployment
      const deploymentId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_deployments
           (id, school_id, template_id, deployed_by, deploy_at, target_type, target_ids, total_targeted, total_completed)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now(), 'SCHOOL', '{}', 1, 0)`,
        deploymentId,
        TEST_SCHOOL_ID,
        tpl.templateId,
        TEST_ADMIN_EMPLOYEE_ID,
      );
      const checkinId = await seedCheckin(studentId, tpl.templateId, { deploymentId });
      await withTestTenant(async () =>
        checkins.submit(checkinId, { responses: fullValidResponses(tpl) } as any, adminActor()),
      );
      const row = (await rawClient.$queryRawUnsafe(
        `SELECT total_completed FROM ${TEST_SCHEMA}.svc_wellbeing_deployments WHERE id = $1::uuid`,
        deploymentId,
      )) as Array<{ total_completed: number }>;
      expect(row[0]!.total_completed).toBe(1);
    });

    it('submit on missing check-in → NotFound', async () => {
      const tpl = await seedTemplate();
      const studentId = await seedStudent('Missing404');
      void studentId;
      await expect(
        withTestTenant(async () =>
          checkins.submit(
            '00000000-0000-0000-0000-000000000000',
            { responses: fullValidResponses(tpl) } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list + getById — row scope strip vs hard 403
  // ────────────────────────────────────────────────────────────────────
  describe('list + getById (row scope)', () => {
    it('STUDENT.list strips flaggedForFollowUp + assignedCounselor from own view (BLOCKING 1)', async () => {
      const myStudentId = await ensureStudentActorProjection();
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(myStudentId, tpl.templateId, {
        assignedCounselorId: TEST_ADMIN_EMPLOYEE_ID,
      });
      // Trigger an SHI alert via admin submit so flagged=true on the row
      await withTestTenant(async () =>
        checkins.submit(
          checkinId,
          {
            responses: fullValidResponses(tpl, { safetyScale15: { numericResponse: 1 } }),
          } as any,
          adminActor(),
        ),
      );
      const ownList = await withTestTenant(async () => checkins.list({}, studentActor()));
      const mine = ownList.find((c) => c.id === checkinId);
      expect(mine).toBeDefined();
      // Student MUST NOT see the flagged status nor the assigned counsellor
      expect(mine!.flaggedForFollowUp).toBe(false);
      expect(mine!.assignedCounselorId).toBeNull();
      expect(mine!.assignedCounselorName).toBeNull();
      // But the row IS in fact flagged at the DB level — strip is service-side
      const dbRow = (await rawClient.$queryRawUnsafe(
        `SELECT flagged_for_follow_up FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE id = $1::uuid`,
        checkinId,
      )) as Array<{ flagged_for_follow_up: boolean }>;
      expect(dbRow[0]!.flagged_for_follow_up).toBe(true);
    });

    it('STUDENT.getById on own check-in: response detail returned with flagged stripped', async () => {
      const myStudentId = await ensureStudentActorProjection();
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(myStudentId, tpl.templateId);
      await withTestTenant(async () =>
        checkins.submit(checkinId, { responses: fullValidResponses(tpl) } as any, adminActor()),
      );
      const dto = await withTestTenant(async () => checkins.getById(checkinId, studentActor()));
      expect(dto.flaggedForFollowUp).toBe(false);
      expect(dto.assignedCounselorId).toBeNull();
      expect((dto as any).responses).toBeDefined();
      expect((dto as any).responses).toHaveLength(5);
    });

    it("STUDENT.getById on another student's check-in → NotFound (row scope)", async () => {
      await ensureStudentActorProjection();
      const otherStu = await seedStudent('OtherForStu');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(otherStu, tpl.templateId);
      await expect(
        withTestTenant(async () => checkins.getById(checkinId, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Non-counsellor STAFF (teacher).list → Forbidden (MAJOR 3 hard-403)', async () => {
      await expect(
        withTestTenant(async () => checkins.list({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Non-counsellor STAFF (teacher).getById → Forbidden (MAJOR 3)', async () => {
      const studentId = await seedStudent('TchView');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await expect(
        withTestTenant(async () => checkins.getById(checkinId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Counsellor sees only own assigned/caseload students; admin sees everything', async () => {
      const onMyCaseload = await seedStudent('MyCase');
      const someoneElse = await seedStudent('NotMine');
      const tpl = await seedTemplate();
      await grantOfficerCounsellor();
      await seedCaseload(onMyCaseload, TEST_OFFICER_EMPLOYEE_ID);
      // Two checkins: one for officer's caseload student, one for someone else
      const cMine = await seedCheckin(onMyCaseload, tpl.templateId);
      const cTheirs = await seedCheckin(someoneElse, tpl.templateId);
      const officerList = await withTestTenant(async () => checkins.list({}, officerActor()));
      const officerIds = officerList.map((c) => c.id);
      expect(officerIds).toContain(cMine);
      expect(officerIds).not.toContain(cTheirs);
      const adminList = await withTestTenant(async () => checkins.list({}, adminActor()));
      const adminIds = adminList.map((c) => c.id);
      expect(adminIds).toContain(cMine);
      expect(adminIds).toContain(cTheirs);
    });

    it('PARENT actor returns empty list (gate-tier fallback)', async () => {
      const result = await withTestTenant(async () => checkins.list({}, parentActor()));
      expect(result).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AlertService — acknowledged_chk lockstep
  // ────────────────────────────────────────────────────────────────────
  describe('AlertService (acknowledged_chk lockstep)', () => {
    async function createAlertedSubmission(): Promise<{
      studentId: string;
      alertId: string;
    }> {
      const studentId = await seedStudent('AlertSrc');
      const tpl = await seedTemplate();
      const checkinId = await seedCheckin(studentId, tpl.templateId);
      await withTestTenant(async () =>
        checkins.submit(
          checkinId,
          {
            responses: fullValidResponses(tpl, { safetyScale15: { numericResponse: 1 } }),
          } as any,
          adminActor(),
        ),
      );
      const rows = await readAlertsForStudent(studentId);
      const alertRowsFull = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.svc_wellbeing_alerts WHERE response_id = $1::uuid LIMIT 1`,
        rows[0]!.response_id,
      )) as Array<{ id: string }>;
      // Admin needs a caseload to load the alert via the non-admin row-scope path,
      // but admin bypasses, so this isn't required for admin tests.
      return { studentId, alertId: alertRowsFull[0]!.id };
    }

    it('admin acknowledge: NEW → ACKNOWLEDGED with acknowledged_by + acknowledged_at stamped together', async () => {
      const { alertId } = await createAlertedSubmission();
      await withTestTenant(async () => alerts.acknowledge(alertId, adminActor()));
      const row = (await rawClient.$queryRawUnsafe(
        `SELECT status, acknowledged_by::text AS acknowledged_by, acknowledged_at
           FROM ${TEST_SCHEMA}.svc_wellbeing_alerts WHERE id = $1::uuid`,
        alertId,
      )) as Array<{ status: string; acknowledged_by: string; acknowledged_at: string }>;
      expect(row[0]!.status).toBe('ACKNOWLEDGED');
      expect(row[0]!.acknowledged_by).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(row[0]!.acknowledged_at).not.toBeNull();
    });

    it('admin resolve from NEW (skip-ack fast path): single UPDATE stamps ack + resolved together', async () => {
      const { alertId } = await createAlertedSubmission();
      await withTestTenant(async () =>
        alerts.resolve(alertId, { resolutionNotes: 'safety plan in place' } as any, adminActor()),
      );
      const row = (await rawClient.$queryRawUnsafe(
        `SELECT status, acknowledged_by::text AS acknowledged_by, acknowledged_at, resolution_notes
           FROM ${TEST_SCHEMA}.svc_wellbeing_alerts WHERE id = $1::uuid`,
        alertId,
      )) as Array<{
        status: string;
        acknowledged_by: string;
        acknowledged_at: string;
        resolution_notes: string;
      }>;
      expect(row[0]!.status).toBe('RESOLVED');
      expect(row[0]!.acknowledged_by).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(row[0]!.acknowledged_at).not.toBeNull();
      expect(row[0]!.resolution_notes).toBe('safety plan in place');
    });

    it('cannot acknowledge an already-RESOLVED alert → BadRequest', async () => {
      const { alertId } = await createAlertedSubmission();
      await withTestTenant(async () =>
        alerts.resolve(alertId, { resolutionNotes: 'done' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => alerts.acknowledge(alertId, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cannot resolve an already-RESOLVED alert → BadRequest', async () => {
      const { alertId } = await createAlertedSubmission();
      await withTestTenant(async () =>
        alerts.resolve(alertId, { resolutionNotes: 'first' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          alerts.resolve(alertId, { resolutionNotes: 'second' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
      ['officer (no cou-004:write)', officerActor],
    ])('acknowledge/resolve as %s → Forbidden', async (_label, actor) => {
      const { alertId } = await createAlertedSubmission();
      await expect(
        withTestTenant(async () => alerts.acknowledge(alertId, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          alerts.resolve(alertId, { resolutionNotes: 'x' } as any, actor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('synthetic admin without employeeId cannot acknowledge', async () => {
      const { alertId } = await createAlertedSubmission();
      const adminNoEmp: ResolvedActor = {
        accountId: '019e0cf8-aaaa-7777-8888-000000000011',
        personId: '019e0cf8-aaaa-7777-8888-000000000010',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(async () => alerts.acknowledge(alertId, adminNoEmp)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('acknowledge missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          alerts.acknowledge('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
