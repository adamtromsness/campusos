import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, type TenantInfo } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { EquipmentService } from './equipment.service';
import { EquipmentController } from './equipment.controller';
import { SafetyEquipmentService } from './safety-equipment.service';
import { SafetyEquipmentController } from './safety-equipment.controller';
import { ConferenceService } from './conference.service';
import { ConferenceController } from './conference.controller';
import { TeamMediaService } from './team-media.service';
import { TeamMediaController } from './team-media.controller';

/**
 * P2-8a — Athletics Advanced (Equipment + Conferences + Media) keystone unit tests.
 *
 * Each test asserts a single load-bearing invariant:
 *   1. EquipmentService AD-scope gate.
 *   2. EquipmentService.returnCheckout DAMAGED path emits
 *      ath.equipment.replacement_charge with the Cycle 6 family billing
 *      payload contract + the schema-side returned_chk lockstep.
 *   3. EquipmentService.returnCheckout LOST path emits the same Kafka
 *      envelope.
 *   4. SafetyEquipmentService UNIQUE(roster_member, equipment_type) catch.
 *   5. SafetyEquipmentService AD scope on writes.
 *   6. ConferenceService UNIQUE(name, sport) catch.
 *   7. ConferenceService.addScheduleEntry refuses same home/away school.
 *   8. TeamMediaService AD scope on writes.
 *   9. Controller @RequirePermission metadata pins:
 *      - Equipment reads/writes to ath-004.
 *      - Safety equipment reads/writes to ath-004.
 *      - Conference reads/writes to ath-003.
 *      - Team media reads to ath-001:read, writes to ath-001:write.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-000000000001',
  personId: '019e0cf8-bbb8-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0cf8-bbb8-7556-8c81-000000000099',
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emits: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: async (opts: {
      topic: string;
      sourceModule: string;
      key: string;
      payload: Record<string, unknown>;
    }) => {
      emits.push(opts);
    },
  };
  return { kafka, emits };
}

describe('EquipmentService — AD scope gate', () => {
  it('non-admin without ath-004:write is rejected with Forbidden on create', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { kafka } = makeKafka();
    const svc = new EquipmentService(
      fake.tenantPrisma as never,
      permissions as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            programmeId: '019e0cf8-bbb8-7556-8c81-c00000000001',
            itemType: 'UNIFORM',
            itemName: 'Jersey',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EquipmentService.returnCheckout — replacement charge keystone', () => {
  it('DAMAGED return emits ath.equipment.replacement_charge with full Cycle 6 contract', async () => {
    const checkoutId = '019e0e69-aaaa-7000-8000-000000000001';
    const equipmentId = '019e0e69-aaaa-7000-8000-000000000002';
    const personId = '019e0e69-aaaa-7000-8000-000000000003';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [
          {
            id: checkoutId,
            returned_at: null,
            unit_cost: '95.00',
            school_id: SCHOOL.schoolId,
            equipment_id: equipmentId,
            assigned_to_person_id: personId,
          },
        ];
      }
      if (sql.includes('select c.id') && sql.includes('from ath_equipment_checkouts c')) {
        // getCheckoutById final read
        return [
          {
            id: checkoutId,
            equipment_id: equipmentId,
            equipment_name: 'Warmup',
            assigned_to_person_id: personId,
            assigned_to_name: 'Ethan Rodriguez',
            item_identifier: 'WARMUP-11',
            checked_out_at: '2024-11-01',
            expected_return_date: '2025-03-15',
            returned_at: '2025-03-12',
            condition_at_return: 'DAMAGED',
            damage_notes: 'Torn at left shoulder',
            replacement_charge: '95.00',
            created_at: '2024-11-01T00:00:00Z',
            updated_at: '2025-03-12T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { kafka, emits } = makeKafka();
    const svc = new EquipmentService(
      fake.tenantPrisma as never,
      permissions as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.returnCheckout(
        checkoutId,
        { conditionAtReturn: 'DAMAGED', damageNotes: 'Torn at left shoulder' },
        ADMIN_ACTOR,
      ),
    );
    expect(emits.length).toBe(1);
    expect(emits[0]!.topic).toBe('ath.equipment.replacement_charge');
    expect(emits[0]!.sourceModule).toBe('athletics');
    expect(emits[0]!.payload).toMatchObject({
      checkoutId,
      equipmentId,
      assignedToPersonId: personId,
      conditionAtReturn: 'DAMAGED',
      replacementCharge: 95.0,
      schoolId: SCHOOL.schoolId,
      sourceRefId: checkoutId,
    });
    // The UPDATE SQL stamps both returned_at + condition_at_return atomically per the schema lockstep
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update ath_equipment_checkouts'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql.toLowerCase()).toContain('returned_at');
    expect(updateCall!.sql.toLowerCase()).toContain('condition_at_return');
  });

  it('LOST return defaults replacement_charge from equipment unit_cost', async () => {
    const checkoutId = '019e0e69-aaaa-7000-8000-000000000010';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [
          {
            id: checkoutId,
            returned_at: null,
            unit_cost: '120.00',
            school_id: SCHOOL.schoolId,
            equipment_id: '019e0e69-aaaa-7000-8000-000000000011',
            assigned_to_person_id: '019e0e69-aaaa-7000-8000-000000000012',
          },
        ];
      }
      if (sql.includes('from ath_equipment_checkouts c')) {
        return [
          {
            id: checkoutId,
            equipment_id: '019e0e69-aaaa-7000-8000-000000000011',
            equipment_name: 'X',
            assigned_to_person_id: '019e0e69-aaaa-7000-8000-000000000012',
            assigned_to_name: 'X',
            item_identifier: null,
            checked_out_at: '2024-11-01',
            expected_return_date: null,
            returned_at: '2025-03-12',
            condition_at_return: 'LOST',
            damage_notes: null,
            replacement_charge: '120.00',
            created_at: '2024-11-01T00:00:00Z',
            updated_at: '2025-03-12T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { kafka, emits } = makeKafka();
    const svc = new EquipmentService(
      fake.tenantPrisma as never,
      permissions as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.returnCheckout(checkoutId, { conditionAtReturn: 'LOST' }, ADMIN_ACTOR),
    );
    expect(emits.length).toBe(1);
    expect(emits[0]!.payload.replacementCharge).toBe(120.0);
  });

  it('GOOD return does NOT emit replacement_charge', async () => {
    const checkoutId = '019e0e69-aaaa-7000-8000-000000000020';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [
          {
            id: checkoutId,
            returned_at: null,
            unit_cost: '45.00',
            school_id: SCHOOL.schoolId,
            equipment_id: '019e0e69-aaaa-7000-8000-000000000021',
            assigned_to_person_id: '019e0e69-aaaa-7000-8000-000000000022',
          },
        ];
      }
      if (sql.includes('from ath_equipment_checkouts c')) {
        return [
          {
            id: checkoutId,
            equipment_id: '019e0e69-aaaa-7000-8000-000000000021',
            equipment_name: 'X',
            assigned_to_person_id: '019e0e69-aaaa-7000-8000-000000000022',
            assigned_to_name: 'X',
            item_identifier: null,
            checked_out_at: '2024-11-01',
            expected_return_date: null,
            returned_at: '2025-03-12',
            condition_at_return: 'GOOD',
            damage_notes: null,
            replacement_charge: null,
            created_at: '2024-11-01T00:00:00Z',
            updated_at: '2025-03-12T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { kafka, emits } = makeKafka();
    const svc = new EquipmentService(
      fake.tenantPrisma as never,
      permissions as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.returnCheckout(checkoutId, { conditionAtReturn: 'GOOD' }, ADMIN_ACTOR),
    );
    expect(emits.length).toBe(0);
  });

  it('refuses double-return with BadRequest', async () => {
    const checkoutId = '019e0e69-aaaa-7000-8000-000000000030';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update')) {
        return [
          {
            id: checkoutId,
            returned_at: '2025-03-01',
            unit_cost: '45.00',
            school_id: SCHOOL.schoolId,
            equipment_id: '019e0e69-aaaa-7000-8000-000000000031',
            assigned_to_person_id: '019e0e69-aaaa-7000-8000-000000000032',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { kafka } = makeKafka();
    const svc = new EquipmentService(
      fake.tenantPrisma as never,
      permissions as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.returnCheckout(checkoutId, { conditionAtReturn: 'GOOD' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SafetyEquipmentService — UNIQUE keystone + AD gate', () => {
  it('non-admin without ath-004:write is rejected with Forbidden on create', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new SafetyEquipmentService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            rosterMemberId: '019e0e69-aaaa-7000-8000-000000000040',
            equipmentType: 'HELMET',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('UNIQUE(roster_member_id, equipment_type) catches duplicate as friendly 400', async () => {
    const memberId = '019e0e69-aaaa-7000-8000-000000000050';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select m.roster_id')) {
        return [{ roster_id: 'r1' }];
      }
      if (sql.includes('insert into ath_safety_equipment')) {
        const err = new Error('UNIQUE violation');
        // Mock Prisma error shape — code 23505
        Object.assign(err, { code: '23505', meta: { code: '23505' } });
        throw err;
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new SafetyEquipmentService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ rosterMemberId: memberId, equipmentType: 'HELMET' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when rosterMemberId does not belong to a roster in this school', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select m.roster_id')) {
        return []; // Not found in this school
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new SafetyEquipmentService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            rosterMemberId: '019e0e69-aaaa-7000-8000-000000000060',
            equipmentType: 'HELMET',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ConferenceService — UNIQUE(name, sport) + scope', () => {
  it('non-admin without ath-003:write is rejected with Forbidden on create', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new ConferenceService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ name: 'Kansas 4A', sport: 'Basketball' }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('UNIQUE(name, sport) catches duplicate as friendly 400', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('insert into ath_conferences')) {
        const err = new Error('UNIQUE violation');
        Object.assign(err, { code: '23505', meta: { code: '23505' } });
        throw err;
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new ConferenceService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ name: 'Kansas 4A', sport: 'Basketball' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addScheduleEntry refuses same home/away school', async () => {
    const conferenceId = '019e0e69-aaaa-7000-8000-000000000070';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select c.id') && sql.includes('from ath_conferences c')) {
        return [
          {
            id: conferenceId,
            name: 'X',
            sport: 'Basketball',
            region: null,
            governing_body: null,
            is_active: true,
            membership_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new ConferenceService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.addScheduleEntry(
          conferenceId,
          {
            homeSchoolId: '019e0e69-aaaa-7000-8000-000000000071',
            awaySchoolId: '019e0e69-aaaa-7000-8000-000000000071',
            scheduledDate: '2026-01-15',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TeamMediaService — AD scope gate', () => {
  it('non-admin without ath-001:write is rejected with Forbidden on create photo', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const svc = new TeamMediaService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPhoto(
          {
            rosterId: '019e0e69-aaaa-7000-8000-000000000080',
            photoType: 'TEAM_PHOTO',
            s3Key: 's3://x/y',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createPhoto rejects when roster does not exist in this school', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select r.id from ath_rosters r join ath_seasons')) {
        return []; // not found
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const svc = new TeamMediaService(fake.tenantPrisma as never, permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createPhoto(
          {
            rosterId: '019e0e69-aaaa-7000-8000-000000000090',
            photoType: 'TEAM_PHOTO',
            s3Key: 's3://x/y',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Controller @RequirePermission metadata — pinned codes', () => {
  it('EquipmentController pins reads to ath-004:read and writes to ath-004:write', () => {
    const list = Reflect.getMetadata(PERMISSIONS_KEY, EquipmentController.prototype.list);
    expect(list).toEqual(['ath-004:read']);
    const overdue = Reflect.getMetadata(PERMISSIONS_KEY, EquipmentController.prototype.listOverdue);
    expect(overdue).toEqual(['ath-004:read']);
    const create = Reflect.getMetadata(PERMISSIONS_KEY, EquipmentController.prototype.create);
    expect(create).toEqual(['ath-004:write']);
    const checkout = Reflect.getMetadata(PERMISSIONS_KEY, EquipmentController.prototype.checkout);
    expect(checkout).toEqual(['ath-004:write']);
    const ret = Reflect.getMetadata(PERMISSIONS_KEY, EquipmentController.prototype.returnCheckout);
    expect(ret).toEqual(['ath-004:write']);
    const addMaint = Reflect.getMetadata(
      PERMISSIONS_KEY,
      EquipmentController.prototype.addMaintenance,
    );
    expect(addMaint).toEqual(['ath-004:write']);
  });

  it('SafetyEquipmentController pins reads to ath-004:read and writes to ath-004:write', () => {
    const list = Reflect.getMetadata(
      PERMISSIONS_KEY,
      SafetyEquipmentController.prototype.listForRoster,
    );
    expect(list).toEqual(['ath-004:read']);
    const expired = Reflect.getMetadata(
      PERMISSIONS_KEY,
      SafetyEquipmentController.prototype.listExpired,
    );
    expect(expired).toEqual(['ath-004:read']);
    const create = Reflect.getMetadata(PERMISSIONS_KEY, SafetyEquipmentController.prototype.create);
    expect(create).toEqual(['ath-004:write']);
    const patch = Reflect.getMetadata(PERMISSIONS_KEY, SafetyEquipmentController.prototype.patch);
    expect(patch).toEqual(['ath-004:write']);
  });

  it('ConferenceController pins reads to ath-003:read and writes to ath-003:write', () => {
    const list = Reflect.getMetadata(PERMISSIONS_KEY, ConferenceController.prototype.list);
    expect(list).toEqual(['ath-003:read']);
    const create = Reflect.getMetadata(PERMISSIONS_KEY, ConferenceController.prototype.create);
    expect(create).toEqual(['ath-003:write']);
    const addMembership = Reflect.getMetadata(
      PERMISSIONS_KEY,
      ConferenceController.prototype.addMembership,
    );
    expect(addMembership).toEqual(['ath-003:write']);
    const addSchedule = Reflect.getMetadata(
      PERMISSIONS_KEY,
      ConferenceController.prototype.addScheduleEntry,
    );
    expect(addSchedule).toEqual(['ath-003:write']);
  });

  it('TeamMediaController pins reads to ath-001:read and writes to ath-001:write', () => {
    const photos = Reflect.getMetadata(
      PERMISSIONS_KEY,
      TeamMediaController.prototype.listForRoster,
    );
    expect(photos).toEqual(['ath-001:read']);
    const programmes = Reflect.getMetadata(
      PERMISSIONS_KEY,
      TeamMediaController.prototype.listForProgramme,
    );
    expect(programmes).toEqual(['ath-001:read']);
    const createPhoto = Reflect.getMetadata(
      PERMISSIONS_KEY,
      TeamMediaController.prototype.createPhoto,
    );
    expect(createPhoto).toEqual(['ath-001:write']);
    const createAsset = Reflect.getMetadata(
      PERMISSIONS_KEY,
      TeamMediaController.prototype.createAsset,
    );
    expect(createAsset).toEqual(['ath-001:write']);
  });
});
