import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EquipmentService } from '@modules/m66-athletics/equipment.service';
import { SafetyEquipmentService } from '@modules/m66-athletics/safety-equipment.service';
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
  teacherActor,
  studentActor,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import { seedStudent } from '../m20-sis/sis-helpers';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  TEST_ATH_PROGRAMME_A_ID,
  TEST_ATH_PROGRAMME_B_ID,
  TEST_ATH_ROSTER_A_ID,
  TEST_ATH_ROSTER_B_ID,
} from '../fixtures/athletics';

describe('integration:m66-athletics/equipment', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let equipment: EquipmentService;
  let safety: SafetyEquipmentService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    equipment = new EquipmentService(tenantPrisma, permCheck, outbox);
    safety = new SafetyEquipmentService(tenantPrisma, permCheck);
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

  async function trackedSeedStudent() {
    const s = await seedStudent(rawClient);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function createEquipment() {
    return withTestTenant(() =>
      equipment.create(
        {
          programmeId: TEST_ATH_PROGRAMME_A_ID,
          itemType: 'UNIFORM',
          itemName: 'Jersey #10',
          quantity: 30,
          condition: 'GOOD',
          unitCost: 50,
        } as any,
        adminActor(),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // EquipmentService CRUD
  // ─────────────────────────────────────────────────────────────────
  it('create + list + getById + patch', async () => {
    const e = await createEquipment();
    expect(e.itemName).toBe('Jersey #10');

    const list = await withTestTenant(() =>
      equipment.list({
        programmeId: TEST_ATH_PROGRAMME_A_ID,
        itemType: 'UNIFORM',
        condition: 'GOOD',
      }),
    );
    expect(list.map((x) => x.id)).toContain(e.id);

    const got = await withTestTenant(() => equipment.getById(e.id));
    expect(got.id).toBe(e.id);

    const patched = await withTestTenant(() =>
      equipment.patch(
        e.id,
        {
          itemType: 'PROTECTIVE_GEAR',
          itemName: 'Renamed',
          quantity: 40,
          condition: 'FAIR',
          purchaseDate: '2026-01-01',
          unitCost: 60,
        } as any,
        adminActor(),
      ),
    );
    expect(patched.itemName).toBe('Renamed');
    expect(patched.quantity).toBe(40);
  });

  it('create: bad programme → BadRequestException', async () => {
    await expect(
      withTestTenant(() =>
        equipment.create(
          {
            programmeId: '00000000-0000-0000-0000-000000000000',
            itemType: 'UNIFORM',
            itemName: 'X',
            quantity: 1,
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: student → ForbiddenException', async () => {
    await expect(
      withTestTenant(() =>
        equipment.create(
          {
            programmeId: TEST_ATH_PROGRAMME_A_ID,
            itemType: 'UNIFORM',
            itemName: 'X',
          } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getById missing → NotFoundException', async () => {
    await expect(
      withTestTenant(() => equipment.getById('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('patch: no-op + missing + student', async () => {
    const e = await createEquipment();
    const noop = await withTestTenant(() => equipment.patch(e.id, {} as any, adminActor()));
    expect(noop.id).toBe(e.id);

    await expect(
      withTestTenant(() =>
        equipment.patch(
          '00000000-0000-0000-0000-000000000000',
          { quantity: 5 } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      withTestTenant(() => equipment.patch(e.id, { quantity: 5 } as any, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Checkout + return + Kafka outbox
  // ─────────────────────────────────────────────────────────────────
  it('checkout: admin issues equipment to student', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        {
          assignedToPersonId: stu.personId,
          itemIdentifier: 'JERSEY-10',
          expectedReturnDate: '2026-12-31',
        } as any,
        adminActor(),
      ),
    );
    expect(c.equipmentId).toBe(e.id);
    expect(c.returnedAt).toBeNull();
    expect(c.isOverdue).toBe(false);

    const list = await withTestTenant(() => equipment.listCheckouts({ activeOnly: true }));
    expect(list.map((x) => x.id)).toContain(c.id);
  });

  it('checkout: assignee not in school → BadRequestException', async () => {
    const e = await createEquipment();
    await expect(
      withTestTenant(() =>
        equipment.checkout(
          e.id,
          { assignedToPersonId: '00000000-0000-0000-0000-000000000000' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checkout: student → ForbiddenException', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    await expect(
      withTestTenant(() =>
        equipment.checkout(
          e.id,
          { assignedToPersonId: stu.personId } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('checkout: staff person is also a valid assignee', async () => {
    const e = await createEquipment();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        { assignedToPersonId: TEST_ADMIN_PERSON_ID } as any,
        adminActor(),
      ),
    );
    expect(c.assignedToPersonId).toBe(TEST_ADMIN_PERSON_ID);
  });

  it('returnCheckout: GOOD return clears nothing', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        { assignedToPersonId: stu.personId } as any,
        adminActor(),
      ),
    );
    const returned = await withTestTenant(() =>
      equipment.returnCheckout(
        c.id,
        { conditionAtReturn: 'GOOD' } as any,
        adminActor(),
      ),
    );
    expect(returned.returnedAt).not.toBeNull();
    expect(returned.conditionAtReturn).toBe('GOOD');
    expect(returned.replacementCharge).toBeNull();

    // No outbox emit for non-damaged returns
    const outboxRows = (await rawClient.$queryRawUnsafe(
      `SELECT id FROM platform.platform_outbox WHERE topic = 'ath.equipment.replacement_charge' AND message_key = $1`,
      c.id,
    )) as unknown[];
    expect(outboxRows.length).toBe(0);
  });

  it('returnCheckout: DAMAGED defaults charge to unit_cost + emits outbox', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        { assignedToPersonId: stu.personId } as any,
        adminActor(),
      ),
    );
    const returned = await withTestTenant(() =>
      equipment.returnCheckout(
        c.id,
        { conditionAtReturn: 'DAMAGED', damageNotes: 'Torn' } as any,
        adminActor(),
      ),
    );
    expect(returned.conditionAtReturn).toBe('DAMAGED');
    expect(returned.replacementCharge).toBe(50);

    const outboxRows = (await rawClient.$queryRawUnsafe(
      `SELECT id FROM platform.platform_outbox WHERE topic = 'ath.equipment.replacement_charge' AND message_key = $1`,
      c.id,
    )) as unknown[];
    expect(outboxRows.length).toBe(1);
  });

  it('returnCheckout: LOST uses explicit replacementCharge override', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        { assignedToPersonId: stu.personId } as any,
        adminActor(),
      ),
    );
    const returned = await withTestTenant(() =>
      equipment.returnCheckout(
        c.id,
        { conditionAtReturn: 'LOST', replacementCharge: 0 } as any, // AD waives
        adminActor(),
      ),
    );
    expect(returned.replacementCharge).toBe(0);
  });

  it('returnCheckout: already-returned → BadRequestException', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        { assignedToPersonId: stu.personId } as any,
        adminActor(),
      ),
    );
    await withTestTenant(() =>
      equipment.returnCheckout(
        c.id,
        { conditionAtReturn: 'GOOD' } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() =>
        equipment.returnCheckout(
          c.id,
          { conditionAtReturn: 'GOOD' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returnCheckout: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        equipment.returnCheckout(
          '00000000-0000-0000-0000-000000000000',
          { conditionAtReturn: 'GOOD' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returnCheckout: student → ForbiddenException', async () => {
    await expect(
      withTestTenant(() =>
        equipment.returnCheckout(
          '00000000-0000-0000-0000-000000000000',
          { conditionAtReturn: 'GOOD' } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listOverdue + isOverdue flag', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        {
          assignedToPersonId: stu.personId,
          checkedOutAt: '2020-01-01',
          expectedReturnDate: '2020-01-02',
        } as any,
        adminActor(),
      ),
    );
    const overdue = await withTestTenant(() => equipment.listOverdue());
    expect(overdue.map((x) => x.id)).toContain(c.id);
    expect(overdue[0]!.isOverdue).toBe(true);
  });

  it('listCheckouts: filtered + getCheckoutById missing', async () => {
    const e = await createEquipment();
    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      equipment.checkout(
        e.id,
        { assignedToPersonId: stu.personId } as any,
        adminActor(),
      ),
    );
    const byEq = await withTestTenant(() =>
      equipment.listCheckouts({ equipmentId: e.id, assignedToPersonId: stu.personId }),
    );
    expect(byEq.map((x) => x.id)).toContain(c.id);
    await expect(
      withTestTenant(() => equipment.getCheckoutById('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Maintenance
  // ─────────────────────────────────────────────────────────────────
  it('addMaintenance + listMaintenance', async () => {
    const e = await createEquipment();
    const m = await withTestTenant(() =>
      equipment.addMaintenance(
        e.id,
        {
          maintenanceType: 'CLEANING',
          performedAt: '2026-06-01',
          performedBy: 'CleanCo',
          cost: 20,
          notes: 'wash',
          nextMaintenanceDate: '2026-12-01',
        } as any,
        adminActor(),
      ),
    );
    expect(m.equipmentId).toBe(e.id);
    expect(m.cost).toBe(20);

    const list = await withTestTenant(() => equipment.listMaintenance(e.id));
    expect(list.map((x) => x.id)).toContain(m.id);
  });

  it('addMaintenance: missing equipment → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        equipment.addMaintenance(
          '00000000-0000-0000-0000-000000000000',
          { maintenanceType: 'CLEANING' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('addMaintenance: student → ForbiddenException', async () => {
    const e = await createEquipment();
    await expect(
      withTestTenant(() =>
        equipment.addMaintenance(
          e.id,
          { maintenanceType: 'CLEANING' } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────
  // hasEquipmentScope
  // ─────────────────────────────────────────────────────────────────
  it('hasEquipmentScope: admin true / teacher false', async () => {
    const a = await withTestTenant(() => equipment.hasEquipmentScope(adminActor()));
    expect(a).toBe(true);
    const t = await withTestTenant(() => equipment.hasEquipmentScope(teacherActor()));
    expect(t).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────
  // Safety equipment
  // ─────────────────────────────────────────────────────────────────
  describe('SafetyEquipmentService', () => {
    async function addRosterMember() {
      // Add a roster member that safety equipment can attach to.
      const stu = await trackedSeedStudent();
      const memberRows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ${TEST_SCHEMA}.ath_roster_members (id, roster_id, student_id, joined_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, CURRENT_DATE)
         RETURNING id::text AS id`,
        TEST_ATH_ROSTER_A_ID,
        stu.studentId,
      )) as Array<{ id: string }>;
      return memberRows[0]!.id;
    }

    it('create + listForRoster + patch (compliance GREEN)', async () => {
      const memberId = await addRosterMember();
      const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
      const created = await withTestTenant(() =>
        safety.create(
          {
            rosterMemberId: memberId,
            equipmentType: 'HELMET',
            issued: true,
            meetsSafetyStandard: true,
            certificationDate: '2026-01-01',
            certificationExpiry: future,
            recallStatus: false,
          } as any,
          adminActor(),
        ),
      );
      expect(created.complianceState).toBe('GREEN');

      const list = await withTestTenant(() => safety.listForRoster(TEST_ATH_ROSTER_A_ID));
      expect(list.map((x) => x.id)).toContain(created.id);
    });

    it('compliance NEUTRAL when not issued', async () => {
      const memberId = await addRosterMember();
      const dto = await withTestTenant(() =>
        safety.create(
          {
            rosterMemberId: memberId,
            equipmentType: 'PADS',
            issued: false,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.complianceState).toBe('NEUTRAL');
    });

    it('compliance AMBER when expiring within 30d', async () => {
      const memberId = await addRosterMember();
      const soon = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
      const dto = await withTestTenant(() =>
        safety.create(
          {
            rosterMemberId: memberId,
            equipmentType: 'MOUTHGUARD',
            issued: true,
            meetsSafetyStandard: true,
            certificationExpiry: soon,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.complianceState).toBe('AMBER');
    });

    it('compliance ROSE when standard fails / recalled / expired', async () => {
      const memberId = await addRosterMember();
      const past = '2020-01-01';
      const dto = await withTestTenant(() =>
        safety.create(
          {
            rosterMemberId: memberId,
            equipmentType: 'HELMET',
            issued: true,
            meetsSafetyStandard: false,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.complianceState).toBe('ROSE');

      // listExpired surfaces expired rows
      const memberId2 = await addRosterMember();
      await withTestTenant(() =>
        safety.create(
          {
            rosterMemberId: memberId2,
            equipmentType: 'GOGGLES',
            issued: true,
            meetsSafetyStandard: true,
            certificationExpiry: past,
          } as any,
          adminActor(),
        ),
      );
      const expired = await withTestTenant(() => safety.listExpired());
      expect(expired.length).toBeGreaterThanOrEqual(1);
    });

    it('create: invalid member → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          safety.create(
            {
              rosterMemberId: '00000000-0000-0000-0000-000000000000',
              equipmentType: 'HELMET',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: duplicate → BadRequestException', async () => {
      const memberId = await addRosterMember();
      await withTestTenant(() =>
        safety.create(
          { rosterMemberId: memberId, equipmentType: 'HELMET' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          safety.create(
            { rosterMemberId: memberId, equipmentType: 'HELMET' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: student → ForbiddenException', async () => {
      const memberId = await addRosterMember();
      await expect(
        withTestTenant(() =>
          safety.create(
            { rosterMemberId: memberId, equipmentType: 'HELMET' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch + no-op + missing', async () => {
      const memberId = await addRosterMember();
      const created = await withTestTenant(() =>
        safety.create(
          { rosterMemberId: memberId, equipmentType: 'HELMET', issued: false } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(() =>
        safety.patch(
          created.id,
          {
            issued: true,
            meetsSafetyStandard: true,
            certificationDate: '2026-01-01',
            certificationExpiry: '2027-01-01',
            recallStatus: false,
            notes: 'OK',
          } as any,
          adminActor(),
        ),
      );
      expect(patched.issued).toBe(true);

      const noop = await withTestTenant(() => safety.patch(created.id, {} as any, adminActor()));
      expect(noop.id).toBe(created.id);

      await expect(
        withTestTenant(() => safety.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: student → ForbiddenException', async () => {
      const memberId = await addRosterMember();
      const created = await withTestTenant(() =>
        safety.create(
          { rosterMemberId: memberId, equipmentType: 'HELMET' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() => safety.patch(created.id, { notes: 'X' } as any, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForRoster: missing roster → NotFoundException', async () => {
      await expect(
        withTestTenant(() => safety.listForRoster('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ─────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A cannot list School B equipment', async () => {
      // Seed B equipment
      const bId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_equipment (id, school_id, programme_id, item_type, item_name, quantity, condition) VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNIFORM', 'B-Jersey', 10, 'GOOD')`,
        bId,
        TEST_SCHOOL_B_ID,
        TEST_ATH_PROGRAMME_B_ID,
      );
      const aList = await withTestTenant(() => equipment.list({}));
      expect(aList.map((e) => e.id)).not.toContain(bId);
      const bList = await withTestTenantB(() => equipment.list({}));
      expect(bList.map((e) => e.id)).toContain(bId);
    });

    it('School A cannot get School B equipment by id', async () => {
      const bId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_equipment (id, school_id, programme_id, item_type, item_name, quantity, condition) VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNIFORM', 'B-X', 10, 'GOOD')`,
        bId,
        TEST_SCHOOL_B_ID,
        TEST_ATH_PROGRAMME_B_ID,
      );
      await expect(
        withTestTenant(() => equipment.getById(bId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
