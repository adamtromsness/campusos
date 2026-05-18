import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { IepPlanService } from '@modules/m23-health/iep/iep-plan.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';

describe('integration:m23-health/iep-goals-services-progress', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let accessLog: HealthAccessLogService;
  let records: HealthRecordService;
  let outbox: OutboxService;
  let service: IepPlanService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    const guardianAuthz = new GuardianAuthorizationService(tenantPrisma);
    outbox = new OutboxService();
    accessLog = new HealthAccessLogService(tenantPrisma);
    records = new HealthRecordService(
      tenantPrisma,
      accessLog,
      permCheck,
      guardianAuthz,
      outbox,
    );
    service = new IepPlanService(tenantPrisma, accessLog, records, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_iep_plans WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'GS-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'GS-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'GS-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'GS-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'iep.accommodation.updated' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'GS-Stu', $2, 'STUDENT', true)`,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'GS-Stu', $3, true)`,
      platformStudentId,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'GS-' + suffix,
    );
    return studentId;
  }

  async function seedPlan(): Promise<{ studentId: string; planId: string }> {
    const studentId = await seedStudent();
    const plan = await withTestTenant(async () =>
      service.create(studentId, { planType: 'IEP' }, adminActor()),
    );
    return { studentId, planId: plan.id };
  }

  // ─── Goals ────────────────────────────────────────────────────

  describe('addGoal / updateGoal', () => {
    it('admin adds a goal under an IEP plan', async () => {
      const { planId } = await seedPlan();
      const g = await withTestTenant(async () =>
        service.addGoal(
          planId,
          {
            goalText: 'Read 100 words per minute by end of year',
            measurementCriteria: 'CBM-R probe',
            baseline: '60 WPM',
            targetValue: '100 WPM',
            currentValue: '60 WPM',
            goalArea: 'READING',
          },
          adminActor(),
        ),
      );
      expect(g.goalText).toContain('100 words');
      expect(g.status).toBe('ACTIVE');
    });

    it('admin updates a goal', async () => {
      const { planId } = await seedPlan();
      const g = await withTestTenant(async () =>
        service.addGoal(
          planId,
          { goalText: 'baseline goal' },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () =>
        service.updateGoal(
          g.id,
          {
            goalText: 'Updated goal text',
            measurementCriteria: 'Updated criteria',
            baseline: 'b',
            targetValue: 't',
            currentValue: 'c',
            goalArea: 'WRITING',
            status: 'MET',
          },
          adminActor(),
        ),
      );
      expect(u.status).toBe('MET');
      expect(u.goalArea).toBe('WRITING');
    });

    it('empty patch returns existing goal', async () => {
      const { planId } = await seedPlan();
      const g = await withTestTenant(async () =>
        service.addGoal(planId, { goalText: 'g' }, adminActor()),
      );
      const r = await withTestTenant(async () =>
        service.updateGoal(g.id, {}, adminActor()),
      );
      expect(r.id).toBe(g.id);
    });

    it('addGoal missing plan → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.addGoal(generateId(), { goalText: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateGoal missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.updateGoal(generateId(), { status: 'MET' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden on addGoal/updateGoal', async () => {
      const { planId } = await seedPlan();
      await expect(
        withTestTenant(async () =>
          service.addGoal(planId, { goalText: 'x' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── Goal progress ────────────────────────────────────────────

  describe('addGoalProgress', () => {
    async function seedGoal(): Promise<string> {
      const { planId } = await seedPlan();
      const g = await withTestTenant(async () =>
        service.addGoal(planId, { goalText: 'g' }, adminActor()),
      );
      return g.id;
    }

    it('admin records progress on a goal', async () => {
      const goalId = await seedGoal();
      const p = await withTestTenant(async () =>
        service.addGoalProgress(
          goalId,
          { progressValue: '70 WPM', observationNotes: 'Improving' },
          adminActor(),
        ),
      );
      expect(p.progressValue).toBe('70 WPM');
      expect(p.recordedById).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('addGoalProgress on missing goal → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.addGoalProgress(
            generateId(),
            { progressValue: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden', async () => {
      const goalId = await seedGoal();
      await expect(
        withTestTenant(async () =>
          service.addGoalProgress(goalId, { progressValue: 'x' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('actor without employeeId → Forbidden', async () => {
      const goalId = await seedGoal();
      const noEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          service.addGoalProgress(goalId, { progressValue: 'x' }, noEmp),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── Services ─────────────────────────────────────────────────

  describe('addService / updateService', () => {
    it('admin adds a service to a plan', async () => {
      const { planId } = await seedPlan();
      const s = await withTestTenant(async () =>
        service.addService(
          planId,
          {
            serviceType: 'Speech Therapy',
            providerName: 'Therapist A',
            frequency: '2x weekly',
            minutesPerSession: 30,
            deliveryMethod: 'PULL_OUT',
          },
          adminActor(),
        ),
      );
      expect(s.serviceType).toBe('Speech Therapy');
      expect(s.deliveryMethod).toBe('PULL_OUT');
    });

    it('admin updates a service', async () => {
      const { planId } = await seedPlan();
      const s = await withTestTenant(async () =>
        service.addService(
          planId,
          { serviceType: 'OT', deliveryMethod: 'PUSH_IN' },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () =>
        service.updateService(
          s.id,
          {
            serviceType: 'Occupational Therapy',
            providerName: 'Therapist B',
            frequency: '1x weekly',
            minutesPerSession: 45,
            deliveryMethod: 'CONSULT',
          },
          adminActor(),
        ),
      );
      expect(u.serviceType).toBe('Occupational Therapy');
      expect(u.deliveryMethod).toBe('CONSULT');
    });

    it('empty patch returns existing service', async () => {
      const { planId } = await seedPlan();
      const s = await withTestTenant(async () =>
        service.addService(
          planId,
          { serviceType: 'OT', deliveryMethod: 'PULL_OUT' },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        service.updateService(s.id, {}, adminActor()),
      );
      expect(r.id).toBe(s.id);
    });

    it('addService missing plan → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.addService(
            generateId(),
            { serviceType: 'x', deliveryMethod: 'PULL_OUT' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateService missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.updateService(
            generateId(),
            { serviceType: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden on addService / updateService', async () => {
      const { planId } = await seedPlan();
      await expect(
        withTestTenant(async () =>
          service.addService(
            planId,
            { serviceType: 'x', deliveryMethod: 'PULL_OUT' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
