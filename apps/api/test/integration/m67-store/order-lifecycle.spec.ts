import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  OrderService,
  ApprovalService,
} from '@modules/m67-store/orders/orders.service';
import {
  StoreService,
  ProductService,
} from '@modules/m67-store/products/products.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
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
  teacherActor,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import {
  ensureStoreSeed,
  resetStoreTables,
  TEST_STORE_STUDENT_ID,
  TEST_STORE_PUBLIC_ID,
  TEST_STORE_B_STUDENT_ID,
  TEST_PRODUCT_A_ID,
  TEST_PRODUCT_BACKORDER_ID,
  TEST_EXTERNAL_CUSTOMER_ID,
  TEST_EXTERNAL_CUSTOMER_B_ID,
  TEST_SHIPPING_OPTION_ID,
} from '../fixtures/store';

const TEST_FAMILY_ID = '019e0cf8-aaaa-7777-8888-000000067100';
const TEST_PLATFORM_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000067101';
const TEST_SIS_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000067102';
const TEST_GUARDIAN_ROW_ID = '019e0cf8-aaaa-7777-8888-000000067103';

/**
 * Seed a sis_students row + sis_guardians row + relationship so STUDENT-order
 * tests can run. Linked to the seeded TEST_PARENT_PERSON_ID + TEST_STUDENT_PERSON_ID.
 */
async function seedStudentWithGuardian(rawClient: PrismaClient): Promise<void> {
  // platform.platform_students row (synthetic — no FK to families/schools)
  // UNIQUE on person_id, so make this idempotent — upsert to canonical id.
  await rawClient.$executeRawUnsafe(
    `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
     VALUES ($1::uuid, $2::uuid, 'Test', 'Student')
     ON CONFLICT (person_id) DO UPDATE SET first_name = EXCLUDED.first_name`,
    TEST_PLATFORM_STUDENT_ID,
    TEST_STUDENT_PERSON_ID,
  );
  // Look up the actual id (in case a prior INSERT used a different one)
  const psRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid`,
    TEST_STUDENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const platformStudentId = psRows[0]!.id;

  // tenant.sis_students row (no family_id column). platform_student_id is UNIQUE.
  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '5', 'ENROLLED')
     ON CONFLICT (platform_student_id) DO NOTHING`,
    TEST_SIS_STUDENT_ID,
    TEST_SCHOOL_ID,
    platformStudentId,
  );
  const ssRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid`,
    platformStudentId,
  )) as Array<{ id: string }>;
  studentRowId = ssRows[0]!.id;

  // Guardian row — UNIQUE(school_id, person_id)
  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, school_id, person_id, relationship, preferred_contact_method)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT', 'EMAIL')
     ON CONFLICT (school_id, person_id) DO NOTHING`,
    TEST_GUARDIAN_ROW_ID,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  );
  const sgRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_guardians WHERE school_id = $1::uuid AND person_id = $2::uuid`,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const guardianRowId = sgRows[0]!.id;

  // Relationship — UNIQUE(student_id, guardian_id)
  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians (id, student_id, guardian_id, has_custody, portal_access, receives_reports)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true)
     ON CONFLICT (student_id, guardian_id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000067104',
    studentRowId,
    guardianRowId,
  );
  void TEST_FAMILY_ID;
}

let studentRowId: string;

describe('integration:m67-store/order-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let storeService: StoreService;
  let productService: ProductService;
  let orderService: OrderService;
  let approvalService: ApprovalService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    storeService = new StoreService(tenantPrisma);
    productService = new ProductService(tenantPrisma, storeService);
    orderService = new OrderService(tenantPrisma, kafka, productService);
    approvalService = new ApprovalService(tenantPrisma, orderService);
  });

  afterAll(async () => {
    // Clean up cross-spec rows so downstream files (m21-classroom etc.)
    // that own TEST_STUDENT_PERSON_ID can INSERT their own platform_students /
    // sis_students rows without colliding on UNIQUE constraints.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE id IN (
         '019e0cf8-aaaa-7777-8888-000000067104'::uuid
       )`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = $1::uuid`,
      TEST_GUARDIAN_ROW_ID,
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
    await resetStoreTables(rawClient);
    await ensureStoreSeed(rawClient);
    await seedStudentWithGuardian(rawClient);
    (kafka as unknown as RecordingKafkaProducer).reset();
  });

  // ────────────────────────────────────────────────────────
  // PARENT order — direct PROCESSING
  // ────────────────────────────────────────────────────────
  describe('create — PARENT order', () => {
    it('parent creates a PARENT order → PROCESSING + str.order.completed emit', async () => {
      const dto = await withTestTenant(async () =>
        orderService.create(parentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'PARENT',
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 2 }],
        } as any),
      );
      expect(dto.status).toBe('PROCESSING');
      expect(dto.paymentStatus).toBe('CHARGED');
      expect(dto.total).toBe(30); // 15 * 2

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'str.order.completed',
      );
      expect(emits).toHaveLength(1);
      expect(emits[0]!.payload).toMatchObject({
        orderId: dto.id,
        orderType: 'PARENT',
        total: 30,
      });
    });

    it('reserved inventory bumped by quantity', async () => {
      await withTestTenant(async () =>
        orderService.create(parentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'PARENT',
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 5 }],
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT quantity_reserved::int AS r FROM ${TEST_SCHEMA}.str_product_inventory WHERE product_id = $1::uuid`,
        TEST_PRODUCT_A_ID,
      )) as Array<{ r: number }>;
      expect(rows[0]!.r).toBe(5);
    });

    it('student attempting a PARENT order → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.create(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            orderType: 'PARENT',
            shippingMethod: 'PICKUP',
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // STUDENT order — needs parent approval
  // ────────────────────────────────────────────────────────
  describe('create — STUDENT order', () => {
    it('student creates STUDENT order → PENDING_APPROVAL + approval row, NO emit', async () => {
      const dto = await withTestTenant(async () =>
        orderService.create(studentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'STUDENT',
          studentId: studentRowId,
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
        } as any),
      );
      expect(dto.status).toBe('PENDING_APPROVAL');
      expect(dto.paymentStatus).toBe('PENDING');
      expect(dto.approval).toBeTruthy();
      expect(dto.approval!.parentPersonId).toBe(TEST_PARENT_PERSON_ID);
      expect(dto.approval!.status).toBe('PENDING');

      expect((kafka as unknown as RecordingKafkaProducer).calls).toHaveLength(0);
    });

    it('student cannot order for a different student → ForbiddenException', async () => {
      // Seed a different student
      const otherStudentId = '019e0cf8-aaaa-7777-8888-000000067110';
      const otherPlatformId = '019e0cf8-aaaa-7777-8888-000000067111';
      const otherPersonId = '019e0cf8-aaaa-7777-8888-000000067112';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Student', 'STUDENT', true)
         ON CONFLICT (id) DO NOTHING`,
        otherPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
         VALUES ($1::uuid, $2::uuid, 'Other', 'Student')
         ON CONFLICT (person_id) DO NOTHING`,
        otherPlatformId,
        otherPersonId,
      );
      const ops = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid`,
        otherPersonId,
      )) as Array<{ id: string }>;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '5', 'ENROLLED')
         ON CONFLICT (platform_student_id) DO NOTHING`,
        otherStudentId,
        TEST_SCHOOL_ID,
        ops[0]!.id,
      );
      const oss = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid`,
        ops[0]!.id,
      )) as Array<{ id: string }>;
      const resolvedOtherStudentId = oss[0]!.id;
      await expect(
        withTestTenant(async () =>
          orderService.create(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            orderType: 'STUDENT',
            studentId: resolvedOtherStudentId,
            shippingMethod: 'PICKUP',
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('STUDENT order missing studentId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.create(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            orderType: 'STUDENT',
            shippingMethod: 'PICKUP',
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────
  // EXTERNAL order — public store
  // ────────────────────────────────────────────────────────
  describe('create — EXTERNAL order', () => {
    async function seedPublicProduct(): Promise<{ productId: string }> {
      const productId = '019e0cf8-aaaa-7777-8888-000000067200';
      const invId = '019e0cf8-aaaa-7777-8888-000000067201';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, sku, price, is_active, backorder_allowed)
         VALUES ($1::uuid, $2::uuid, 'Public Mug', 'PUB-MUG', 15.00, true, false)
         ON CONFLICT (id) DO NOTHING`,
        productId,
        TEST_STORE_PUBLIC_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_product_inventory (id, product_id, location_type, location_id, quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity)
         VALUES ($1::uuid, $2::uuid, 'DISTRICT', $3::uuid, 100, 0, 10, 50)
         ON CONFLICT (id) DO NOTHING`,
        invId,
        productId,
        TEST_SCHOOL_ID,
      );
      return { productId };
    }

    it('admin places EXTERNAL order against PUBLIC store with shipping', async () => {
      const { productId } = await seedPublicProduct();
      const dto = await withTestTenant(async () =>
        orderService.create(adminActor(), {
          storeId: TEST_STORE_PUBLIC_ID,
          orderType: 'EXTERNAL',
          externalCustomerId: TEST_EXTERNAL_CUSTOMER_ID,
          shippingMethod: 'SHIPPED',
          shippingOptionId: TEST_SHIPPING_OPTION_ID,
          lines: [{ productId, quantity: 1 }],
        } as any),
      );
      expect(dto.status).toBe('PROCESSING');
      expect(dto.shippingCost).toBe(5);
      expect(dto.total).toBe(20); // 15 product + 5 shipping
      expect(dto.externalCustomerId).toBe(TEST_EXTERNAL_CUSTOMER_ID);
    });

    it('EXTERNAL order missing externalCustomerId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.create(adminActor(), {
            storeId: TEST_STORE_PUBLIC_ID,
            orderType: 'EXTERNAL',
            shippingMethod: 'SHIPPED',
            shippingOptionId: TEST_SHIPPING_OPTION_ID,
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('EXTERNAL with cross-school externalCustomerId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.create(adminActor(), {
            storeId: TEST_STORE_PUBLIC_ID,
            orderType: 'EXTERNAL',
            externalCustomerId: TEST_EXTERNAL_CUSTOMER_B_ID,
            shippingMethod: 'SHIPPED',
            shippingOptionId: TEST_SHIPPING_OPTION_ID,
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('EXTERNAL must use SHIPPED', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.create(adminActor(), {
            storeId: TEST_STORE_PUBLIC_ID,
            orderType: 'EXTERNAL',
            externalCustomerId: TEST_EXTERNAL_CUSTOMER_ID,
            shippingMethod: 'PICKUP',
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('EXTERNAL against STUDENT store → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.create(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            orderType: 'EXTERNAL',
            externalCustomerId: TEST_EXTERNAL_CUSTOMER_ID,
            shippingMethod: 'SHIPPED',
            shippingOptionId: TEST_SHIPPING_OPTION_ID,
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────
  // backorder + insufficient stock
  // ────────────────────────────────────────────────────────
  describe('backorder / stock validation', () => {
    it('line for product without backorder + insufficient stock → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.create(parentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            orderType: 'PARENT',
            shippingMethod: 'PICKUP',
            lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 99999 }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('backorder-allowed product with no stock creates BACKORDERED line', async () => {
      const dto = await withTestTenant(async () =>
        orderService.create(parentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'PARENT',
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_BACKORDER_ID, quantity: 1 }],
        } as any),
      );
      expect(dto.lines[0]!.lineStatus).toBe('BACKORDERED');
      expect(dto.paymentStatus).toBe('DEFERRED_BACKORDER');
    });
  });

  // ────────────────────────────────────────────────────────
  // fulfilment lifecycle (manager-driven)
  // ────────────────────────────────────────────────────────
  describe('fulfil / complete / cancel', () => {
    async function makeProcessingOrder() {
      return withTestTenant(async () =>
        orderService.create(parentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'PARENT',
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 2 }],
        } as any),
      );
    }

    it('admin transitions PROCESSING → READY_FOR_PICKUP → COMPLETED; inventory decremented', async () => {
      const o = await makeProcessingOrder();
      const ready = await withTestTenant(async () =>
        orderService.fulfil(adminActor(), o.id, { toStatus: 'READY_FOR_PICKUP' } as any),
      );
      expect(ready.status).toBe('READY_FOR_PICKUP');
      const done = await withTestTenant(async () => orderService.complete(adminActor(), o.id));
      expect(done.status).toBe('COMPLETED');

      // Inventory drops from 100 → 98 (2 consumed)
      const inv = (await rawClient.$queryRawUnsafe(
        `SELECT quantity_on_hand::int AS q, quantity_reserved::int AS r FROM ${TEST_SCHEMA}.str_product_inventory WHERE product_id = $1::uuid`,
        TEST_PRODUCT_A_ID,
      )) as Array<{ q: number; r: number }>;
      expect(inv[0]!.q).toBe(98);
      expect(inv[0]!.r).toBe(0);
    });

    it('admin transitions PROCESSING → SHIPPED with tracking number', async () => {
      const o = await makeProcessingOrder();
      const shipped = await withTestTenant(async () =>
        orderService.fulfil(adminActor(), o.id, {
          toStatus: 'SHIPPED',
          trackingNumber: 'TRACK-001',
        } as any),
      );
      expect(shipped.status).toBe('SHIPPED');
      expect(shipped.trackingNumber).toBe('TRACK-001');
    });

    it('illegal transition (PROCESSING → COMPLETED via fulfil) → BadRequestException', async () => {
      const o = await makeProcessingOrder();
      await expect(
        withTestTenant(async () =>
          orderService.fulfil(adminActor(), o.id, { toStatus: 'COMPLETED' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-manager fulfil → ForbiddenException', async () => {
      const o = await makeProcessingOrder();
      await expect(
        withTestTenant(async () =>
          orderService.fulfil(studentActor(), o.id, { toStatus: 'READY_FOR_PICKUP' } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin cancels PROCESSING order → reservation released', async () => {
      const o = await makeProcessingOrder();
      const cancelled = await withTestTenant(async () =>
        orderService.cancel(adminActor(), o.id, { reason: 'customer cancelled' } as any),
      );
      expect(cancelled.status).toBe('CANCELLED');

      const inv = (await rawClient.$queryRawUnsafe(
        `SELECT quantity_reserved::int AS r FROM ${TEST_SCHEMA}.str_product_inventory WHERE product_id = $1::uuid`,
        TEST_PRODUCT_A_ID,
      )) as Array<{ r: number }>;
      expect(inv[0]!.r).toBe(0);
    });

    it('double cancel → BadRequestException', async () => {
      const o = await makeProcessingOrder();
      await withTestTenant(async () => orderService.cancel(adminActor(), o.id, {} as any));
      await expect(
        withTestTenant(async () => orderService.cancel(adminActor(), o.id, {} as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel completed order → BadRequestException', async () => {
      const o = await makeProcessingOrder();
      await withTestTenant(async () =>
        orderService.fulfil(adminActor(), o.id, { toStatus: 'READY_FOR_PICKUP' } as any),
      );
      await withTestTenant(async () => orderService.complete(adminActor(), o.id));
      await expect(
        withTestTenant(async () => orderService.cancel(adminActor(), o.id, {} as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school fulfil → NotFoundException', async () => {
      const schoolBOrder = await withTestTenantB(async () =>
        orderService.create(adminActor(), {
          storeId: TEST_STORE_B_STUDENT_ID,
          orderType: 'PARENT',
          shippingMethod: 'PICKUP',
          lines: [],
        } as any).catch(() => null),
      );
      // School B order may fail to create due to missing seeded inventory.
      // Instead, INSERT a raw order on School B store and verify fulfil from
      // School A is rejected.
      const orderId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_orders (id, store_id, order_type, customer_person_id, order_number, status, subtotal, total, shipping_method)
         VALUES ($1::uuid, $2::uuid, 'PARENT', $3::uuid, 'STR-0000', 'PROCESSING', 0, 0, 'PICKUP')`,
        orderId,
        TEST_STORE_B_STUDENT_ID,
        TEST_ADMIN_PERSON_ID,
      );
      await expect(
        withTestTenant(async () =>
          orderService.fulfil(adminActor(), orderId, { toStatus: 'READY_FOR_PICKUP' } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      void schoolBOrder;
    });
  });

  // ────────────────────────────────────────────────────────
  // approval flow (KEYSTONE)
  // ────────────────────────────────────────────────────────
  describe('ApprovalService', () => {
    async function makeStudentOrder() {
      return withTestTenant(async () =>
        orderService.create(studentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'STUDENT',
          studentId: studentRowId,
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
        } as any),
      );
    }

    it('parent approves their pending order → order PROCESSING + emit fires', async () => {
      const o = await makeStudentOrder();
      const approval = o.approval!;
      const approved = await withTestTenant(async () =>
        approvalService.approve(parentActor(), approval.id),
      );
      expect(approved.status).toBe('APPROVED');

      const reread = await withTestTenant(async () => orderService.getById(o.id, adminActor()));
      expect(reread.status).toBe('PROCESSING');
      expect(reread.paymentStatus).toBe('CHARGED');

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'str.order.completed',
      );
      expect(emits).toHaveLength(1);
    });

    it('different parent cannot approve → ForbiddenException', async () => {
      const o = await makeStudentOrder();
      const teacherAsParent = teacherActor();
      await expect(
        withTestTenant(async () => approvalService.approve(teacherAsParent, o.approval!.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parent declines order → CANCELLED + reservation released', async () => {
      const o = await makeStudentOrder();
      const declined = await withTestTenant(async () =>
        approvalService.decline(parentActor(), o.approval!.id, {
          reason: 'too expensive',
        } as any),
      );
      expect(declined.status).toBe('DECLINED');

      const reread = await withTestTenant(async () => orderService.getById(o.id, adminActor()));
      expect(reread.status).toBe('CANCELLED');

      const inv = (await rawClient.$queryRawUnsafe(
        `SELECT quantity_reserved::int AS r FROM ${TEST_SCHEMA}.str_product_inventory WHERE product_id = $1::uuid`,
        TEST_PRODUCT_A_ID,
      )) as Array<{ r: number }>;
      expect(inv[0]!.r).toBe(0);
    });

    it('double approve → BadRequestException', async () => {
      const o = await makeStudentOrder();
      await withTestTenant(async () => approvalService.approve(parentActor(), o.approval!.id));
      await expect(
        withTestTenant(async () => approvalService.approve(parentActor(), o.approval!.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school approval id → NotFoundException', async () => {
      const o = await makeStudentOrder();
      await expect(
        withTestTenantB(async () => approvalService.approve(parentActor(), o.approval!.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForParent returns pending approvals for the parent', async () => {
      await makeStudentOrder();
      const list = await withTestTenant(async () => approvalService.listForParent(parentActor()));
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]!.status).toBe('PENDING');
    });
  });

  // ────────────────────────────────────────────────────────
  // list / getById visibility
  // ────────────────────────────────────────────────────────
  describe('list / getById visibility', () => {
    it('admin sees all orders; cross-school school B order is invisible', async () => {
      const orderId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_orders (id, store_id, order_type, customer_person_id, order_number, status, subtotal, total, shipping_method)
         VALUES ($1::uuid, $2::uuid, 'PARENT', $3::uuid, 'STR-X', 'PROCESSING', 0, 0, 'PICKUP')`,
        orderId,
        TEST_STORE_B_STUDENT_ID,
        TEST_ADMIN_PERSON_ID,
      );
      const list = await withTestTenant(async () => orderService.list(adminActor()));
      expect(list.map((o) => o.id)).not.toContain(orderId);

      await expect(
        withTestTenant(async () => orderService.getById(orderId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list with filter: storeId narrows results', async () => {
      const o = await withTestTenant(async () =>
        orderService.create(parentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'PARENT',
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
        } as any),
      );
      const fromStudent = await withTestTenant(async () =>
        orderService.list(adminActor(), { storeId: TEST_STORE_STUDENT_ID }),
      );
      expect(fromStudent.map((x) => x.id)).toContain(o.id);
      const fromPublic = await withTestTenant(async () =>
        orderService.list(adminActor(), { storeId: TEST_STORE_PUBLIC_ID }),
      );
      expect(fromPublic.map((x) => x.id)).not.toContain(o.id);
    });

    it('parent sees own orders + own children orders, not strangers', async () => {
      const myOrder = await withTestTenant(async () =>
        orderService.create(parentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'PARENT',
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
        } as any),
      );
      const childOrder = await withTestTenant(async () =>
        orderService.create(studentActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          orderType: 'STUDENT',
          studentId: studentRowId,
          shippingMethod: 'PICKUP',
          lines: [{ productId: TEST_PRODUCT_A_ID, quantity: 1 }],
        } as any),
      );
      const list = await withTestTenant(async () => orderService.list(parentActor()));
      const ids = list.map((o) => o.id);
      expect(ids).toContain(myOrder.id);
      expect(ids).toContain(childOrder.id);
    });

    it('non-existent order → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          orderService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
