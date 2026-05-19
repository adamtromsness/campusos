import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { StandardService } from '@modules/m25-curriculum/frameworks.service';
import {
  DeliveryGapService,
  ResourceLinkService,
} from '@modules/m25-curriculum/gaps.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  parentActor,
  studentActor,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
  TEST_SIS_CLASS_ID,
} from '../fixtures/sis';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';

/**
 * Wave 4 — m25-curriculum DeliveryGapService + ResourceLinkService
 * DB-backed integration tests.
 *
 * Contracts verified (DeliveryGapService — ADR-018 nightly materialiser):
 *   - materialiseCurrentTenant walks every PUBLISHED map → unit →
 *     standard tuple in the current tenant, counts lessons_planned
 *     vs lessons_delivered, UPSERTs cur_delivery_gaps, and emits
 *     cur.delivery_gap.detected ONLY for new NOT_STARTED / PARTIAL
 *     gaps.
 *   - gap_type computation rules:
 *       * 0 planned + 0 delivered → NOT_STARTED
 *       * delivered >= planned (>0) → COMPLETE
 *       * delivered === 0 (planned > 0) → NOT_STARTED
 *       * else → PARTIAL
 *   - DRAFT / ARCHIVED maps are SKIPPED — only PUBLISHED counts.
 *   - Delivered lessons must have status='PUBLISHED' AND
 *     (date IS NULL OR date <= CURRENT_DATE).
 *   - Tenant scope: only the current tenant's maps + units get
 *     materialised; School B maps are invisible.
 *   - list() filters by unitId / curriculumMapId / gapType.
 *   - list() actor gate: non-staff non-admin (parent/student) →
 *     ForbiddenException. Internal callers (no actor) bypass.
 *   - refreshTenant requires admin (tch-008:admin) — teacher with
 *     no grants → ForbiddenException.
 *   - Emit only fires for NEW NOT_STARTED / PARTIAL gaps; repeat
 *     runs on the same unchanged state should not re-emit.
 *
 * Contracts verified (ResourceLinkService):
 *   - listForUnit hides is_teacher_only rows from non-staff.
 *   - create writer gate + URL/VIDEO required-url validation.
 *   - patch / remove writer gate.
 */
describe('integration:m25-curriculum/gaps', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let standardService: StandardService;
  let gapService: DeliveryGapService;
  let resourceService: ResourceLinkService;
  let kafka: RecordingKafkaProducer;

  // Platform framework + standard reused across this spec
  let PLATFORM_FW_ID: string;
  let PLATFORM_STD_ID: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    standardService = new StandardService(tenantPrisma, permCheck);
    kafka = makeRecordingKafka();
    gapService = new DeliveryGapService(
      tenantPrisma,
      permCheck,
      kafka as unknown as KafkaProducerService,
      standardService,
    );
    resourceService = new ResourceLinkService(tenantPrisma, permCheck);

    // Reuse any leftover platform framework with this test name (CASCADEs
    // to cur_standards_platform). Without this idempotency a previous
    // run that crashed before afterAll left a row with this name but a
    // different UUID, and INSERT here would hit the
    // cur_standards_frameworks_platform_name_key UNIQUE on (name).
    const existingFw = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM platform.cur_standards_frameworks_platform WHERE name = 'CCSS-GAPS-TEST' LIMIT 1`,
    )) as Array<{ id: string }>;
    if (existingFw.length > 0) {
      PLATFORM_FW_ID = existingFw[0]!.id;
    } else {
      PLATFORM_FW_ID = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.cur_standards_frameworks_platform (id, name, body, region, version)
         VALUES ($1::uuid, 'CCSS-GAPS-TEST', 'CCSS', 'US', '1')
         ON CONFLICT (name) DO NOTHING`,
        PLATFORM_FW_ID,
      );
    }
    const existingStd = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM platform.cur_standards_platform WHERE framework_id = $1::uuid AND code = 'CCSS.GAPS.5.NBT.1' LIMIT 1`,
      PLATFORM_FW_ID,
    )) as Array<{ id: string }>;
    if (existingStd.length > 0) {
      PLATFORM_STD_ID = existingStd[0]!.id;
    } else {
      PLATFORM_STD_ID = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.cur_standards_platform (id, framework_id, code, description, grade_band)
         VALUES ($1::uuid, $2::uuid, 'CCSS.GAPS.5.NBT.1', 'Place value', '5')
         ON CONFLICT (id) DO NOTHING`,
        PLATFORM_STD_ID,
        PLATFORM_FW_ID,
      );
    }
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.cur_standards_platform WHERE id = $1::uuid`,
      PLATFORM_STD_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.cur_standards_frameworks_platform WHERE id = $1::uuid`,
      PLATFORM_FW_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_delivery_gaps`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_lessons`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_standards`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_resource_links`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_units`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_curriculum_maps`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_standards`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_standards_frameworks`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_lessons WHERE title LIKE 'GAPS-LESSON-%'`,
    );
    kafka.reset();
  });

  // Helpers ───────────────────────────────────────────────────────

  async function seedMap(opts: {
    schoolId: string;
    yearId: string;
    status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    subject?: string;
    gradeLevel?: string;
  }): Promise<string> {
    const id = generateId();
    const status = opts.status ?? 'PUBLISHED';
    const publishedAt = status === 'PUBLISHED' || status === 'ARCHIVED' ? "now()" : 'NULL';
    const archivedAt = status === 'ARCHIVED' ? "now()" : 'NULL';
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_curriculum_maps
         (id, school_id, academic_year_id, subject, grade_level, title, created_by, status, published_at, archived_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'Map', $6::uuid, $7, ${publishedAt}, ${archivedAt})`,
      id,
      opts.schoolId,
      opts.yearId,
      opts.subject ?? 'Math',
      opts.gradeLevel ?? '5',
      adminActor().accountId,
      status,
    );
    return id;
  }

  async function seedUnit(mapId: string, sequenceOrder = 1, title = 'U'): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_units (id, curriculum_map_id, title, sequence_order)
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      id,
      mapId,
      title,
      sequenceOrder,
    );
    return id;
  }

  async function alignStandard(unitId: string, standardId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_unit_standards (id, unit_id, standard_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      id,
      unitId,
      standardId,
    );
    return id;
  }

  async function seedLesson(opts: {
    schoolId: string;
    status?: string;
    date?: string | null;
    isTemplate?: boolean;
  }): Promise<string> {
    const id = generateId();
    const status = opts.status ?? 'PUBLISHED';
    const isTemplate = opts.isTemplate ?? false;
    if (isTemplate) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_lessons
           (id, school_id, class_id, teacher_id, title, status, is_template, date)
         VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, 'GAPS-LESSON-' || left($1::text, 8), $4, true, $5::date)`,
        id,
        opts.schoolId,
        TEST_TEACHER_EMPLOYEE_ID,
        status,
        opts.date ?? null,
      );
    } else {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_lessons
           (id, school_id, class_id, teacher_id, title, status, date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'GAPS-LESSON-' || left($1::text, 8), $5, $6::date)`,
        id,
        opts.schoolId,
        TEST_SIS_CLASS_ID,
        TEST_TEACHER_EMPLOYEE_ID,
        status,
        opts.date ?? null,
      );
    }
    return id;
  }

  async function linkLesson(unitId: string, lessonId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_unit_lessons (id, unit_id, cls_lesson_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      id,
      unitId,
      lessonId,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────
  // DeliveryGapService.materialiseCurrentTenant — gap type logic
  // ──────────────────────────────────────────────────────────────
  describe('materialiseCurrentTenant — gap type computation', () => {
    it('unit with 0 planned and 0 delivered → NOT_STARTED', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);

      const result = await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(result.unitsScanned).toBe(1);
      expect(result.gapsWritten).toBe(1);

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ gap_type: string; planned: number; delivered: number }>
      >(
        `SELECT gap_type, lessons_planned AS planned, lessons_delivered AS delivered
         FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.gap_type).toBe('NOT_STARTED');
      expect(rows[0]!.planned).toBe(0);
      expect(rows[0]!.delivered).toBe(0);
    });

    it('unit with planned=2 and delivered=2 → COMPLETE', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      // Two PUBLISHED lessons in the past → both planned + delivered
      const l1 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2020-01-01',
      });
      const l2 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2020-02-01',
      });
      await linkLesson(unitId, l1);
      await linkLesson(unitId, l2);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ gap_type: string; planned: number; delivered: number }>
      >(
        `SELECT gap_type, lessons_planned AS planned, lessons_delivered AS delivered
         FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.gap_type).toBe('COMPLETE');
      expect(rows[0]!.planned).toBe(2);
      expect(rows[0]!.delivered).toBe(2);
    });

    it('unit with planned=3 and delivered=1 → PARTIAL', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      // 1 PUBLISHED past-dated lesson (counts as delivered) + 2 DRAFT
      // lessons (count as planned but NOT delivered).
      const l1 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2020-01-01',
      });
      const l2 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'DRAFT',
        date: '2020-01-02',
      });
      const l3 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'DRAFT',
        date: '2020-01-03',
      });
      await linkLesson(unitId, l1);
      await linkLesson(unitId, l2);
      await linkLesson(unitId, l3);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ gap_type: string; planned: number; delivered: number }>
      >(
        `SELECT gap_type, lessons_planned AS planned, lessons_delivered AS delivered
         FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.gap_type).toBe('PARTIAL');
      expect(rows[0]!.planned).toBe(3);
      expect(rows[0]!.delivered).toBe(1);
    });

    it('unit with planned>0 but delivered=0 → NOT_STARTED', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      // 2 DRAFT lessons — both planned, neither delivered.
      const l1 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'DRAFT',
        date: '2020-01-01',
      });
      const l2 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'DRAFT',
        date: '2020-01-02',
      });
      await linkLesson(unitId, l1);
      await linkLesson(unitId, l2);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ gap_type: string; planned: number; delivered: number }>
      >(
        `SELECT gap_type, lessons_planned AS planned, lessons_delivered AS delivered
         FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.gap_type).toBe('NOT_STARTED');
      expect(rows[0]!.planned).toBe(2);
      expect(rows[0]!.delivered).toBe(0);
    });

    it('future-dated PUBLISHED lesson is planned but NOT delivered', async () => {
      // Delivered predicate: status='PUBLISHED' AND (date IS NULL OR date <= CURRENT_DATE).
      // A lesson dated in 2099 is planned but not yet delivered.
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      const future = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2099-12-31',
      });
      await linkLesson(unitId, future);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ gap_type: string; planned: number; delivered: number }>
      >(
        `SELECT gap_type, lessons_planned AS planned, lessons_delivered AS delivered
         FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.planned).toBe(1);
      expect(rows[0]!.delivered).toBe(0);
      expect(rows[0]!.gap_type).toBe('NOT_STARTED');
    });

    it('PUBLISHED lesson with NULL date is counted as delivered', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      const l = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: null,
      });
      await linkLesson(unitId, l);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ gap_type: string; planned: number; delivered: number }>
      >(
        `SELECT gap_type, lessons_planned AS planned, lessons_delivered AS delivered
         FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.planned).toBe(1);
      expect(rows[0]!.delivered).toBe(1);
      expect(rows[0]!.gap_type).toBe('COMPLETE');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // materialise — scope rules (PUBLISHED only, tenant only)
  // ──────────────────────────────────────────────────────────────
  describe('materialiseCurrentTenant — scope rules', () => {
    it('DRAFT map is SKIPPED (no gap row produced)', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
        status: 'DRAFT',
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);

      const result = await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(result.unitsScanned).toBe(0);
      expect(result.gapsWritten).toBe(0);
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('ARCHIVED map is SKIPPED', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
        status: 'ARCHIVED',
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);

      const result = await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(result.unitsScanned).toBe(0);
      expect(result.gapsWritten).toBe(0);
    });

    it('School B maps are NOT materialised from School A context', async () => {
      // Seed a PUBLISHED School B map + unit + standard. School A
      // materialise should produce 0 rows.
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_B_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_B_ID,
        status: 'PUBLISHED',
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);

      const result = await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(result.unitsScanned).toBe(0);
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_delivery_gaps WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('multiple units in one PUBLISHED map → each gets its own gap row', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const u1 = await seedUnit(mapId, 1, 'U1');
      const u2 = await seedUnit(mapId, 2, 'U2');
      await alignStandard(u1, PLATFORM_STD_ID);
      await alignStandard(u2, PLATFORM_STD_ID);

      const result = await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(result.unitsScanned).toBe(2);
      expect(result.gapsWritten).toBe(2);
    });

    it('unit with multiple aligned standards produces one gap row per standard', async () => {
      // Seed second platform standard
      const std2 = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.cur_standards_platform (id, framework_id, code, description, grade_band)
         VALUES ($1::uuid, $2::uuid, 'CCSS.GAPS.5.NBT.2', 'Add', '5')`,
        std2,
        PLATFORM_FW_ID,
      );

      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      await alignStandard(unitId, std2);

      const result = await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(result.unitsScanned).toBe(1);
      expect(result.gapsWritten).toBe(2);

      // cleanup
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.cur_standards_platform WHERE id = $1::uuid`,
        std2,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────
  // materialise — Kafka emit semantics
  // ──────────────────────────────────────────────────────────────
  describe('materialiseCurrentTenant — Kafka emit semantics', () => {
    it('emits cur.delivery_gap.detected for a NEW NOT_STARTED gap', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const emits = kafka.callsForTopic('cur.delivery_gap.detected');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.key).toBe(unitId);
      expect(emits[0]!.sourceModule).toBe('curriculum');
      const payload = emits[0]!.payload as Record<string, unknown>;
      expect(payload.unitId).toBe(unitId);
      expect(payload.standardId).toBe(PLATFORM_STD_ID);
      expect(payload.standardCode).toBe('CCSS.GAPS.5.NBT.1');
      expect(payload.gapType).toBe('NOT_STARTED');
      expect(payload.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('emits for a NEW PARTIAL gap', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      const l1 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2020-01-01',
      });
      const l2 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'DRAFT',
        date: '2020-01-02',
      });
      await linkLesson(unitId, l1);
      await linkLesson(unitId, l2);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const emits = kafka.callsForTopic('cur.delivery_gap.detected');
      expect(emits).toHaveLength(1);
      expect((emits[0]!.payload as Record<string, unknown>).gapType).toBe('PARTIAL');
    });

    it('does NOT emit for a COMPLETE gap', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      const l = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2020-01-01',
      });
      await linkLesson(unitId, l);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(kafka.callsForTopic('cur.delivery_gap.detected')).toHaveLength(0);
    });

    it('does NOT re-emit when the gap_type is unchanged on a second run', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(kafka.callsForTopic('cur.delivery_gap.detected')).toHaveLength(1);

      kafka.reset();
      // Same state, second pass — gap_type still NOT_STARTED, no new
      // emit expected.
      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      expect(kafka.callsForTopic('cur.delivery_gap.detected')).toHaveLength(0);
    });

    it('re-emits when gap_type transitions (COMPLETE → PARTIAL)', async () => {
      // Start with a COMPLETE state (1 planned + 1 delivered).
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      const l1 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2020-01-01',
      });
      await linkLesson(unitId, l1);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      // COMPLETE → no emit
      expect(kafka.callsForTopic('cur.delivery_gap.detected')).toHaveLength(0);

      // Now add a DRAFT planned lesson → state becomes PARTIAL (2
      // planned, 1 delivered). Should emit a fresh detected event.
      const l2 = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'DRAFT',
        date: '2020-01-02',
      });
      await linkLesson(unitId, l2);

      kafka.reset();
      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      const emits = kafka.callsForTopic('cur.delivery_gap.detected');
      expect(emits).toHaveLength(1);
      expect((emits[0]!.payload as Record<string, unknown>).gapType).toBe('PARTIAL');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // DeliveryGapService.list — actor gate + filters
  // ──────────────────────────────────────────────────────────────
  describe('list — actor gate + filters', () => {
    it('non-staff (parent) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => gapService.list({}, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-staff (student) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => gapService.list({}, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin can list', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const dtos = await withTestTenant(async () => gapService.list({}, adminActor()));
      expect(dtos).toHaveLength(1);
      expect(dtos[0]!.unitId).toBe(unitId);
      expect(dtos[0]!.standardCode).toBe('CCSS.GAPS.5.NBT.1');
      expect(dtos[0]!.standardDescription).toBe('Place value');
      expect(dtos[0]!.curriculumMapId).toBe(mapId);
    });

    it('teacher (STAFF) can list', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const dtos = await withTestTenant(async () => gapService.list({}, teacherActor()));
      expect(dtos.length).toBeGreaterThanOrEqual(1);
    });

    it('internal caller (no actor) bypasses the gate', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);
      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const dtos = await withTestTenant(async () => gapService.list({}));
      expect(dtos.length).toBeGreaterThanOrEqual(1);
    });

    it('filter by unitId returns only that unit', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const u1 = await seedUnit(mapId, 1, 'U1');
      const u2 = await seedUnit(mapId, 2, 'U2');
      await alignStandard(u1, PLATFORM_STD_ID);
      await alignStandard(u2, PLATFORM_STD_ID);
      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const dtos = await withTestTenant(async () =>
        gapService.list({ unitId: u1 }, adminActor()),
      );
      expect(dtos).toHaveLength(1);
      expect(dtos[0]!.unitId).toBe(u1);
    });

    it('filter by curriculumMapId restricts results', async () => {
      const m1 = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
        subject: 'Math',
      });
      const m2 = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
        subject: 'Sci',
      });
      const u1 = await seedUnit(m1);
      const u2 = await seedUnit(m2);
      await alignStandard(u1, PLATFORM_STD_ID);
      await alignStandard(u2, PLATFORM_STD_ID);
      await withTestTenant(async () => gapService.materialiseCurrentTenant());

      const dtos = await withTestTenant(async () =>
        gapService.list({ curriculumMapId: m1 }, adminActor()),
      );
      expect(dtos).toHaveLength(1);
      expect(dtos[0]!.curriculumMapId).toBe(m1);
    });

    it('filter by gapType filters across maps', async () => {
      // Two maps in the same tenant — one COMPLETE, one NOT_STARTED.
      const mComplete = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
        subject: 'Math',
      });
      const uComplete = await seedUnit(mComplete);
      await alignStandard(uComplete, PLATFORM_STD_ID);
      const lesson = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        status: 'PUBLISHED',
        date: '2020-01-01',
      });
      await linkLesson(uComplete, lesson);

      const mNotStarted = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
        subject: 'Sci',
      });
      const uNotStarted = await seedUnit(mNotStarted);
      await alignStandard(uNotStarted, PLATFORM_STD_ID);

      await withTestTenant(async () => gapService.materialiseCurrentTenant());
      const completeOnly = await withTestTenant(async () =>
        gapService.list({ gapType: 'COMPLETE' }, adminActor()),
      );
      expect(completeOnly).toHaveLength(1);
      expect(completeOnly[0]!.unitId).toBe(uComplete);

      const notStartedOnly = await withTestTenant(async () =>
        gapService.list({ gapType: 'NOT_STARTED' }, adminActor()),
      );
      expect(notStartedOnly).toHaveLength(1);
      expect(notStartedOnly[0]!.unitId).toBe(uNotStarted);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // refreshTenant — admin gate
  // ──────────────────────────────────────────────────────────────
  describe('refreshTenant', () => {
    it('admin actor → succeeds and returns counts', async () => {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      await alignStandard(unitId, PLATFORM_STD_ID);

      const result = await withTestTenant(async () => gapService.refreshTenant(adminActor()));
      expect(result.unitsScanned).toBe(1);
      expect(result.gapsWritten).toBe(1);
    });

    it('teacher with no tch-008:admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => gapService.refreshTenant(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // ResourceLinkService — listForUnit visibility rule
  // ──────────────────────────────────────────────────────────────
  describe('ResourceLinkService.listForUnit', () => {
    async function seedUnitForResources(): Promise<string> {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      return seedUnit(mapId);
    }

    it('non-staff (parent) does NOT see is_teacher_only=true rows', async () => {
      const unitId = await seedUnitForResources();
      await withTestTenant(async () =>
        resourceService.create(
          unitId,
          {
            resourceType: 'URL',
            title: 'Public',
            url: 'https://x.test',
            isTeacherOnly: false,
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        resourceService.create(
          unitId,
          {
            resourceType: 'URL',
            title: 'Internal',
            url: 'https://x.test',
            isTeacherOnly: true,
          },
          adminActor(),
        ),
      );

      const asParent = await withTestTenant(async () =>
        resourceService.listForUnit(unitId, parentActor()),
      );
      expect(asParent.map((r) => r.title)).toEqual(['Public']);
    });

    it('staff (admin) sees both teacher-only and public', async () => {
      const unitId = await seedUnitForResources();
      await withTestTenant(async () =>
        resourceService.create(
          unitId,
          {
            resourceType: 'URL',
            title: 'Public',
            url: 'https://x.test',
            isTeacherOnly: false,
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        resourceService.create(
          unitId,
          {
            resourceType: 'URL',
            title: 'Internal',
            url: 'https://x.test',
            isTeacherOnly: true,
          },
          adminActor(),
        ),
      );

      const asAdmin = await withTestTenant(async () =>
        resourceService.listForUnit(unitId, adminActor()),
      );
      expect(asAdmin.map((r) => r.title).sort()).toEqual(['Internal', 'Public']);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // ResourceLinkService.create — writer gate + URL/VIDEO validation
  // ──────────────────────────────────────────────────────────────
  describe('ResourceLinkService.create', () => {
    async function seedUnitForResources(): Promise<string> {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      return seedUnit(mapId);
    }

    it('admin creates a FILE resource (no url required)', async () => {
      const unitId = await seedUnitForResources();
      const dto = await withTestTenant(async () =>
        resourceService.create(
          unitId,
          {
            resourceType: 'FILE',
            title: 'PDF',
            s3Key: 'curriculum/file.pdf',
          },
          adminActor(),
        ),
      );
      expect(dto.resourceType).toBe('FILE');
      expect(dto.s3Key).toBe('curriculum/file.pdf');
      expect(dto.url).toBeNull();
      expect(dto.isTeacherOnly).toBe(false);
    });

    it('URL resource requires url field → BadRequest if missing', async () => {
      const unitId = await seedUnitForResources();
      await expect(
        withTestTenant(async () =>
          resourceService.create(
            unitId,
            {
              resourceType: 'URL',
              title: 'No URL',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('VIDEO resource requires url field → BadRequest if missing', async () => {
      const unitId = await seedUnitForResources();
      await expect(
        withTestTenant(async () =>
          resourceService.create(
            unitId,
            {
              resourceType: 'VIDEO',
              title: 'No URL',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-writer (teacher with no tch-008:write) → ForbiddenException', async () => {
      const unitId = await seedUnitForResources();
      await expect(
        withTestTenant(async () =>
          resourceService.create(
            unitId,
            {
              resourceType: 'URL',
              title: 'denied',
              url: 'https://x.test',
            },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // ResourceLinkService.patch + remove
  // ──────────────────────────────────────────────────────────────
  describe('ResourceLinkService.patch + remove', () => {
    async function seedUnitWithResource(): Promise<{ unitId: string; resourceId: string }> {
      const mapId = await seedMap({
        schoolId: TEST_SCHOOL_ID,
        yearId: TEST_SIS_ACADEMIC_YEAR_ID,
      });
      const unitId = await seedUnit(mapId);
      const dto = await withTestTenant(async () =>
        resourceService.create(
          unitId,
          {
            resourceType: 'URL',
            title: 'Original',
            url: 'https://a.test',
          },
          adminActor(),
        ),
      );
      return { unitId, resourceId: dto.id };
    }

    it('admin patches title → DTO reflects update', async () => {
      const { resourceId } = await seedUnitWithResource();
      const dto = await withTestTenant(async () =>
        resourceService.patch(resourceId, { title: 'Renamed' }, adminActor()),
      );
      expect(dto.title).toBe('Renamed');
    });

    it('patch with empty input still resolves via the no-set branch', async () => {
      const { resourceId } = await seedUnitWithResource();
      const dto = await withTestTenant(async () =>
        resourceService.patch(resourceId, {}, adminActor()),
      );
      // No mutation applied; original title preserved.
      expect(dto.title).toBe('Original');
    });

    it('patch unknown id (no fields supplied) → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          resourceService.patch('00000000-0000-0000-0000-000000000000', {}, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch unknown id (with fields) → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          resourceService.patch(
            '00000000-0000-0000-0000-000000000000',
            { title: 'X' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer cannot patch → ForbiddenException', async () => {
      const { resourceId } = await seedUnitWithResource();
      await expect(
        withTestTenant(async () =>
          resourceService.patch(resourceId, { title: 'denied' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin removes a resource → row deleted', async () => {
      const { resourceId } = await seedUnitWithResource();
      await withTestTenant(async () => resourceService.remove(resourceId, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_resource_links WHERE id = $1::uuid`,
        resourceId,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('non-writer cannot remove → ForbiddenException', async () => {
      const { resourceId } = await seedUnitWithResource();
      await expect(
        withTestTenant(async () => resourceService.remove(resourceId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // Suppress unused lint
  void NotFoundException;
});
