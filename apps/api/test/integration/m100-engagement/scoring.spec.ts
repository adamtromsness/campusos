import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  EngagementScoreService,
  computeCompositeScore,
  resolveEngagementLevel,
  DEFAULT_WEIGHTS,
  DEFAULT_THRESHOLDS,
} from '@modules/m100-engagement/engagement-score.service';
import { EngagementScoreWorker } from '@modules/m100-engagement/engagement-score.worker';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { ResolvedActor } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  teacherActor,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { resetEngagementTables } from '../fixtures/engagement';
import { seedStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

/**
 * Wave 7 — m100-engagement scoring suite.
 *
 * Covers:
 *   - EngagementScoreService.list / getForFamily / summary read paths
 *   - Component visibility — only ENG-001:admin sees component_*; non-admin
 *     sees composite_score + engagement_level only (P2-H1 Step 5)
 *   - updateConfig — weight sum 100 validation + threshold ordering
 *   - upsertScore idempotent on UNIQUE(family_account_id, score_date)
 *   - EngagementScoreWorker.tickForSchool — drives the 5-source compute
 *     against seeded attendance + invoice rows
 *   - Cross-school: a score in School B is invisible to a School A listing
 */
describe('integration:m100-engagement/scoring', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let scores: EngagementScoreService;
  let worker: EngagementScoreWorker;

  const studentIds: string[] = [];
  const platformStudentIds: string[] = [];
  const guardianIds: string[] = [];
  const personIds: string[] = [];
  const accountIds: string[] = [];
  const familyAccountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    scores = new EngagementScoreService(tenantPrisma, permCheck);
    worker = new EngagementScoreWorker(tenantPrisma, scores);

    // P2-H1 Step 5 component-visibility test — seed eng-001:read for the
    // teacher actor at the test School scope so assertEngagementReader
    // passes but isEngagementAdmin returns false (no eng-001:admin code
    // and isSchoolAdmin=false). Direct iam_effective_access_cache insert
    // because the test schema does not run the full IAM seed.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, now(), 'fixture-v1')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['eng-001:read'],
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEngagementTables(rawClient, {
      familyAccountIds: familyAccountIds.splice(0),
      wipeAllFamilyAccounts: true,
    });
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  /** Fake admin / non-admin actors for component visibility tests. */
  function syntheticAdmin(): ResolvedActor {
    return adminActor();
  }
  function syntheticNonAdmin(): ResolvedActor {
    // teacher actor — STAFF + isSchoolAdmin=false. ENG-001:read is held
    // via teacher role assignments in seeded IAM (assertEngagementReader
    // passes), but ENG-001:admin is admin-only so isEngagementAdmin=false.
    return teacherActor();
  }

  async function seedFamilyAccount(opts?: {
    schoolId?: string;
    holderId?: string;
  }): Promise<string> {
    const id = generateId();
    // pay_family_accounts has UNIQUE (school_id, account_holder_id) — mint
    // a fresh holder iam_person for each account unless the caller pinned
    // it (e.g. tests that need the parent actor as holder for guardian
    // link paths use TEST_PARENT_PERSON_ID explicitly).
    let holderId = opts?.holderId;
    if (!holderId) {
      holderId = generateId();
      personIds.push(holderId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Scoring', 'Holder', 'GUARDIAN', true)`,
        holderId,
      );
    }
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
      id,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      holderId,
      'FA-' + id.replace(/-/g, '').slice(0, 24),
    );
    familyAccountIds.push(id);
    return id;
  }

  async function seedScore(opts: {
    familyAccountId: string;
    scoreDate: string;
    schoolId?: string;
    composite?: number;
    level?: 'HIGHLY_ENGAGED' | 'ENGAGED' | 'MINIMAL' | 'AT_RISK';
    components?: {
      attendance: number;
      communication: number;
      conference: number;
      volunteer: number;
      payment: number;
    };
  }): Promise<string> {
    const id = generateId();
    const c = opts.components ?? {
      attendance: 90,
      communication: 80,
      conference: 50,
      volunteer: 60,
      payment: 100,
    };
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.eng_family_engagement_scores
         (id, school_id, family_account_id, score_date, composite_score,
          attendance_component, communication_component, conference_component,
          volunteer_component, payment_component, engagement_level, component_weights, computed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5,
               $6, $7, $8, $9, $10, $11, $12::jsonb, now())`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.familyAccountId,
      opts.scoreDate,
      opts.composite ?? 80,
      c.attendance,
      c.communication,
      c.conference,
      c.volunteer,
      c.payment,
      opts.level ?? 'HIGHLY_ENGAGED',
      JSON.stringify(DEFAULT_WEIGHTS),
    );
    return id;
  }

  // ────────────────────────────────────────────────────────────────────
  // Pure helpers — computeCompositeScore + resolveEngagementLevel
  // ────────────────────────────────────────────────────────────────────
  describe('pure helpers', () => {
    it('computeCompositeScore — weighted average with default weights', async () => {
      const c = {
        attendance: 100,
        communication: 100,
        conference: 100,
        volunteer: 100,
        payment: 100,
      };
      const sc = computeCompositeScore(c, DEFAULT_WEIGHTS);
      expect(sc).toBe(100);
    });

    it('computeCompositeScore — clamps out-of-range values', async () => {
      const c = {
        attendance: -10,
        communication: 200,
        conference: 50,
        volunteer: NaN,
        payment: 50,
      };
      const sc = computeCompositeScore(c, DEFAULT_WEIGHTS);
      expect(sc).toBeGreaterThan(0);
      expect(sc).toBeLessThanOrEqual(100);
    });

    it('computeCompositeScore — totalWeight=0 returns 0', async () => {
      const c = { attendance: 80, communication: 80, conference: 80, volunteer: 80, payment: 80 };
      const sc = computeCompositeScore(c, {
        attendance: 0,
        communication: 0,
        conference: 0,
        volunteer: 0,
        payment: 0,
      });
      expect(sc).toBe(0);
    });

    it('resolveEngagementLevel — bucket boundaries', async () => {
      expect(resolveEngagementLevel(80, DEFAULT_THRESHOLDS)).toBe('HIGHLY_ENGAGED');
      expect(resolveEngagementLevel(60, DEFAULT_THRESHOLDS)).toBe('ENGAGED');
      expect(resolveEngagementLevel(30, DEFAULT_THRESHOLDS)).toBe('MINIMAL');
      expect(resolveEngagementLevel(10, DEFAULT_THRESHOLDS)).toBe('AT_RISK');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // upsertScore — idempotent on UNIQUE(family_account_id, score_date)
  // ────────────────────────────────────────────────────────────────────
  describe('upsertScore', () => {
    it('first call inserts; second call updates the row in place', async () => {
      const fa = await seedFamilyAccount();
      const today = new Date().toISOString().slice(0, 10);

      const first = await withTestTenant(async () =>
        scores.upsertScore({
          schoolId: TEST_SCHOOL_ID,
          familyAccountId: fa,
          scoreDate: today,
          components: {
            attendance: 70,
            communication: 70,
            conference: 50,
            volunteer: 40,
            payment: 80,
          },
          weights: DEFAULT_WEIGHTS,
          thresholds: DEFAULT_THRESHOLDS,
        }),
      );
      expect(first.compositeScore).toBeGreaterThan(0);

      const second = await withTestTenant(async () =>
        scores.upsertScore({
          schoolId: TEST_SCHOOL_ID,
          familyAccountId: fa,
          scoreDate: today,
          components: {
            attendance: 100,
            communication: 100,
            conference: 100,
            volunteer: 100,
            payment: 100,
          },
          weights: DEFAULT_WEIGHTS,
          thresholds: DEFAULT_THRESHOLDS,
        }),
      );
      expect(second.compositeScore).toBe(100);

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: bigint | number }>>(
        `SELECT COUNT(*)::int AS count FROM ${TEST_SCHEMA}.eng_family_engagement_scores
           WHERE family_account_id = $1::uuid AND score_date = $2::date`,
        fa,
        today,
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list / getForFamily / summary
  // ────────────────────────────────────────────────────────────────────
  describe('list / getForFamily / summary', () => {
    it('list: admin reads with component_* populated', async () => {
      const fa = await seedFamilyAccount();
      await seedScore({ familyAccountId: fa, scoreDate: '2026-05-01' });
      const list = await withTestTenant(async () => scores.list(syntheticAdmin()));
      expect(list.length).toBe(1);
      expect(list[0]!.attendanceComponent).not.toBeNull();
      expect(list[0]!.componentWeights).not.toBeNull();
    });

    it('list: non-admin reader sees stripped components', async () => {
      const fa = await seedFamilyAccount();
      await seedScore({ familyAccountId: fa, scoreDate: '2026-05-01' });
      const list = await withTestTenant(async () => scores.list(syntheticNonAdmin()));
      expect(list.length).toBe(1);
      expect(list[0]!.attendanceComponent).toBeNull();
      expect(list[0]!.communicationComponent).toBeNull();
      expect(list[0]!.conferenceComponent).toBeNull();
      expect(list[0]!.volunteerComponent).toBeNull();
      expect(list[0]!.paymentComponent).toBeNull();
      expect(list[0]!.componentWeights).toBeNull();
      // composite + level still visible
      expect(list[0]!.compositeScore).toBeGreaterThan(0);
      expect(list[0]!.engagementLevel).toBeTruthy();
    });

    it('list: parent → ForbiddenException', async () => {
      await expect(withTestTenant(async () => scores.list(parentActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('list: student → ForbiddenException', async () => {
      await expect(withTestTenant(async () => scores.list(studentActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('list: filter by level + scoreDate', async () => {
      const fa = await seedFamilyAccount();
      await seedScore({
        familyAccountId: fa,
        scoreDate: '2026-04-01',
        level: 'ENGAGED',
        composite: 60,
      });
      await seedScore({ familyAccountId: fa, scoreDate: '2026-05-01', level: 'HIGHLY_ENGAGED' });

      const lvl = await withTestTenant(async () =>
        scores.list(syntheticAdmin(), { level: 'ENGAGED', scoreDate: '2026-04-01' }),
      );
      expect(lvl.length).toBe(1);
      expect(lvl[0]!.engagementLevel).toBe('ENGAGED');
    });

    it('list: default returns latest score per family across school', async () => {
      const fa = await seedFamilyAccount();
      await seedScore({
        familyAccountId: fa,
        scoreDate: '2026-04-01',
        composite: 60,
        level: 'ENGAGED',
      });
      await seedScore({
        familyAccountId: fa,
        scoreDate: '2026-05-01',
        composite: 80,
        level: 'HIGHLY_ENGAGED',
      });
      const list = await withTestTenant(async () => scores.list(syntheticAdmin()));
      // Default: latest score_date only
      expect(list.length).toBe(1);
      expect(list[0]!.scoreDate.startsWith('2026-05-01')).toBe(true);
    });

    it('getForFamily: returns score history descending by date', async () => {
      const fa = await seedFamilyAccount();
      await seedScore({
        familyAccountId: fa,
        scoreDate: '2026-04-01',
        composite: 60,
        level: 'ENGAGED',
      });
      await seedScore({
        familyAccountId: fa,
        scoreDate: '2026-05-01',
        composite: 80,
        level: 'HIGHLY_ENGAGED',
      });
      const history = await withTestTenant(async () => scores.getForFamily(syntheticAdmin(), fa));
      expect(history.length).toBe(2);
      expect(history[0]!.scoreDate.startsWith('2026-05-01')).toBe(true);
    });

    it('getForFamily: non-admin gets stripped components', async () => {
      const fa = await seedFamilyAccount();
      await seedScore({ familyAccountId: fa, scoreDate: '2026-05-01' });
      const r = await withTestTenant(async () => scores.getForFamily(syntheticNonAdmin(), fa));
      expect(r[0]!.attendanceComponent).toBeNull();
    });

    it('getForFamily: parent → ForbiddenException', async () => {
      const fa = await seedFamilyAccount();
      await expect(
        withTestTenant(async () => scores.getForFamily(parentActor(), fa)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('summary: counts per level + average + most-recent date', async () => {
      const fa1 = await seedFamilyAccount();
      const fa2 = await seedFamilyAccount();
      await seedScore({
        familyAccountId: fa1,
        scoreDate: '2026-05-01',
        composite: 90,
        level: 'HIGHLY_ENGAGED',
      });
      await seedScore({
        familyAccountId: fa2,
        scoreDate: '2026-05-01',
        composite: 60,
        level: 'ENGAGED',
      });

      const summary = await withTestTenant(async () => scores.summary(syntheticAdmin()));
      expect(summary.totalFamilies).toBe(2);
      expect(summary.byLevel.HIGHLY_ENGAGED).toBe(1);
      expect(summary.byLevel.ENGAGED).toBe(1);
      expect(summary.averageScore).toBe(75);
      expect(summary.scoreDate).toContain('2026-05-01');
    });

    it('summary: no scores → zeros', async () => {
      const summary = await withTestTenant(async () => scores.summary(syntheticAdmin()));
      expect(summary.totalFamilies).toBe(0);
      expect(summary.averageScore).toBe(0);
      expect(summary.scoreDate).toBeNull();
    });

    it('cross-school: School A admin does not see School B score', async () => {
      const faB = await seedFamilyAccount({ schoolId: TEST_SCHOOL_B_ID });
      await seedScore({
        familyAccountId: faB,
        schoolId: TEST_SCHOOL_B_ID,
        scoreDate: '2026-05-01',
      });

      const listA = await withTestTenant(async () => scores.list(syntheticAdmin()));
      expect(listA.length).toBe(0);

      const listB = await withTestTenantB(async () => scores.list(syntheticAdmin()));
      expect(listB.length).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // updateConfig — weights/thresholds validation
  // ────────────────────────────────────────────────────────────────────
  describe('updateConfig', () => {
    it('admin reads defaults via getConfig when nothing in school_config', async () => {
      const cfg = await withTestTenant(async () => scores.getConfig(syntheticAdmin()));
      expect(cfg.weights.attendance).toBe(DEFAULT_WEIGHTS.attendance);
      expect(cfg.thresholds.highlyEngaged).toBe(DEFAULT_THRESHOLDS.highlyEngaged);
    });

    it('admin updates weights summing to 100', async () => {
      const cfg = await withTestTenant(async () =>
        scores.updateConfig(syntheticAdmin(), {
          weights: {
            attendance: 30,
            communication: 20,
            conference: 20,
            volunteer: 15,
            payment: 15,
          },
        } as any),
      );
      expect(cfg.weights.attendance).toBe(30);
    });

    it('weights summing != 100 → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          scores.updateConfig(syntheticAdmin(), {
            weights: {
              attendance: 10,
              communication: 10,
              conference: 10,
              volunteer: 10,
              payment: 10,
            },
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('thresholds — invalid ordering → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          scores.updateConfig(syntheticAdmin(), {
            thresholds: { highlyEngaged: 30, engaged: 60, minimal: 10 },
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('thresholds — minimal < 0 → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          scores.updateConfig(syntheticAdmin(), {
            thresholds: { highlyEngaged: 80, engaged: 50, minimal: -5 },
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('thresholds — highlyEngaged > 100 → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          scores.updateConfig(syntheticAdmin(), {
            thresholds: { highlyEngaged: 120, engaged: 50, minimal: 10 },
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('thresholds — valid update', async () => {
      const cfg = await withTestTenant(async () =>
        scores.updateConfig(syntheticAdmin(), {
          thresholds: { highlyEngaged: 80, engaged: 50, minimal: 20 },
        } as any),
      );
      expect(cfg.thresholds.highlyEngaged).toBe(80);
      expect(cfg.thresholds.engaged).toBe(50);
    });

    it('parent → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          scores.updateConfig(parentActor(), {
            weights: {
              attendance: 20,
              communication: 25,
              conference: 25,
              volunteer: 15,
              payment: 15,
            },
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher (non-admin) → ForbiddenException for updateConfig', async () => {
      await expect(
        withTestTenant(async () =>
          scores.updateConfig(syntheticNonAdmin(), {
            weights: {
              attendance: 20,
              communication: 25,
              conference: 25,
              volunteer: 15,
              payment: 15,
            },
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('loadWeights reads persisted JSON; legacy snake_case key tolerated', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.school_config (id, config_key, config_value)
         VALUES ($1::uuid, 'engagement_level_thresholds', $2::jsonb)
         ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
        generateId(),
        JSON.stringify({ highly_engaged: 70, engaged: 50, minimal: 20 }),
      );
      const t = await withTestTenant(async () => scores.loadThresholds());
      expect(t.highlyEngaged).toBe(70);
    });

    it('loadWeights — corrupted JSON falls back to defaults', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.school_config (id, config_key, config_value)
         VALUES ($1::uuid, 'engagement_score_weights', $2::jsonb)
         ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
        generateId(),
        JSON.stringify(['not', 'an', 'object']),
      );
      const w = await withTestTenant(async () => scores.loadWeights());
      expect(w.attendance).toBe(DEFAULT_WEIGHTS.attendance);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // EngagementScoreWorker — tickForSchool drives 5-source compute
  // ────────────────────────────────────────────────────────────────────
  describe('EngagementScoreWorker.tickForSchool', () => {
    it('no family accounts → returns 0', async () => {
      const n = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      expect(n).toBe(0);
    });

    it('one family → returns 1 and inserts a row for today', async () => {
      const fa = await seedFamilyAccount();
      const n = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      expect(n).toBe(1);
      const today = new Date().toISOString().slice(0, 10);
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ composite_score: number; engagement_level: string; payment_component: number }>
      >(
        `SELECT composite_score, engagement_level, payment_component
           FROM ${TEST_SCHEMA}.eng_family_engagement_scores
          WHERE family_account_id = $1::uuid AND score_date = $2::date`,
        fa,
        today,
      );
      expect(rows.length).toBe(1);
      // No invoices = 100% payment component (no overdue bills)
      expect(Number(rows[0]!.payment_component)).toBe(100);
    });

    it('attendance + payment components computed against seeded rows', async () => {
      const fa = await seedFamilyAccount();
      // Seed a student in School A linked to the family
      const stu = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_ID });
      personIds.push(stu.personId);
      platformStudentIds.push(stu.platformStudentId);
      studentIds.push(stu.studentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_account_students (id, family_account_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        fa,
        stu.studentId,
      );

      // Seed attendance rows — partition key class_id + school_year required
      const classId = generateId();
      const today = new Date();
      // school_year = first day of August in the running academic year for that date.
      const monthIdx = today.getUTCMonth();
      const yr = monthIdx >= 7 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
      const schoolYear = `${yr}-08-01`;
      const todayDate = today.toISOString().slice(0, 10);
      for (let i = 0; i < 3; i += 1) {
        const rid = generateId();
        const dStr = new Date(today.getTime() - i * 86400_000).toISOString().slice(0, 10);
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.sis_attendance_records
             (id, school_id, school_year, student_id, class_id, date, period, status, confirmation_status)
           VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::date, 'P1', $7, 'CONFIRMED')`,
          rid,
          TEST_SCHOOL_ID,
          schoolYear,
          stu.studentId,
          classId,
          dStr,
          i === 0 ? 'ABSENT' : 'PRESENT',
        );
      }

      // Seed one paid invoice + one CANCELLED for the family
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_invoices (id, school_id, family_account_id, title, total_amount, status, sent_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'A', 100, 'PAID', now())`,
        TEST_SCHOOL_ID,
        fa,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_invoices (id, school_id, family_account_id, title, total_amount, status, sent_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'B', 100, 'OVERDUE', now())`,
        TEST_SCHOOL_ID,
        fa,
      );

      await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      const todayStr = todayDate;
      const rows = await rawClient.$queryRawUnsafe<
        Array<{
          attendance_component: number;
          payment_component: number;
          composite_score: number;
        }>
      >(
        `SELECT attendance_component, payment_component, composite_score
           FROM ${TEST_SCHEMA}.eng_family_engagement_scores
          WHERE family_account_id = $1::uuid AND score_date = $2::date`,
        fa,
        todayStr,
      );
      // 2/3 attended = 67
      expect(Number(rows[0]!.attendance_component)).toBeGreaterThan(50);
      // 1/2 paid = 50
      expect(Number(rows[0]!.payment_component)).toBe(50);
    });

    it('re-running on the same day is idempotent (UPSERT)', async () => {
      const fa = await seedFamilyAccount();
      await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      const today = new Date().toISOString().slice(0, 10);
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
           FROM ${TEST_SCHEMA}.eng_family_engagement_scores
          WHERE family_account_id = $1::uuid AND score_date = $2::date`,
        fa,
        today,
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it('school-scoped: a School B family is not scored by a School A tick', async () => {
      const faB = await seedFamilyAccount({ schoolId: TEST_SCHOOL_B_ID });
      const _faA = await seedFamilyAccount({ schoolId: TEST_SCHOOL_ID });
      const n = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      // Only the School A family is processed
      expect(n).toBe(1);
      const today = new Date().toISOString().slice(0, 10);
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM ${TEST_SCHEMA}.eng_family_engagement_scores
          WHERE family_account_id = $1::uuid AND score_date = $2::date`,
        faB,
        today,
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it('computeComponents — all-zero fallback for empty source tables', async () => {
      const fa = await seedFamilyAccount();
      // Use executeInExplicitSchema so the worker's $queryRawUnsafe calls
      // resolve against tenant_test (mirrors the production tickForSchool
      // path).
      const c = await tenantPrisma.executeInExplicitSchema(TEST_SCHEMA, async (client) => {
        return worker.computeComponents(client, TEST_SCHOOL_ID, fa, TEST_PARENT_PERSON_ID);
      });
      expect(c.attendance).toBe(0);
      expect(c.communication).toBe(0);
      expect(c.conference).toBe(0);
      expect(c.volunteer).toBe(0);
      expect(c.payment).toBe(100); // no bills → no overdue
    });
  });
});
