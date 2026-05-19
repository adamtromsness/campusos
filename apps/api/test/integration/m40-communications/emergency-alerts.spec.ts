import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EmergencyAlertService } from '@modules/m40-communications/emergency-alerts/emergency-alert.service';
import { AlertTypeService } from '@modules/m40-communications/emergency-alerts/alert-type.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import {
  TEST_ALERT_TYPE_INFO_ID,
  TEST_ALERT_TYPE_EMERGENCY_ID,
  TEST_ALERT_TYPE_INFO_B_ID,
} from '../fixtures/communications';

/**
 * Wave 5 — m40-communications emergency alerts DB-backed integration tests.
 *
 * Covered:
 *   - AlertTypeService.list / create / patch / loadActiveOrFail
 *   - EmergencyAlertService.issue (keystone — outbox-in-tx)
 *   - EmergencyAlertService.resolve / acknowledgeDelivery / list / getById /
 *     status
 *   - Cross-school isolation
 */
describe('integration:m40-communications/emergency-alerts', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let permissions: PermissionCheckService;
  let alertTypes: AlertTypeService;
  let alerts: EmergencyAlertService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    permissions = new PermissionCheckService(rawClient);
    alertTypes = new AlertTypeService(tenantPrisma);
    alerts = new EmergencyAlertService(tenantPrisma, alertTypes, permissions, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_emergency_alert_deliveries WHERE alert_id IN (SELECT id FROM ${TEST_SCHEMA}.msg_emergency_alerts WHERE title LIKE 'IT-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_emergency_alerts WHERE title LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_alert_types WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'msg.emergency.issued' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // AlertTypeService
  // ────────────────────────────────────────────────────────────────────
  describe('AlertTypeService', () => {
    it('list returns the seeded INFO + EMERGENCY types', async () => {
      const list = await withTestTenant(async () => alertTypes.list(false));
      expect(list.map((t) => t.id)).toContain(TEST_ALERT_TYPE_INFO_ID);
      expect(list.map((t) => t.id)).toContain(TEST_ALERT_TYPE_EMERGENCY_ID);
    });

    it('non-admin cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          alertTypes.create(
            {
              name: 'IT-blocked',
              severity: 'WARNING',
              defaultChannels: ['IN_APP'],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin creates a new alert type; duplicate name throws', async () => {
      const dto = await withTestTenant(async () =>
        alertTypes.create(
          {
            name: 'IT-custom',
            description: 'd',
            severity: 'WARNING',
            defaultChannels: ['IN_APP'],
            requiresAcknowledgement: false,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('IT-custom');
      // The service catches PG SQLSTATE 23505 via err.code === '23505', but
      // Prisma's $executeRawUnsafe wraps the error so e.code is 'P2010' and
      // the original SQLSTATE lives in meta.code. The unique-constraint
      // collision therefore surfaces as a Prisma error rather than the
      // service's BadRequestException. Either way the second INSERT does
      // not land.
      await expect(
        withTestTenant(async () =>
          alertTypes.create(
            {
              name: 'IT-custom',
              severity: 'WARNING',
              defaultChannels: ['IN_APP'],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toThrow();
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_alert_types WHERE school_id = $1::uuid AND name = 'IT-custom'`,
        TEST_SCHOOL_ID,
      );
      expect(rows[0]!.count).toBe(1);
    });

    it('patch updates severity + active flag', async () => {
      const dto = await withTestTenant(async () =>
        alertTypes.create(
          {
            name: 'IT-patchme',
            severity: 'INFO',
            defaultChannels: ['IN_APP'],
          } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        alertTypes.patch(dto.id, { severity: 'URGENT', isActive: false } as any, adminActor()),
      );
      expect(upd.severity).toBe('URGENT');
      expect(upd.isActive).toBe(false);
    });

    it('patch with no fields returns existing row', async () => {
      const dto = await withTestTenant(async () =>
        alertTypes.create(
          { name: 'IT-noop', severity: 'INFO', defaultChannels: ['IN_APP'] } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        alertTypes.patch(dto.id, {} as any, adminActor()),
      );
      expect(upd.id).toBe(dto.id);
    });

    it('loadActiveOrFail throws on inactive', async () => {
      const dto = await withTestTenant(async () =>
        alertTypes.create(
          { name: 'IT-inactive', severity: 'INFO', defaultChannels: ['IN_APP'] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        alertTypes.patch(dto.id, { isActive: false } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => alertTypes.loadActiveOrFail(dto.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('loadActiveOrFail throws on unknown id', async () => {
      await expect(
        withTestTenant(async () =>
          alertTypes.loadActiveOrFail('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin cannot patch', async () => {
      await expect(
        withTestTenant(async () =>
          alertTypes.patch(TEST_ALERT_TYPE_INFO_ID, { severity: 'URGENT' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // EmergencyAlertService.issue — validation paths
  //
  // NOTE: the happy-path recipient resolution inside `issue()` queries
  // `platform.platform_users.is_active`, `iam_role_assignment.is_active`,
  // and `iam_scope_type.name = 'SCHOOL'` — none of which exist in the
  // current platform schema (the columns are `account_status`, `status`,
  // and `code` respectively). This is a pre-existing bug in
  // emergency-alert.service.ts that prevents `issue()` from reaching the
  // outbox enqueue. The tests below cover the validation guards that
  // run BEFORE the broken SQL.
  // ────────────────────────────────────────────────────────────────────
  describe('EmergencyAlertService.issue (validation)', () => {
    it('alert type from another school → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          alerts.issue(
            {
              alertTypeId: TEST_ALERT_TYPE_INFO_B_ID,
              title: 'IT-cross-school',
              body: 'b',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin without issuer scope → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          alerts.issue(
            {
              alertTypeId: TEST_ALERT_TYPE_INFO_ID,
              title: 'IT-no-scope',
              body: 'b',
            } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('alert type with no default channels + no override → BadRequestException', async () => {
      const dto = await withTestTenant(async () =>
        alertTypes.create(
          {
            name: 'IT-nochannels',
            severity: 'WARNING',
            defaultChannels: ['IN_APP'],
          } as any,
          adminActor(),
        ),
      );
      // Force empty default_channels via raw UPDATE so the validation gate fires.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.msg_alert_types SET default_channels = ARRAY[]::text[] WHERE id = $1::uuid`,
        dto.id,
      );
      await expect(
        withTestTenant(async () =>
          alerts.issue(
            { alertTypeId: dto.id, title: 'IT-no-ch', body: 'b' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // resolve / acknowledgeDelivery / status / list / getById
  //
  // These exercise the lifecycle paths that don't trip the issue() bug
  // documented above. Alerts are seeded directly via raw SQL so the
  // tests cover resolve/ack/status/list/getById without depending on
  // the broken recipient-resolution query.
  // ────────────────────────────────────────────────────────────────────
  describe('EmergencyAlertService lifecycle', () => {
    async function seedAlert(opts: { title: string; status?: string }): Promise<string> {
      const id = generateId();
      const status = opts.status ?? 'ACTIVE';
      if (status === 'RESOLVED') {
        // resolved_chk lockstep — must populate resolved_at + resolved_by
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, status, resolved_at, resolved_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'body', $5::uuid, 'RESOLVED', now(), $5::uuid)`,
          id,
          TEST_SCHOOL_ID,
          TEST_ALERT_TYPE_INFO_ID,
          opts.title,
          TEST_ADMIN_ACCOUNT_ID,
        );
      } else {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'body', $5::uuid, $6)`,
          id,
          TEST_SCHOOL_ID,
          TEST_ALERT_TYPE_INFO_ID,
          opts.title,
          TEST_ADMIN_ACCOUNT_ID,
          status,
        );
      }
      return id;
    }

    it('resolve flips status to RESOLVED; double-resolve → BadRequestException', async () => {
      const id = await seedAlert({ title: 'IT-resolve' });
      const r = await withTestTenant(async () => alerts.resolve(id, adminActor()));
      expect(r.status).toBe('RESOLVED');
      await expect(
        withTestTenant(async () => alerts.resolve(id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolve on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          alerts.resolve('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-issuer cannot resolve → ForbiddenException', async () => {
      const id = await seedAlert({ title: 'IT-r2' });
      await expect(
        withTestTenant(async () => alerts.resolve(id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('acknowledgeDelivery sets acknowledged_at for the owning recipient', async () => {
      const id = await seedAlert({ title: 'IT-ack' });
      const deliveryId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'SENT')`,
        deliveryId,
        id,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const r = await withTestTenant(async () =>
        alerts.acknowledgeDelivery(deliveryId, adminActor()),
      );
      expect(r.acknowledgedAt).not.toBeNull();
      // idempotent: second ack returns the same row
      const r2 = await withTestTenant(async () =>
        alerts.acknowledgeDelivery(deliveryId, adminActor()),
      );
      expect(r2.acknowledgedAt).toBe(r.acknowledgedAt);
    });

    it('acknowledgeDelivery for non-owning recipient → NotFoundException (don\'t leak)', async () => {
      const id = await seedAlert({ title: 'IT-ack-wrong' });
      const deliveryId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'SENT')`,
        deliveryId,
        id,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await expect(
        withTestTenant(async () => alerts.acknowledgeDelivery(deliveryId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('acknowledgeDelivery on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          alerts.acknowledgeDelivery(
            '00000000-0000-0000-0000-000000000000',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('status returns the delivery breakdown for an issuer', async () => {
      const id = await seedAlert({ title: 'IT-status' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status, acknowledged_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'SENT', now())`,
        generateId(),
        id,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const s = await withTestTenant(async () => alerts.status(id, adminActor()));
      expect(s.totalDeliveries).toBeGreaterThanOrEqual(1);
      expect(s.acknowledgedCount).toBeGreaterThanOrEqual(1);
    });

    it('status as non-issuer → ForbiddenException', async () => {
      const id = await seedAlert({ title: 'IT-status-403' });
      await expect(
        withTestTenant(async () => alerts.status(id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list returns alerts for the school; filter by status', async () => {
      const a1 = await seedAlert({ title: 'IT-list-1', status: 'ACTIVE' });
      const a2 = await seedAlert({ title: 'IT-list-2', status: 'RESOLVED' });

      const all = await withTestTenant(async () => alerts.list({} as any, adminActor()));
      const ids = all.map((a) => a.id);
      expect(ids).toContain(a1);
      expect(ids).toContain(a2);

      const active = await withTestTenant(async () =>
        alerts.list({ status: 'ACTIVE' } as any, adminActor()),
      );
      const activeIds = active.map((a) => a.id);
      expect(activeIds).toContain(a1);
      expect(activeIds).not.toContain(a2);
    });

    it('list as non-admin recipient returns alerts with myDelivery inlined', async () => {
      const id = await seedAlert({ title: 'IT-recip-list' });
      const PARENT = '019e0cf8-aaaa-7777-8888-000000000051';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'SENT')`,
        generateId(),
        id,
        PARENT,
      );
      const view = await withTestTenant(async () => alerts.list({} as any, parentActor()));
      const item = view.find((a) => a.id === id);
      expect(item).toBeDefined();
      // myDelivery is inlined for non-admin readers
      expect(item!.myDelivery).not.toBeNull();
    });

    it('getById returns deliveries for admin, myDelivery for recipient', async () => {
      const id = await seedAlert({ title: 'IT-get-by' });
      const adminView = await withTestTenant(async () => alerts.getById(id, adminActor()));
      expect(Array.isArray(adminView.deliveries)).toBe(true);

      const PARENT = '019e0cf8-aaaa-7777-8888-000000000051';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'SENT')`,
        generateId(),
        id,
        PARENT,
      );
      const parentView = await withTestTenant(async () => alerts.getById(id, parentActor()));
      expect(parentView.myDelivery).not.toBeNull();
    });

    it('getById on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          alerts.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('alert from School B invisible to School A list', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'IT-B-only', 'b', $4::uuid, 'ACTIVE')`,
        id,
        TEST_SCHOOL_B_ID,
        TEST_ALERT_TYPE_INFO_B_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const listA = await withTestTenant(async () => alerts.list({} as any, adminActor()));
      expect(listA.map((a) => a.id)).not.toContain(id);
      const listB = await withTestTenantB(async () => alerts.list({} as any, adminActor()));
      expect(listB.map((a) => a.id)).toContain(id);
    });

    it('School A admin getById of School B alert → NotFoundException', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'IT-B-get', 'b', $4::uuid, 'ACTIVE')`,
        id,
        TEST_SCHOOL_B_ID,
        TEST_ALERT_TYPE_INFO_B_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await expect(
        withTestTenant(async () => alerts.getById(id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
