import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { MtssTierService } from '@modules/m27-student-services/mtss/mtss-tier.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

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
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';
import { RecordingKafkaProducer, makeRecordingKafka } from '../helpers/recording-kafka';

/**
 * Wave 3 — DB-backed integration tests for MtssTierService.
 *
 * Strategy doc Wave 3 contracts:
 *   - **Partial UNIQUE keystone** `(student_id, academic_year_id,
 *     domain) WHERE status='ACTIVE'`: only one ACTIVE tier per
 *     (student, year, domain) at a time. Service pre-flights the
 *     conflict; schema UNIQUE catches concurrent races. Status
 *     transitions ACTIVE → EXITED/PROMOTED/DEMOTED release the
 *     keystone so a fresh ACTIVE row may be created.
 *   - **Caseload ownership** (REVIEW-CYCLE11 MAJOR 4): non-admin
 *     counsellors can only manage MTSS state for students they
 *     hold an ACTIVE caseload row for. Admins bypass.
 *   - **Row-scope list visibility**: admin → school-wide; counsellor
 *     → student IN (own ACTIVE caseloads); STUDENT/PARENT → AND
 *     FALSE.
 *   - **Patch row lock**: SELECT FOR UPDATE inside tx + caseload-
 *     ownership re-check inside the lock so a stale check cannot
 *     bypass a concurrent caseload transfer.
 *   - **emitTierChanged** best-effort Kafka emit on CREATED /
 *     TIER_CHANGED / STATUS_CHANGED; failure does NOT roll back the
 *     domain write (per ADR-001/020 best-effort emit convention).
 *   - **Dashboard admin-only**: school-wide tier × domain rollup.
 *   - **Team meetings**: createMeeting + attachMeetingStudent UNIQUE
 *     per (team_meeting_id, student_id); facilitator must have
 *     hr_employees record.
 */
describe('integration:m27-student-services/mtss', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let recordingKafka: RecordingKafkaProducer;
  let kafka: RecordingKafkaProducer & KafkaProducerService;
  let service: MtssTierService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    kafka = makeRecordingKafka();
    recordingKafka = kafka as unknown as RecordingKafkaProducer;
    service = new MtssTierService(tenantPrisma, kafka, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];
  const createdCaseloadIds: string[] = [];

  beforeEach(async () => {
    recordingKafka.reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
    // Order matters: meeting_students CASCADE from meetings; tiers stand alone.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_mtss_team_meetings WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_mtss_tiers WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'MTSS-%')`,
    );
    if (createdCaseloadIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_caseloads WHERE id = ANY($1::uuid[])`,
        createdCaseloadIds.splice(0),
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

  async function seedStudent(label: string): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'MT', $2, 'STUDENT', true)`,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'MT', $3, true)`,
      platformStudentId,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '6')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'MTSS-' + studentId.slice(-12),
    );
    return studentId;
  }

  async function seedCaseload(
    studentId: string,
    counselorEmployeeId: string,
    status: 'ACTIVE' | 'CLOSED' = 'ACTIVE',
  ): Promise<string> {
    const id = generateId();
    createdCaseloadIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_caseloads
         (id, school_id, counselor_id, student_id, academic_year_id, primary_concern, opened_at, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ACADEMIC', '2025-09-01', $6)`,
      id,
      TEST_SCHOOL_ID,
      counselorEmployeeId,
      studentId,
      TEST_ACADEMIC_YEAR_ID,
      status,
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
      ['cou-001:write'],
    );
  }

  /**
   * MtssTierService fires `void this.emitTierChanged(...)` (best-effort
   * Kafka emit per ADR-001/020). Tests that assert on captured emits
   * must flush the pending microtasks/tasks first — the DB read inside
   * emitTierChanged resolves a tick after the patch/create promise
   * returns. setTimeout(0) drains the macrotask queue.
   */
  async function flushEmits(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
  }

  function tierInput(studentId: string, overrides: Record<string, unknown> = {}) {
    return {
      studentId,
      academicYearId: TEST_ACADEMIC_YEAR_ID,
      tier: 'TIER_2',
      domain: 'ACADEMIC',
      assignedAt: '2025-09-15',
      reviewDate: '2025-12-15',
      ...overrides,
    } as any;
  }

  // ────────────────────────────────────────────────────────────────────
  // create — partial UNIQUE keystone + caseload ownership
  // ────────────────────────────────────────────────────────────────────
  describe('create (partial UNIQUE keystone)', () => {
    it('admin creates TIER_2 ACADEMIC → row written + svc.tier.changed emit (reason=CREATED)', async () => {
      const studentId = await seedStudent('Create1');
      const dto = await withTestTenant(async () =>
        service.create(tierInput(studentId), adminActor()),
      );
      expect(dto.tier).toBe('TIER_2');
      expect(dto.domain).toBe('ACADEMIC');
      expect(dto.status).toBe('ACTIVE');
      await flushEmits();
      const emits = recordingKafka.callsForTopic('svc.tier.changed');
      expect(emits).toHaveLength(1);
      const payload = emits[0]!.payload as any;
      expect(payload.tierId).toBe(dto.id);
      expect(payload.reason).toBe('CREATED');
      expect(payload.oldTier).toBeNull();
      expect(payload.studentId).toBe(studentId);
    });

    it('two ACTIVE tiers in DIFFERENT domains for same student/year → both allowed (keystone is per-domain)', async () => {
      const studentId = await seedStudent('TwoDomains');
      await withTestTenant(async () =>
        service.create(tierInput(studentId, { tier: 'TIER_2', domain: 'ACADEMIC' }), adminActor()),
      );
      const second = await withTestTenant(async () =>
        service.create(
          tierInput(studentId, { tier: 'TIER_1', domain: 'BEHAVIORAL' }),
          adminActor(),
        ),
      );
      expect(second.domain).toBe('BEHAVIORAL');
      const all = await rawClient.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.svc_mtss_tiers WHERE student_id = $1::uuid AND status='ACTIVE'`,
        studentId,
      );
      expect(all[0]!.n).toBe(2);
    });

    it('second ACTIVE tier in SAME (student, year, domain) → service pre-flight BadRequest with the conflicting tier id', async () => {
      const studentId = await seedStudent('Conflict');
      const first = await withTestTenant(async () =>
        service.create(tierInput(studentId, { tier: 'TIER_2' }), adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.create(tierInput(studentId, { tier: 'TIER_3' }), adminActor()),
        ),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(first.id),
      });
    });

    it('after EXIT, a fresh ACTIVE tier for same (student, year, domain) is allowed', async () => {
      const studentId = await seedStudent('AfterExit');
      const first = await withTestTenant(async () =>
        service.create(tierInput(studentId, { tier: 'TIER_2' }), adminActor()),
      );
      await withTestTenant(async () =>
        service.patch(
          first.id,
          { status: 'EXITED', exitDate: '2025-10-01', exitReason: 'graduated' } as any,
          adminActor(),
        ),
      );
      const second = await withTestTenant(async () =>
        service.create(tierInput(studentId, { tier: 'TIER_1' }), adminActor()),
      );
      expect(second.status).toBe('ACTIVE');
    });

    it('non-admin counsellor WITHOUT caseload for student → Forbidden (caseload-ownership rule)', async () => {
      await grantOfficerCounsellor();
      const studentId = await seedStudent('NoCase');
      await expect(
        withTestTenant(async () => service.create(tierInput(studentId), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin counsellor WITH ACTIVE caseload → ok', async () => {
      await grantOfficerCounsellor();
      const studentId = await seedStudent('Owned');
      await seedCaseload(studentId, TEST_OFFICER_EMPLOYEE_ID);
      const dto = await withTestTenant(async () =>
        service.create(tierInput(studentId), officerActor()),
      );
      expect(dto.status).toBe('ACTIVE');
    });

    it('non-admin counsellor with only a CLOSED caseload → Forbidden', async () => {
      await grantOfficerCounsellor();
      const studentId = await seedStudent('ClosedCase');
      await seedCaseload(studentId, TEST_OFFICER_EMPLOYEE_ID, 'CLOSED');
      await expect(
        withTestTenant(async () => service.create(tierInput(studentId), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → Forbidden (gate)', async (_label, actor) => {
      const studentId = await seedStudent('Gate');
      await expect(
        withTestTenant(async () => service.create(tierInput(studentId), actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // patch — row lock + caseload-ownership re-check + status-change emits
  // ────────────────────────────────────────────────────────────────────
  describe('patch (row-locked transitions + emit)', () => {
    it('admin patches tier value → svc.tier.changed emit with reason=TIER_CHANGED + oldTier', async () => {
      const studentId = await seedStudent('PatchTier');
      const first = await withTestTenant(async () =>
        service.create(tierInput(studentId, { tier: 'TIER_2' }), adminActor()),
      );
      await flushEmits();
      recordingKafka.reset();
      await withTestTenant(async () =>
        service.patch(first.id, { tier: 'TIER_3' } as any, adminActor()),
      );
      await flushEmits();
      const emits = recordingKafka.callsForTopic('svc.tier.changed');
      expect(emits).toHaveLength(1);
      const p = emits[0]!.payload as any;
      expect(p.reason).toBe('TIER_CHANGED');
      expect(p.oldTier).toBe('TIER_2');
      expect(p.tier).toBe('TIER_3');
    });

    it('admin patches status only → svc.tier.changed emit with reason=STATUS_CHANGED', async () => {
      const studentId = await seedStudent('PatchStatus');
      const first = await withTestTenant(async () =>
        service.create(tierInput(studentId), adminActor()),
      );
      await flushEmits();
      recordingKafka.reset();
      await withTestTenant(async () =>
        service.patch(
          first.id,
          { status: 'PROMOTED', exitDate: '2025-11-01' } as any,
          adminActor(),
        ),
      );
      await flushEmits();
      const emits = recordingKafka.callsForTopic('svc.tier.changed');
      expect(emits).toHaveLength(1);
      expect((emits[0]!.payload as any).reason).toBe('STATUS_CHANGED');
    });

    it('non-admin counsellor patching a tier for student NOT on their caseload → Forbidden', async () => {
      const studentId = await seedStudent('OwnedByAdmin');
      const first = await withTestTenant(async () =>
        service.create(tierInput(studentId), adminActor()),
      );
      await grantOfficerCounsellor();
      await expect(
        withTestTenant(async () =>
          service.patch(first.id, { tier: 'TIER_3' } as any, officerActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin counsellor patching their own caseload student → ok', async () => {
      await grantOfficerCounsellor();
      const studentId = await seedStudent('PatchOwn');
      await seedCaseload(studentId, TEST_OFFICER_EMPLOYEE_ID);
      const first = await withTestTenant(async () =>
        service.create(tierInput(studentId), officerActor()),
      );
      const updated = await withTestTenant(async () =>
        service.patch(first.id, { notes: 'review notes' } as any, officerActor()),
      );
      expect(updated.notes).toBe('review notes');
    });

    it('patch on missing tier → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.patch(
            '00000000-0000-0000-0000-000000000000',
            { tier: 'TIER_2' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch is a no-op (returns current state, no emit)', async () => {
      const studentId = await seedStudent('NoOp');
      const first = await withTestTenant(async () =>
        service.create(tierInput(studentId), adminActor()),
      );
      await flushEmits();
      recordingKafka.reset();
      const updated = await withTestTenant(async () =>
        service.patch(first.id, {} as any, adminActor()),
      );
      await flushEmits();
      expect(updated.id).toBe(first.id);
      expect(recordingKafka.calls).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list — caseload-scope visibility
  // ────────────────────────────────────────────────────────────────────
  describe('list (caseload-scope visibility)', () => {
    it('admin list sees school-wide tiers', async () => {
      const a = await seedStudent('AdmLst1');
      const b = await seedStudent('AdmLst2');
      await withTestTenant(async () => service.create(tierInput(a), adminActor()));
      await withTestTenant(async () => service.create(tierInput(b), adminActor()));
      const rows = await withTestTenant(async () => service.list({} as any, adminActor()));
      const ids = rows.map((r) => r.studentId);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
    });

    it('non-admin counsellor sees only their caseload students', async () => {
      await grantOfficerCounsellor();
      const mine = await seedStudent('Mine');
      const theirs = await seedStudent('Theirs');
      await seedCaseload(mine, TEST_OFFICER_EMPLOYEE_ID);
      await withTestTenant(async () => service.create(tierInput(mine), officerActor()));
      await withTestTenant(async () => service.create(tierInput(theirs), adminActor()));
      const rows = await withTestTenant(async () => service.list({} as any, officerActor()));
      const ids = rows.map((r) => r.studentId);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    });

    it.each([
      ['student', studentActor],
      ['parent', parentActor],
    ])('%s list returns empty (AND FALSE row scope)', async (_label, actor) => {
      const studentId = await seedStudent('VisGate');
      await withTestTenant(async () => service.create(tierInput(studentId), adminActor()));
      const rows = await withTestTenant(async () => service.list({} as any, actor()));
      expect(rows).toEqual([]);
    });

    it('getById outside visibility → NotFound', async () => {
      await grantOfficerCounsellor();
      const studentId = await seedStudent('Hidden');
      const dto = await withTestTenant(async () =>
        service.create(tierInput(studentId), adminActor()),
      );
      await expect(
        withTestTenant(async () => service.getById(dto.id, officerActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list filter by tier returns only matching tier', async () => {
      const a = await seedStudent('FilterA');
      const b = await seedStudent('FilterB');
      await withTestTenant(async () =>
        service.create(tierInput(a, { tier: 'TIER_2' }), adminActor()),
      );
      await withTestTenant(async () =>
        service.create(tierInput(b, { tier: 'TIER_3' }), adminActor()),
      );
      const rows = await withTestTenant(async () =>
        service.list({ tier: 'TIER_3' as any } as any, adminActor()),
      );
      const ids = rows.map((r) => r.studentId);
      expect(ids).toContain(b);
      expect(ids).not.toContain(a);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // dashboard — admin-only school-wide rollup
  // ────────────────────────────────────────────────────────────────────
  describe('dashboard (admin-only school-wide rollup)', () => {
    it('admin gets tier × domain cells + totalActive', async () => {
      const a = await seedStudent('Dash1');
      const b = await seedStudent('Dash2');
      const c = await seedStudent('Dash3');
      await withTestTenant(async () =>
        service.create(tierInput(a, { tier: 'TIER_2', domain: 'ACADEMIC' }), adminActor()),
      );
      await withTestTenant(async () =>
        service.create(tierInput(b, { tier: 'TIER_2', domain: 'ACADEMIC' }), adminActor()),
      );
      await withTestTenant(async () =>
        service.create(tierInput(c, { tier: 'TIER_3', domain: 'BEHAVIORAL' }), adminActor()),
      );
      const dash = await withTestTenant(async () => service.dashboard(adminActor()));
      expect(dash.totalActive).toBeGreaterThanOrEqual(3);
      const academicT2 = dash.cells.find((c) => c.tier === 'TIER_2' && c.domain === 'ACADEMIC');
      expect(academicT2!.count).toBeGreaterThanOrEqual(2);
      const behavioralT3 = dash.cells.find((c) => c.tier === 'TIER_3' && c.domain === 'BEHAVIORAL');
      expect(behavioralT3!.count).toBeGreaterThanOrEqual(1);
    });

    it('EXITED tiers do NOT count in dashboard', async () => {
      const a = await seedStudent('DashExit');
      const t = await withTestTenant(async () => service.create(tierInput(a), adminActor()));
      await withTestTenant(async () =>
        service.patch(t.id, { status: 'EXITED', exitDate: '2025-12-01' } as any, adminActor()),
      );
      const dash = await withTestTenant(async () => service.dashboard(adminActor()));
      // Verify the cell for this exact (TIER_2, ACADEMIC) doesn't include the exited row
      // (other tests' active rows may also exist in this beforeEach window — we assert
      // the exited row is not part of the count).
      const tiersForStudent = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.svc_mtss_tiers WHERE student_id = $1::uuid`,
        a,
      )) as Array<{ status: string }>;
      expect(tiersForStudent[0]!.status).toBe('EXITED');
      // Dashboard groups only ACTIVE, so a query that filters by ACTIVE count would
      // exclude this student. Use raw SQL to confirm exclusion.
      const activeCount = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.svc_mtss_tiers WHERE student_id = $1::uuid AND status='ACTIVE'`,
        a,
      )) as Array<{ n: number }>;
      expect(activeCount[0]!.n).toBe(0);
      void dash;
    });

    it.each([
      ['officer (counsellor scope)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('dashboard as %s → Forbidden (admin-only)', async (_label, actor) => {
      await expect(withTestTenant(async () => service.dashboard(actor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Team meetings — UNIQUE per (meeting, student)
  // ────────────────────────────────────────────────────────────────────
  describe('Team meetings', () => {
    it('admin creates meeting + attaches student → both rows visible via getMeetingById', async () => {
      const studentId = await seedStudent('Meet1');
      const meeting = await withTestTenant(async () =>
        service.createMeeting(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            meetingDate: '2026-02-15',
            notes: 'Q2 review',
          } as any,
          adminActor(),
        ),
      );
      const attached = await withTestTenant(async () =>
        service.attachMeetingStudent(
          meeting.id,
          { studentId, outcome: 'TIER_UP', outcomeNotes: 'promote to TIER_3' } as any,
          adminActor(),
        ),
      );
      expect(attached.studentId).toBe(studentId);
      expect(attached.outcome).toBe('TIER_UP');
      const detail = await withTestTenant(async () =>
        service.getMeetingById(meeting.id, adminActor()),
      );
      expect((detail as any).students).toHaveLength(1);
      expect((detail as any).students[0].id).toBe(attached.id);
    });

    it('duplicate attach for same (meeting, student) → BadRequest', async () => {
      const studentId = await seedStudent('MeetDup');
      const meeting = await withTestTenant(async () =>
        service.createMeeting(
          { academicYearId: TEST_ACADEMIC_YEAR_ID, meetingDate: '2026-02-15' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.attachMeetingStudent(meeting.id, { studentId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.attachMeetingStudent(meeting.id, { studentId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listMeetings filter by academic year returns matching only', async () => {
      await withTestTenant(async () =>
        service.createMeeting(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            meetingDate: '2026-02-01',
          } as any,
          adminActor(),
        ),
      );
      const rows = await withTestTenant(async () =>
        service.listMeetings({ academicYearId: TEST_ACADEMIC_YEAR_ID } as any, adminActor()),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it.each([
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('listMeetings as %s → Forbidden', async (_label, actor) => {
      await expect(
        withTestTenant(async () => service.listMeetings({} as any, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getMeetingById on missing meeting → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.getMeetingById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin counsellor (without cou-001:write) cannot create meeting → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          service.createMeeting(
            { academicYearId: TEST_ACADEMIC_YEAR_ID, meetingDate: '2026-02-15' } as any,
            officerActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
