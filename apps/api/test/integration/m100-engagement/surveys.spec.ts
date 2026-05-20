import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ParentSurveyService } from '@modules/m100-engagement/parent-survey.service';
import { deterministicSurveyOpenedEventId } from '@modules/m100-engagement/event-ids';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  TEST_PARENT_ACCOUNT_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { resetEngagementTables } from '../fixtures/engagement';

/**
 * Wave 7 — m100-engagement surveys suite.
 *
 * Covers ParentSurveyService:
 *   - list / getById with parent OPEN-only visibility
 *   - admin getResults gate
 *   - create (DRAFT) with question shape validation
 *   - patch state machine DRAFT→OPEN (emits eng.survey.opened via outbox)
 *     →CLOSED; immutable transitions
 *   - submitResponse — anonymity keystone (no respondent_id stored when
 *     is_anonymous=true); identified surveys: 1-per-respondent; 409 on duplicate
 *   - response validation: per-question_type bounds
 *   - cross-school isolation
 */
describe('integration:m100-engagement/surveys', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let surveys: ParentSurveyService;
  let outbox: OutboxService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    surveys = new ParentSurveyService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEngagementTables(rawClient);
  });

  function isoFuture(hours: number): string {
    return new Date(Date.now() + hours * 3600_000).toISOString();
  }

  function isoPast(hours: number): string {
    return new Date(Date.now() - hours * 3600_000).toISOString();
  }

  function baseQuestions(): any[] {
    return [
      {
        id: 'q1',
        question_text: 'Rate the experience',
        question_type: 'RATING_1_5',
      },
      {
        id: 'q2',
        question_text: 'Would you recommend?',
        question_type: 'YES_NO',
      },
      {
        id: 'q3',
        question_text: 'Best season',
        question_type: 'MULTIPLE_CHOICE',
        options: ['Fall', 'Spring'],
      },
      {
        id: 'q4',
        question_text: 'Comments',
        question_type: 'FREE_TEXT',
      },
      {
        id: 'q5',
        question_text: 'Overall',
        question_type: 'RATING_1_10',
      },
    ];
  }

  async function createSurvey(opts?: {
    isAnonymous?: boolean;
    schoolId?: string;
  }): Promise<string> {
    if (opts?.schoolId && opts.schoolId !== TEST_SCHOOL_ID) {
      // Direct insert for School B so we don't touch the actor-tenant context.
      const id = generatedUuid();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.eng_parent_surveys
           (id, school_id, title, questions, is_anonymous, status, total_responses,
            response_data_aggregated, responses, created_by)
         VALUES ($1::uuid, $2::uuid, 'Direct B', $3::jsonb, $4, 'DRAFT', 0,
                 '{}'::jsonb, '[]'::jsonb, $5::uuid)`,
        id,
        opts.schoolId,
        JSON.stringify(baseQuestions()),
        opts?.isAnonymous ?? true,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }
    const dto = await withTestTenant(async () =>
      surveys.create(adminActor(), {
        title: 'Family Satisfaction',
        description: 'Quarterly survey',
        questions: baseQuestions(),
        isAnonymous: opts?.isAnonymous ?? true,
      } as any),
    );
    return dto.id;
  }

  // 8-4-4-4-12 v4-shape hex generator for the direct-insert path
  function generatedUuid(): string {
    const hex = (n: number) => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${hex(0)}${hex(0)}-${hex(0)}-4${hex(0).slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(0).slice(1)}-${hex(0)}${hex(0)}${hex(0)}`;
  }

  // ────────────────────────────────────────────────────────────────────
  // create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates DRAFT survey', async () => {
      const dto = await withTestTenant(async () =>
        surveys.create(adminActor(), {
          title: 'X',
          questions: baseQuestions(),
        } as any),
      );
      expect(dto.status).toBe('DRAFT');
      expect(dto.isAnonymous).toBe(true);
      expect(dto.totalResponses).toBe(0);
      expect(dto.questions.length).toBe(5);
    });

    it('parent → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.create(parentActor(), {
            title: 'X',
            questions: baseQuestions(),
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('empty questions array → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.create(adminActor(), { title: 'X', questions: [] } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate question id → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.create(adminActor(), {
            title: 'X',
            questions: [
              { id: 'a', question_text: 'q', question_type: 'YES_NO' },
              { id: 'a', question_text: 'q', question_type: 'YES_NO' },
            ],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('multiple-choice without options → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.create(adminActor(), {
            title: 'X',
            questions: [
              { id: 'a', question_text: 'q', question_type: 'MULTIPLE_CHOICE' },
            ],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing required question fields → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.create(adminActor(), {
            title: 'X',
            questions: [{ id: 'a' } as any],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('closesAt <= opensAt → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.create(adminActor(), {
            title: 'X',
            questions: baseQuestions(),
            opensAt: isoFuture(48),
            closesAt: isoFuture(24),
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list / getById visibility
  // ────────────────────────────────────────────────────────────────────
  describe('list / getById visibility', () => {
    it('admin sees DRAFT + OPEN + CLOSED', async () => {
      await createSurvey();
      const list = await withTestTenant(async () => surveys.list(adminActor()));
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('parent sees only OPEN', async () => {
      const id1 = await createSurvey(); // DRAFT
      // Flip to OPEN
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id1, { status: 'OPEN' } as any),
      );
      const id2 = await createSurvey(); // DRAFT — should not be visible to parent

      const listP = await withTestTenant(async () => surveys.list(parentActor()));
      const ids = listP.map((s) => s.id);
      expect(ids).toContain(id1);
      expect(ids).not.toContain(id2);
    });

    it('getById: admin reads DRAFT', async () => {
      const id = await createSurvey();
      const dto = await withTestTenant(async () => surveys.getById(adminActor(), id));
      expect(dto.id).toBe(id);
    });

    it('getById: parent reading DRAFT → NotFoundException', async () => {
      const id = await createSurvey();
      await expect(
        withTestTenant(async () => surveys.getById(parentActor(), id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // patch / state machine
  // ────────────────────────────────────────────────────────────────────
  describe('patch / state machine', () => {
    it('DRAFT → OPEN emits eng.survey.opened outbox', async () => {
      const id = await createSurvey();
      const opened = await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
      );
      expect(opened.status).toBe('OPEN');
      expect(opened.openedAt).toBeTruthy();

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; envelope: string }>
      >(
        `SELECT topic, envelope::text AS envelope FROM platform.platform_outbox
           WHERE topic = 'eng.survey.opened' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(rows.length).toBe(1);
      const env = JSON.parse(rows[0]!.envelope);
      expect(env.event_id).toBe(deterministicSurveyOpenedEventId(id));
      expect(env.payload.surveyId).toBe(id);
    });

    it('OPEN → CLOSED sets closed_at', async () => {
      const id = await createSurvey();
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
      );
      const closed = await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'CLOSED' } as any),
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).toBeTruthy();
    });

    it('OPEN → DRAFT rejected — invalid transition', async () => {
      const id = await createSurvey();
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
      );
      await expect(
        withTestTenant(async () =>
          surveys.patch(adminActor(), id, { status: 'DRAFT' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CLOSED → OPEN rejected — terminal', async () => {
      const id = await createSurvey();
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
      );
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'CLOSED' } as any),
      );
      await expect(
        withTestTenant(async () =>
          surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('parent → ForbiddenException', async () => {
      const id = await createSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.patch(parentActor(), id, { title: 'X' } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.patch(adminActor(), '00000000-0000-0000-0000-000000000000', {
            title: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('title / description / questions update', async () => {
      const id = await createSurvey();
      const dto = await withTestTenant(async () =>
        surveys.patch(adminActor(), id, {
          title: 'Renamed',
          description: 'updated',
          questions: baseQuestions(),
          opensAt: isoFuture(24),
          closesAt: isoFuture(72),
        } as any),
      );
      expect(dto.title).toBe('Renamed');
      expect(dto.description).toBe('updated');
    });

    it('merged closesAt <= opensAt → BadRequestException', async () => {
      const id = await createSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.patch(adminActor(), id, {
            opensAt: isoFuture(72),
            closesAt: isoFuture(24),
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty body → no-op DTO read', async () => {
      const id = await createSurvey();
      const dto = await withTestTenant(async () =>
        surveys.patch(adminActor(), id, {} as any),
      );
      expect(dto.id).toBe(id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // submitResponse — ANONYMITY KEYSTONE + dedup
  // ────────────────────────────────────────────────────────────────────
  describe('submitResponse', () => {
    async function openSurvey(opts?: { isAnonymous?: boolean }): Promise<string> {
      const id = await createSurvey({ isAnonymous: opts?.isAnonymous ?? true });
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
      );
      return id;
    }

    it('anonymous: respondent_id is NOT stored on the response row', async () => {
      const id = await openSurvey({ isAnonymous: true });
      const result = await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, {
          answers: { q1: 5, q2: 'yes', q3: 'Fall', q4: 'thanks', q5: 9 },
        } as any),
      );
      expect(result.submitted).toBe(true);
      expect(result.totalResponses).toBe(1);

      const rows = await rawClient.$queryRawUnsafe<Array<{ responses: string }>>(
        `SELECT responses::text AS responses FROM ${TEST_SCHEMA}.eng_parent_surveys WHERE id = $1::uuid`,
        id,
      );
      const parsed = JSON.parse(rows[0]!.responses);
      expect(parsed.length).toBe(1);
      expect(parsed[0].respondent_id).toBeUndefined();
      expect(parsed[0].answers.q1).toBe(5);
    });

    it('identified: respondent_id stored on row', async () => {
      const id = await openSurvey({ isAnonymous: false });
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, {
          answers: { q1: 4 },
        } as any),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ responses: string }>>(
        `SELECT responses::text AS responses FROM ${TEST_SCHEMA}.eng_parent_surveys WHERE id = $1::uuid`,
        id,
      );
      const parsed = JSON.parse(rows[0]!.responses);
      expect(parsed[0].respondent_id).toBe(TEST_PARENT_ACCOUNT_ID);
    });

    it('identified: second submit by same respondent → 409 ConflictException', async () => {
      const id = await openSurvey({ isAnonymous: false });
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q1: 3 } } as any),
      );
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { q1: 4 } } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('anonymous: same respondent CAN submit twice (no dedup)', async () => {
      const id = await openSurvey({ isAnonymous: true });
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q1: 1 } } as any),
      );
      const r = await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q1: 5 } } as any),
      );
      expect(r.totalResponses).toBe(2);
    });

    it('student persona → ForbiddenException', async () => {
      const id = await openSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(studentActor(), id, { answers: {} } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('DRAFT survey → BadRequestException', async () => {
      const id = await createSurvey(); // DRAFT
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { q1: 3 } } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing survey → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), '00000000-0000-0000-0000-000000000000', {
            answers: {},
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unknown question id → BadRequestException', async () => {
      const id = await openSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { bogus: 1 } } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rating bounds enforced — RATING_1_5 = 7 rejected', async () => {
      const id = await openSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { q1: 7 } } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rating bounds enforced — RATING_1_10 = 0 rejected', async () => {
      const id = await openSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { q5: 0 } } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('YES_NO accepts boolean and string variants', async () => {
      const id = await openSurvey({ isAnonymous: true });
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q2: true } } as any),
      );
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q2: 'no' } } as any),
      );
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q2: 'YES' } } as any),
      );
      const r = await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q2: false } } as any),
      );
      expect(r.totalResponses).toBe(4);
    });

    it('YES_NO with invalid value → BadRequestException', async () => {
      const id = await openSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { q2: 'maybe' } } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('FREE_TEXT > 5000 chars → BadRequestException', async () => {
      const id = await openSurvey();
      const big = 'x'.repeat(5001);
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { q4: big } } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('MULTIPLE_CHOICE non-string → BadRequestException', async () => {
      const id = await openSurvey();
      await expect(
        withTestTenant(async () =>
          surveys.submitResponse(parentActor(), id, { answers: { q3: 5 } } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('aggregates: RATING_1_5 distribution + average computed', async () => {
      const id = await openSurvey({ isAnonymous: true });
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q1: 5, q3: 'Fall' } } as any),
      );
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, { answers: { q1: 3, q3: 'Spring' } } as any),
      );
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ response_data_aggregated: string }>
      >(
        `SELECT response_data_aggregated::text AS response_data_aggregated FROM ${TEST_SCHEMA}.eng_parent_surveys WHERE id = $1::uuid`,
        id,
      );
      const agg = JSON.parse(rows[0]!.response_data_aggregated);
      expect(agg.q1.count).toBe(2);
      expect(agg.q1.average).toBe(4);
      expect(agg.q1.distribution['5']).toBe(1);
      expect(agg.q1.distribution['3']).toBe(1);
      expect(agg.q3.distribution.Fall).toBe(1);
      expect(agg.q3.distribution.Spring).toBe(1);
    });

    it('aggregates: YES_NO tally + FREE_TEXT count only', async () => {
      const id = await openSurvey({ isAnonymous: true });
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, {
          answers: { q2: true, q4: 'good' },
        } as any),
      );
      await withTestTenant(async () =>
        surveys.submitResponse(parentActor(), id, {
          answers: { q2: false, q4: 'bad' },
        } as any),
      );
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ response_data_aggregated: string }>
      >(
        `SELECT response_data_aggregated::text AS response_data_aggregated FROM ${TEST_SCHEMA}.eng_parent_surveys WHERE id = $1::uuid`,
        id,
      );
      const agg = JSON.parse(rows[0]!.response_data_aggregated);
      expect(agg.q2.yes).toBe(1);
      expect(agg.q2.no).toBe(1);
      expect(agg.q4.count).toBe(2);
      // FREE_TEXT MUST NOT leak text — no distribution / values key
      expect(agg.q4.distribution).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getResults
  // ────────────────────────────────────────────────────────────────────
  describe('getResults', () => {
    it('admin reads aggregated results', async () => {
      const id = await createSurvey();
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
      );
      const r = await withTestTenant(async () =>
        surveys.getResults(adminActor(), id),
      );
      expect(r.id).toBe(id);
    });

    it('parent → ForbiddenException', async () => {
      const id = await createSurvey();
      await withTestTenant(async () =>
        surveys.patch(adminActor(), id, { status: 'OPEN' } as any),
      );
      await expect(
        withTestTenant(async () => surveys.getResults(parentActor(), id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cross-school
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school', () => {
    it('School B survey invisible to School A admin', async () => {
      const bId = await createSurvey({ schoolId: TEST_SCHOOL_B_ID });
      const listA = await withTestTenant(async () => surveys.list(adminActor()));
      expect(listA.find((s) => s.id === bId)).toBeUndefined();

      await expect(
        withTestTenant(async () => surveys.getById(adminActor(), bId)),
      ).rejects.toBeInstanceOf(NotFoundException);

      const listB = await withTestTenantB(async () => surveys.list(adminActor()));
      expect(listB.map((s) => s.id)).toContain(bId);
    });
  });
});
