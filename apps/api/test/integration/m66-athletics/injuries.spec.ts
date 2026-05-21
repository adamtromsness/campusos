import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ProgrammeService } from '@modules/m66-athletics/programme.service';
import { InjuryService } from '@modules/m66-athletics/injury.service';
import { ConcussionProtocolService } from '@modules/m66-athletics/concussion-protocol.service';
import { MedicalClearanceService } from '@modules/m66-athletics/medical-clearance.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { seedStudent } from '../m20-sis/sis-helpers';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  TEST_ATH_ROSTER_A_ID,
} from '../fixtures/athletics';

describe('integration:m66-athletics/injuries', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let programmes: ProgrammeService;
  let injuries: InjuryService;
  let protocol: ConcussionProtocolService;
  let clearance: MedicalClearanceService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    programmes = new ProgrammeService(tenantPrisma, permCheck);
    injuries = new InjuryService(tenantPrisma, programmes);
    protocol = new ConcussionProtocolService(tenantPrisma, programmes);
    clearance = new MedicalClearanceService(tenantPrisma, programmes);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAthleticsTables(rawClient);
    if (studentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        studentIds.splice(0),
      );
    }
    if (platformStudentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        platformStudentIds.splice(0),
      );
    }
    if (personIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        personIds.splice(0),
      );
    }
    await ensureAthleticsSeed(rawClient);
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function addRosterMember(studentId: string) {
    const rows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.ath_roster_members (id, roster_id, student_id, eligibility_status)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ELIGIBLE')
       RETURNING id::text AS id`,
      TEST_ATH_ROSTER_A_ID,
      studentId,
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  }

  // ─────────────────────────────────────────────────────────────────
  // create
  // ─────────────────────────────────────────────────────────────────
  it('create: admin logs a SIDELINED injury', async () => {
    const stu = await trackedSeedStudent();
    await addRosterMember(stu.studentId);
    const inj = await withTestTenant(() =>
      injuries.create(
        {
          studentId: stu.studentId,
          injuryDate: '2026-09-01',
          bodyPart: 'Ankle',
          injuryDescription: 'Sprain',
          severity: 'MINOR',
          returnToPlayStatus: 'SIDELINED',
        } as any,
        adminActor(),
      ),
    );
    expect(inj.bodyPart).toBe('Ankle');
    expect(inj.returnToPlayStatus).toBe('SIDELINED');
  });

  it('create: CONCUSSION_PROTOCOL flips roster_member to INJURED_NOT_CLEARED', async () => {
    const stu = await trackedSeedStudent();
    const memberId = await addRosterMember(stu.studentId);
    await withTestTenant(() =>
      injuries.create(
        {
          studentId: stu.studentId,
          injuryDate: '2026-09-01',
          bodyPart: 'Head',
          injuryDescription: 'Concussion',
          severity: 'SEVERE',
          returnToPlayStatus: 'CONCUSSION_PROTOCOL',
        } as any,
        adminActor(),
      ),
    );
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT eligibility_status FROM ${TEST_SCHEMA}.ath_roster_members WHERE id = $1::uuid`,
      memberId,
    )) as Array<{ eligibility_status: string }>;
    expect(rows[0]!.eligibility_status).toBe('INJURED_NOT_CLEARED');
  });

  it('create: bad student → BadRequestException', async () => {
    await expect(
      withTestTenant(() =>
        injuries.create(
          {
            studentId: '00000000-0000-0000-0000-000000000000',
            injuryDate: '2026-09-01',
            bodyPart: 'X',
            injuryDescription: 'Y',
            severity: 'MINOR',
            returnToPlayStatus: 'SIDELINED',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: student → ForbiddenException', async () => {
    const stu = await trackedSeedStudent();
    await expect(
      withTestTenant(() =>
        injuries.create(
          {
            studentId: stu.studentId,
            injuryDate: '2026-09-01',
            bodyPart: 'X',
            injuryDescription: 'Y',
            severity: 'MINOR',
            returnToPlayStatus: 'SIDELINED',
          } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create: actor without employeeId → ForbiddenException', async () => {
    const ghost: any = {
      accountId: '019e0cf8-aaaa-7777-8888-000000000099',
      personId: '019e0cf8-aaaa-7777-8888-000000000098',
      employeeId: null,
      personType: 'STAFF',
      isSchoolAdmin: true,
    };
    const stu = await trackedSeedStudent();
    await expect(
      withTestTenant(() =>
        injuries.create(
          {
            studentId: stu.studentId,
            injuryDate: '2026-09-01',
            bodyPart: 'X',
            injuryDescription: 'Y',
            severity: 'MINOR',
            returnToPlayStatus: 'SIDELINED',
          } as any,
          ghost,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────
  // list / getById / row-scope
  // ─────────────────────────────────────────────────────────────────
  it('list + getById: admin sees all', async () => {
    const stu = await trackedSeedStudent();
    await addRosterMember(stu.studentId);
    const inj = await withTestTenant(() =>
      injuries.create(
        {
          studentId: stu.studentId,
          injuryDate: '2026-09-01',
          bodyPart: 'X',
          injuryDescription: 'Y',
          severity: 'MINOR',
          returnToPlayStatus: 'SIDELINED',
        } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(() =>
      injuries.list({ status: 'SIDELINED', studentId: stu.studentId }, adminActor()),
    );
    expect(list.map((x) => x.id)).toContain(inj.id);

    const got = await withTestTenant(() => injuries.getById(inj.id, adminActor()));
    expect(got.id).toBe(inj.id);
  });

  it('list: parent (no row scope) → []', async () => {
    const list = await withTestTenant(() => injuries.list({}, parentActor()));
    expect(list).toEqual([]);
  });

  it('list: student without sis_students row → []', async () => {
    const list = await withTestTenant(() => injuries.list({}, studentActor()));
    expect(list).toEqual([]);
  });

  it('list: student WITH linked sis_students sees own injuries', async () => {
    // Link studentActor.personId to a sis_students row. The platform_students
    // row may already exist (cross-spec residue); fetch or create idempotently.
    const existingPs = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
      TEST_STUDENT_PERSON_ID,
    )) as Array<{ id: string }>;
    let psId: string;
    if (existingPs.length > 0) {
      psId = existingPs[0]!.id;
    } else {
      const psRows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES (gen_random_uuid(), $1::uuid, 'Self', 'Stu', true)
         RETURNING id::text AS id`,
        TEST_STUDENT_PERSON_ID,
      )) as Array<{ id: string }>;
      psId = psRows[0]!.id;
      platformStudentIds.push(psId);
    }
    const existingStu = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
      psId,
      TEST_SCHOOL_ID,
    )) as Array<{ id: string }>;
    let stuId: string;
    if (existingStu.length > 0) {
      stuId = existingStu[0]!.id;
    } else {
      const stuRows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, '11', 'ENROLLED')
         RETURNING id::text AS id`,
        psId,
        TEST_SCHOOL_ID,
        'INJ-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      )) as Array<{ id: string }>;
      stuId = stuRows[0]!.id;
      studentIds.push(stuId);
    }

    await addRosterMember(stuId);
    const inj = await withTestTenant(() =>
      injuries.create(
        {
          studentId: stuId,
          injuryDate: '2026-09-01',
          bodyPart: 'X',
          injuryDescription: 'Y',
          severity: 'MINOR',
          returnToPlayStatus: 'SIDELINED',
        } as any,
        adminActor(),
      ),
    );

    const list = await withTestTenant(() => injuries.list({}, studentActor()));
    expect(list.map((x) => x.id)).toContain(inj.id);
  });

  it('list: teacher (no class/coach link) → empty', async () => {
    const stu = await trackedSeedStudent();
    await addRosterMember(stu.studentId);
    await withTestTenant(() =>
      injuries.create(
        {
          studentId: stu.studentId,
          injuryDate: '2026-09-01',
          bodyPart: 'X',
          injuryDescription: 'Y',
          severity: 'MINOR',
          returnToPlayStatus: 'SIDELINED',
        } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(() => injuries.list({}, teacherActor()));
    // Teacher has no class teaching link + no coaching assignment → none.
    expect(list).toEqual([]);
  });

  it('getById: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(() => injuries.getById('00000000-0000-0000-0000-000000000000', adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getById: parent → NotFoundException (no row scope)', async () => {
    await expect(
      withTestTenant(() => injuries.getById('00000000-0000-0000-0000-000000000000', parentActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─────────────────────────────────────────────────────────────────
  // patch + concussion clearance path
  // ─────────────────────────────────────────────────────────────────
  it('patch: admin updates severity + action_taken', async () => {
    const stu = await trackedSeedStudent();
    await addRosterMember(stu.studentId);
    const inj = await withTestTenant(() =>
      injuries.create(
        {
          studentId: stu.studentId,
          injuryDate: '2026-09-01',
          bodyPart: 'X',
          injuryDescription: 'Y',
          severity: 'MINOR',
          returnToPlayStatus: 'SIDELINED',
        } as any,
        adminActor(),
      ),
    );
    const patched = await withTestTenant(() =>
      injuries.patch(
        inj.id,
        {
          initialAssessment: 'OK',
          actionTaken: 'Ice',
          severity: 'MODERATE',
        } as any,
        adminActor(),
      ),
    );
    expect(patched.severity).toBe('MODERATE');
    expect(patched.actionTaken).toBe('Ice');
  });

  it('patch: missing → NotFoundException + student → ForbiddenException', async () => {
    await expect(
      withTestTenant(() =>
        injuries.patch(
          '00000000-0000-0000-0000-000000000000',
          { severity: 'MINOR' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      withTestTenant(() =>
        injuries.patch(
          '00000000-0000-0000-0000-000000000000',
          { severity: 'MINOR' } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch: CLEARED for non-concussion injury restores eligibility', async () => {
    const stu = await trackedSeedStudent();
    await addRosterMember(stu.studentId);
    const inj = await withTestTenant(() =>
      injuries.create(
        {
          studentId: stu.studentId,
          injuryDate: '2026-09-01',
          bodyPart: 'Knee',
          injuryDescription: 'Strain',
          severity: 'MODERATE',
          returnToPlayStatus: 'SIDELINED',
        } as any,
        adminActor(),
      ),
    );
    const cleared = await withTestTenant(() =>
      injuries.patch(inj.id, { returnToPlayStatus: 'CLEARED' } as any, adminActor()),
    );
    expect(cleared.returnToPlayStatus).toBe('CLEARED');
    expect(cleared.clearedAt).not.toBeNull();
  });

  it('patch: CLEARED on CONCUSSION without all 6 steps → BadRequestException', async () => {
    const stu = await trackedSeedStudent();
    await addRosterMember(stu.studentId);
    const inj = await withTestTenant(() =>
      injuries.create(
        {
          studentId: stu.studentId,
          injuryDate: '2026-09-01',
          bodyPart: 'Head',
          injuryDescription: 'Concussion',
          severity: 'SEVERE',
          returnToPlayStatus: 'CONCUSSION_PROTOCOL',
        } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() =>
        injuries.patch(inj.id, { returnToPlayStatus: 'CLEARED' } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Concussion protocol — safety keystone
  // ─────────────────────────────────────────────────────────────────
  describe('ConcussionProtocolService', () => {
    async function newConcussionInjury() {
      const stu = await trackedSeedStudent();
      await addRosterMember(stu.studentId);
      const inj = await withTestTenant(() =>
        injuries.create(
          {
            studentId: stu.studentId,
            injuryDate: '2026-09-01',
            bodyPart: 'Head',
            injuryDescription: 'Concussion',
            severity: 'SEVERE',
            returnToPlayStatus: 'CONCUSSION_PROTOCOL',
          } as any,
          adminActor(),
        ),
      );
      return { inj, studentId: stu.studentId };
    }

    it('startStep: step 1 with minimumDurationHours override', async () => {
      const { inj } = await newConcussionInjury();
      const step = await withTestTenant(() =>
        protocol.startStep(
          inj.id,
          { stepNumber: 1, stepName: 'Rest', minimumDurationHours: 1, notes: 'start' } as any,
          adminActor(),
        ),
      );
      expect(step.stepNumber).toBe(1);
      expect(step.minimumDurationHours).toBe(1);
    });

    it('startStep: not-CONCUSSION injury → BadRequestException', async () => {
      const stu = await trackedSeedStudent();
      await addRosterMember(stu.studentId);
      const inj = await withTestTenant(() =>
        injuries.create(
          {
            studentId: stu.studentId,
            injuryDate: '2026-09-01',
            bodyPart: 'Knee',
            injuryDescription: 'Strain',
            severity: 'MINOR',
            returnToPlayStatus: 'SIDELINED',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          protocol.startStep(inj.id, { stepNumber: 1, stepName: 'Rest' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('startStep: step 2 before step 1 → BadRequestException', async () => {
      const { inj } = await newConcussionInjury();
      await expect(
        withTestTenant(() =>
          protocol.startStep(inj.id, { stepNumber: 2, stepName: 'Light' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('startStep: step 2 before step 1 completed → BadRequestException', async () => {
      const { inj } = await newConcussionInjury();
      await withTestTenant(() =>
        protocol.startStep(
          inj.id,
          { stepNumber: 1, stepName: 'Rest', minimumDurationHours: 1 } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          protocol.startStep(inj.id, { stepNumber: 2, stepName: 'Light' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('completeStep: minimumDurationHours not yet elapsed → BadRequestException', async () => {
      const { inj } = await newConcussionInjury();
      const step1 = await withTestTenant(() =>
        protocol.startStep(
          inj.id,
          { stepNumber: 1, stepName: 'Rest', minimumDurationHours: 24 } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          protocol.completeStep(step1.id, { symptomFree: true } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('completeStep: with elapsed time + symptomFree advances', async () => {
      const { inj } = await newConcussionInjury();
      const step1 = await withTestTenant(() =>
        protocol.startStep(
          inj.id,
          { stepNumber: 1, stepName: 'Rest', minimumDurationHours: 1 } as any,
          adminActor(),
        ),
      );
      // Backdate started_at so the duration has elapsed.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_concussion_protocol_steps SET started_at = now() - INTERVAL '2 hours' WHERE id = $1::uuid`,
        step1.id,
      );
      const completed = await withTestTenant(() =>
        protocol.completeStep(step1.id, { symptomFree: true, notes: 'done' } as any, adminActor()),
      );
      expect(completed.completedAt).not.toBeNull();
      expect(completed.symptomFree).toBe(true);
    });

    it('full 6-step protocol completes + injury can CLEAR with medical clearance', async () => {
      const { inj, studentId } = await newConcussionInjury();
      for (let n = 1; n <= 6; n++) {
        const step = await withTestTenant(() =>
          protocol.startStep(
            inj.id,
            { stepNumber: n, stepName: `Step ${n}`, minimumDurationHours: 1 } as any,
            adminActor(),
          ),
        );
        // Backdate so completion is allowed
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.ath_concussion_protocol_steps SET started_at = now() - INTERVAL '2 hours' WHERE id = $1::uuid`,
          step.id,
        );
        await withTestTenant(() =>
          protocol.completeStep(step.id, { symptomFree: true } as any, adminActor()),
        );
      }
      // Without medical clearance, still rejected
      await expect(
        withTestTenant(() =>
          injuries.patch(inj.id, { returnToPlayStatus: 'CLEARED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Upload + review clearance → ACCEPTED restores eligibility
      const c = await withTestTenant(() =>
        clearance.upload(
          inj.id,
          {
            documentS3Key: 'docs/clear.pdf',
            physicianName: 'Dr. X',
            clearanceDate: '2026-09-30',
          } as any,
          adminActor(),
        ),
      );
      const reviewed = await withTestTenant(() =>
        clearance.review(c.id, { decision: 'ACCEPTED' } as any, adminActor()),
      );
      expect(reviewed.reviewStatus).toBe('ACCEPTED');

      // roster member should be ELIGIBLE again
      const memberRows = (await rawClient.$queryRawUnsafe(
        `SELECT eligibility_status FROM ${TEST_SCHEMA}.ath_roster_members WHERE student_id = $1::uuid`,
        studentId,
      )) as Array<{ eligibility_status: string }>;
      expect(memberRows[0]!.eligibility_status).toBe('ELIGIBLE');

      // injury record is CLEARED
      const injRows = (await rawClient.$queryRawUnsafe(
        `SELECT return_to_play_status FROM ${TEST_SCHEMA}.ath_injuries WHERE id = $1::uuid`,
        inj.id,
      )) as Array<{ return_to_play_status: string }>;
      expect(injRows[0]!.return_to_play_status).toBe('CLEARED');
    });

    it('startStep: student → ForbiddenException', async () => {
      const { inj } = await newConcussionInjury();
      await expect(
        withTestTenant(() =>
          protocol.startStep(inj.id, { stepNumber: 1, stepName: 'X' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('completeStep: student → ForbiddenException', async () => {
      const { inj } = await newConcussionInjury();
      const step = await withTestTenant(() =>
        protocol.startStep(
          inj.id,
          { stepNumber: 1, stepName: 'Rest', minimumDurationHours: 1 } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          protocol.completeStep(step.id, { symptomFree: true } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('completeStep: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() =>
          protocol.completeStep(
            '00000000-0000-0000-0000-000000000000',
            { symptomFree: true } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('completeStep: already-complete → BadRequestException', async () => {
      const { inj } = await newConcussionInjury();
      const step = await withTestTenant(() =>
        protocol.startStep(
          inj.id,
          { stepNumber: 1, stepName: 'Rest', minimumDurationHours: 1 } as any,
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_concussion_protocol_steps SET started_at = now() - INTERVAL '2 hours' WHERE id = $1::uuid`,
        step.id,
      );
      await withTestTenant(() =>
        protocol.completeStep(step.id, { symptomFree: true } as any, adminActor()),
      );
      await expect(
        withTestTenant(() =>
          protocol.completeStep(step.id, { symptomFree: true } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('completeStep: actor without employeeId → ForbiddenException', async () => {
      const ghost: any = {
        accountId: '019e0cf8-aaaa-7777-8888-000000000099',
        personId: '019e0cf8-aaaa-7777-8888-000000000098',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(() =>
          protocol.completeStep(
            '00000000-0000-0000-0000-000000000000',
            { symptomFree: true } as any,
            ghost,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForInjury: returns ordered steps with canStartNext flag', async () => {
      const { inj } = await newConcussionInjury();
      const list = await withTestTenant(() => protocol.listForInjury(inj.id));
      expect(list).toEqual([]);
      const step = await withTestTenant(() =>
        protocol.startStep(
          inj.id,
          { stepNumber: 1, stepName: 'Rest', minimumDurationHours: 1 } as any,
          adminActor(),
        ),
      );
      // backdate + complete
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_concussion_protocol_steps SET started_at = now() - INTERVAL '2 hours' WHERE id = $1::uuid`,
        step.id,
      );
      await withTestTenant(() =>
        protocol.completeStep(step.id, { symptomFree: true } as any, adminActor()),
      );
      const list2 = await withTestTenant(() => protocol.listForInjury(inj.id));
      expect(list2[0]!.canStartNext).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MedicalClearanceService
  // ─────────────────────────────────────────────────────────────────
  describe('MedicalClearanceService', () => {
    async function newInjuryWithClearance(concussion = false) {
      const stu = await trackedSeedStudent();
      await addRosterMember(stu.studentId);
      const inj = await withTestTenant(() =>
        injuries.create(
          {
            studentId: stu.studentId,
            injuryDate: '2026-09-01',
            bodyPart: concussion ? 'Head' : 'Knee',
            injuryDescription: concussion ? 'Concussion' : 'Strain',
            severity: concussion ? 'SEVERE' : 'MINOR',
            returnToPlayStatus: concussion ? 'CONCUSSION_PROTOCOL' : 'SIDELINED',
          } as any,
          adminActor(),
        ),
      );
      const c = await withTestTenant(() =>
        clearance.upload(
          inj.id,
          {
            documentS3Key: 'docs/x.pdf',
            physicianName: 'Dr. A',
            physicianPhone: '555',
            clearanceDate: '2026-10-01',
            expiresAt: '2027-10-01',
          } as any,
          adminActor(),
        ),
      );
      return { inj, c, studentId: stu.studentId };
    }

    it('upload + listForInjury + review ACCEPTED for non-concussion restores roster + clears injury', async () => {
      const { inj, c, studentId } = await newInjuryWithClearance(false);
      // Force the roster member to INJURED_NOT_CLEARED to verify restore
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_roster_members SET eligibility_status = 'INJURED_NOT_CLEARED' WHERE student_id = $1::uuid`,
        studentId,
      );
      const list = await withTestTenant(() => clearance.listForInjury(inj.id));
      expect(list.map((x) => x.id)).toContain(c.id);

      const reviewed = await withTestTenant(() =>
        clearance.review(c.id, { decision: 'ACCEPTED', reviewNotes: 'ok' } as any, adminActor()),
      );
      expect(reviewed.reviewStatus).toBe('ACCEPTED');

      const injRows = (await rawClient.$queryRawUnsafe(
        `SELECT return_to_play_status FROM ${TEST_SCHEMA}.ath_injuries WHERE id = $1::uuid`,
        inj.id,
      )) as Array<{ return_to_play_status: string }>;
      expect(injRows[0]!.return_to_play_status).toBe('CLEARED');
    });

    it('review: REJECTED leaves injury unchanged', async () => {
      const { inj, c } = await newInjuryWithClearance(false);
      await withTestTenant(() =>
        clearance.review(c.id, { decision: 'REJECTED' } as any, adminActor()),
      );
      const injRows = (await rawClient.$queryRawUnsafe(
        `SELECT return_to_play_status FROM ${TEST_SCHEMA}.ath_injuries WHERE id = $1::uuid`,
        inj.id,
      )) as Array<{ return_to_play_status: string }>;
      expect(injRows[0]!.return_to_play_status).toBe('SIDELINED');
    });

    it('review: CONCUSSION clearance ACCEPTED but no steps → row stays accepted but injury NOT CLEARED', async () => {
      const { inj, c } = await newInjuryWithClearance(true);
      const reviewed = await withTestTenant(() =>
        clearance.review(c.id, { decision: 'ACCEPTED' } as any, adminActor()),
      );
      expect(reviewed.reviewStatus).toBe('ACCEPTED');
      const injRows = (await rawClient.$queryRawUnsafe(
        `SELECT return_to_play_status FROM ${TEST_SCHEMA}.ath_injuries WHERE id = $1::uuid`,
        inj.id,
      )) as Array<{ return_to_play_status: string }>;
      expect(injRows[0]!.return_to_play_status).toBe('CONCUSSION_PROTOCOL');
    });

    it('review: re-review terminal → BadRequestException', async () => {
      const { c } = await newInjuryWithClearance(false);
      await withTestTenant(() =>
        clearance.review(c.id, { decision: 'ACCEPTED' } as any, adminActor()),
      );
      await expect(
        withTestTenant(() => clearance.review(c.id, { decision: 'REJECTED' } as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('upload: student → ForbiddenException', async () => {
      const stu = await trackedSeedStudent();
      await addRosterMember(stu.studentId);
      const inj = await withTestTenant(() =>
        injuries.create(
          {
            studentId: stu.studentId,
            injuryDate: '2026-09-01',
            bodyPart: 'X',
            injuryDescription: 'Y',
            severity: 'MINOR',
            returnToPlayStatus: 'SIDELINED',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          clearance.upload(
            inj.id,
            { documentS3Key: 'd.pdf', clearanceDate: '2026-09-30' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('upload: actor without employeeId → ForbiddenException', async () => {
      const ghost: any = {
        accountId: '019e0cf8-aaaa-7777-8888-000000000099',
        personId: '019e0cf8-aaaa-7777-8888-000000000098',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(() =>
          clearance.upload(
            '00000000-0000-0000-0000-000000000000',
            { documentS3Key: 'd.pdf', clearanceDate: '2026-09-30' } as any,
            ghost,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('review: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          clearance.review(
            '00000000-0000-0000-0000-000000000000',
            { decision: 'ACCEPTED' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('review: actor without employeeId → ForbiddenException', async () => {
      const ghost: any = {
        accountId: '019e0cf8-aaaa-7777-8888-000000000099',
        personId: '019e0cf8-aaaa-7777-8888-000000000098',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(() =>
          clearance.review(
            '00000000-0000-0000-0000-000000000000',
            { decision: 'ACCEPTED' } as any,
            ghost,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
