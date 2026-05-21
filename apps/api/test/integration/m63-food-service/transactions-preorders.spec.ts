import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import {
  PosService,
  SessionService,
  TransactionService,
  ReconciliationService,
} from '@modules/m63-food-service/pos.service';
import { PreorderService } from '@modules/m63-food-service/preorder.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import {
  resetFoodServiceTables,
  ensureFoodServiceSeed,
  TEST_MENU_ITEM_ID,
  TEST_POS_DEVICE_ID,
} from '../fixtures/food-service';

const TEST_FDS_PLAT_STU_ID = '019e0cf8-aaaa-7777-8888-000000063110';
const TEST_FDS_SIS_STU_ID_CONST = '019e0cf8-aaaa-7777-8888-000000063111';
const TEST_FDS_GUARDIAN_ID = '019e0cf8-aaaa-7777-8888-000000063112';

let studentRowId: string;

async function seedStudentWithGuardian(rawClient: PrismaClient): Promise<void> {
  await rawClient.$executeRawUnsafe(
    `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
     VALUES ($1::uuid, $2::uuid, 'Tx', 'Student')
     ON CONFLICT (person_id) DO UPDATE SET first_name = EXCLUDED.first_name`,
    TEST_FDS_PLAT_STU_ID,
    TEST_STUDENT_PERSON_ID,
  );
  const psRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid`,
    TEST_STUDENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const platformStudentId = psRows[0]!.id;

  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '5', 'ENROLLED')
     ON CONFLICT (platform_student_id) DO NOTHING`,
    TEST_FDS_SIS_STU_ID_CONST,
    TEST_SCHOOL_ID,
    platformStudentId,
  );
  const ss = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid`,
    platformStudentId,
  )) as Array<{ id: string }>;
  studentRowId = ss[0]!.id;

  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, school_id, person_id, relationship, preferred_contact_method)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT', 'EMAIL')
     ON CONFLICT (school_id, person_id) DO NOTHING`,
    TEST_FDS_GUARDIAN_ID,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  );
  const sg = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_guardians WHERE school_id = $1::uuid AND person_id = $2::uuid`,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  )) as Array<{ id: string }>;
  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians (id, student_id, guardian_id, has_custody, portal_access, receives_reports)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true)
     ON CONFLICT (student_id, guardian_id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000063113',
    studentRowId,
    sg[0]!.id,
  );
}

describe('integration:m63-food-service/transactions-preorders', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let pos: PosService;
  let sessions: SessionService;
  let txns: TransactionService;
  let recon: ReconciliationService;
  let preorders: PreorderService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    kafka = makeRecordingKafka();
    pos = new PosService(tenantPrisma);
    sessions = new SessionService(tenantPrisma);
    txns = new TransactionService(tenantPrisma, kafka);
    recon = new ReconciliationService(tenantPrisma);
    preorders = new PreorderService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    // Clean up cross-spec rows
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE id = '019e0cf8-aaaa-7777-8888-000000063113'::uuid`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = $1::uuid`,
      TEST_FDS_GUARDIAN_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id IN (
         SELECT id FROM platform.platform_students WHERE person_id = $1::uuid
       )`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFoodServiceTables(rawClient);
    await ensureFoodServiceSeed(rawClient);
    await seedStudentWithGuardian(rawClient);
    (kafka as unknown as RecordingKafkaProducer).reset();
  });

  // ─── TransactionService — meal-served KEYSTONE ────
  describe('TransactionService — KEYSTONE fds.meal.served', () => {
    async function openSession() {
      return withTestTenant(async () =>
        sessions.open({ serviceDate: '2026-09-15', mealType: 'LUNCH' } as any, adminActor()),
      );
    }

    it('create transaction emits fds.meal.served with payload', async () => {
      const session = await openSession();
      const tx = await withTestTenant(async () =>
        txns.create(
          {
            patronId: TEST_STUDENT_PERSON_ID,
            patronType: 'STUDENT',
            sessionId: session.id,
            posDeviceId: TEST_POS_DEVICE_ID,
            items: [{ itemId: TEST_MENU_ITEM_ID, name: 'Apple Slices', price: 1.5 }],
            paymentMethod: 'LUNCH_ACCOUNT',
          } as any,
          adminActor(),
        ),
      );
      expect(tx.total).toBe(1.5);

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic('fds.meal.served');
      expect(emits.length).toBeGreaterThan(0);
      expect(emits[0]!.payload).toMatchObject({
        patronId: TEST_STUDENT_PERSON_ID,
      });
    });

    it('list returns transactions for session', async () => {
      const session = await openSession();
      const tx = await withTestTenant(async () =>
        txns.create(
          {
            patronId: TEST_STUDENT_PERSON_ID,
            patronType: 'STUDENT',
            sessionId: session.id,
            posDeviceId: TEST_POS_DEVICE_ID,
            items: [{ itemId: TEST_MENU_ITEM_ID, name: 'Apple', price: 1 }],
            paymentMethod: 'CASH',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => txns.list({ sessionId: session.id }));
      expect(list.map((t) => t.id)).toContain(tx.id);
    });

    it('checkAllergens returns response for student', async () => {
      const result = await withTestTenant(async () => txns.checkAllergens(TEST_STUDENT_PERSON_ID));
      expect(result).toBeTruthy();
    });

    it('STAFF transaction → patronType=STAFF', async () => {
      const session = await openSession();
      const tx = await withTestTenant(async () =>
        txns.create(
          {
            patronId: TEST_ADMIN_PERSON_ID,
            patronType: 'STAFF',
            sessionId: session.id,
            posDeviceId: TEST_POS_DEVICE_ID,
            items: [{ itemId: TEST_MENU_ITEM_ID, name: 'Apple', price: 1 }],
            paymentMethod: 'STAFF_ACCOUNT',
          } as any,
          adminActor(),
        ),
      );
      expect(tx.patronType).toBe('STAFF');
    });
  });

  // ─── ReconciliationService ──────────────────────
  describe('ReconciliationService', () => {
    it('getBySession returns array (empty for fresh session)', async () => {
      const session = await withTestTenant(async () =>
        sessions.open({ serviceDate: '2026-09-16', mealType: 'LUNCH' } as any, adminActor()),
      );
      const list = await withTestTenant(async () => recon.getBySession(session.id));
      expect(Array.isArray(list)).toBe(true);
    });

    it('patch updates a reconciliation row', async () => {
      const session = await withTestTenant(async () =>
        sessions.open({ serviceDate: '2026-09-17', mealType: 'LUNCH' } as any, adminActor()),
      );
      // Seed a reconciliation row directly
      const reconId = '019e0cf8-aaaa-7777-8888-000000063200';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fds_cash_drawer_reconciliation
           (id, session_id, pos_device_id, opening_balance, expected_closing_balance, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 100, 500, 'OPEN')`,
        reconId,
        session.id,
        TEST_POS_DEVICE_ID,
      );
      const patched = await withTestTenant(async () =>
        recon.patch(
          reconId,
          { actualClosingBalance: 500, status: 'RECONCILED' } as any,
          adminActor(),
        ),
      );
      expect(patched.status).toBe('RECONCILED');
    });
  });

  // ─── PreorderService — order lifecycle ──────────
  describe('PreorderService — order lifecycle', () => {
    async function makeWindow() {
      // Open the window NOW so the time-gated create path doesn't reject.
      const now = new Date();
      const opens = new Date(now.getTime() - 3600 * 1000); // 1h ago
      const closes = new Date(now.getTime() + 365 * 24 * 3600 * 1000); // 1y forward
      const todayDate = now.toISOString().slice(0, 10);
      return withTestTenant(async () =>
        preorders.createWindow(
          {
            serviceDate: todayDate,
            mealType: 'LUNCH',
            opensAt: opens.toISOString(),
            closesAt: closes.toISOString(),
          } as any,
          adminActor(),
        ),
      );
    }

    it('create preorder + listPreorders + getPreorderById + confirm', async () => {
      const window = await makeWindow();
      const order = await withTestTenant(async () =>
        preorders.createPreorder(
          {
            studentId: studentRowId,
            preorderWindowId: window.id,
            items: [{ menuItemId: TEST_MENU_ITEM_ID, quantity: 1 }],
            notes: 'PB&J please',
          } as any,
          parentActor(),
        ),
      );
      expect(order.studentId).toBe(studentRowId);

      const list = await withTestTenant(async () => preorders.listPreorders({}, adminActor()));
      expect(list.map((p) => p.id)).toContain(order.id);

      const fetched = await withTestTenant(async () =>
        preorders.getPreorderById(order.id, adminActor()),
      );
      expect(fetched.id).toBe(order.id);

      const confirmed = await withTestTenant(async () =>
        preorders.confirmPreorder(order.id, adminActor()),
      );
      expect(confirmed.status).toBe('CONFIRMED');
    });

    it('cancelPreorder flips status', async () => {
      const window = await makeWindow();
      const order = await withTestTenant(async () =>
        preorders.createPreorder(
          {
            studentId: studentRowId,
            preorderWindowId: window.id,
            items: [{ menuItemId: TEST_MENU_ITEM_ID, quantity: 1 }],
          } as any,
          parentActor(),
        ),
      );
      const cancelled = await withTestTenant(async () =>
        preorders.cancelPreorder(order.id, { reason: 'Parent withdrew' } as any, parentActor()),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('listPreorders filter by studentId + windowId', async () => {
      const window = await makeWindow();
      await withTestTenant(async () =>
        preorders.createPreorder(
          {
            studentId: studentRowId,
            preorderWindowId: window.id,
            items: [{ menuItemId: TEST_MENU_ITEM_ID, quantity: 1 }],
          } as any,
          parentActor(),
        ),
      );
      const byWindow = await withTestTenant(async () =>
        preorders.listPreorders({ windowId: window.id }, adminActor()),
      );
      expect(byWindow.length).toBeGreaterThan(0);
    });

    it('generateProductionReport + getProductionReport + listProductionReports', async () => {
      const window = await makeWindow();
      const todayDate = new Date().toISOString().slice(0, 10);
      await withTestTenant(async () =>
        preorders.createPreorder(
          {
            studentId: studentRowId,
            preorderWindowId: window.id,
            items: [{ menuItemId: TEST_MENU_ITEM_ID, quantity: 2 }],
          } as any,
          parentActor(),
        ),
      );
      const report = await withTestTenant(async () =>
        preorders.generateProductionReport(
          { serviceDate: todayDate, mealType: 'LUNCH' } as any,
          adminActor(),
        ),
      );
      expect(report.serviceDate).toContain(todayDate);

      const reread = await withTestTenant(async () =>
        preorders.getProductionReport(todayDate, 'LUNCH'),
      );
      expect(reread?.id).toBe(report.id);

      const list = await withTestTenant(async () => preorders.listProductionReports());
      expect(list.map((x) => x.id)).toContain(report.id);
    });

    it('student persona cannot submit preorder for someone else → ForbiddenException', async () => {
      const window = await makeWindow();
      const otherStudentId = '019e0cf8-aaaa-7777-8888-000000063120';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level, enrollment_status)
         SELECT $1::uuid, $2::uuid, gen_random_uuid(), '6', 'ENROLLED'
         WHERE NOT EXISTS (SELECT 1 FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid)`,
        otherStudentId,
        TEST_SCHOOL_ID,
      );
      await expect(
        withTestTenant(async () =>
          preorders.createPreorder(
            {
              studentId: otherStudentId,
              preorderWindowId: window.id,
              items: [{ menuItemId: TEST_MENU_ITEM_ID, quantity: 1 }],
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toThrow();
    });
  });
});
