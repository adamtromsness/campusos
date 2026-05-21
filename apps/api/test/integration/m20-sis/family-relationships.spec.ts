import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FamilyRelationshipService } from '@modules/m20-sis/family/family-relationship.service';
import { FamilyService } from '@modules/m20-sis/family/family.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor } from '../helpers/actor';
import { seedGuardian, seedStudent, linkStudentGuardian, cleanupSeededIds } from './sis-helpers';
import { TEST_SIS_FAMILY_ID, TEST_SIS_FAMILY_B_ID } from '../fixtures/sis';

/**
 * Wave 4 — m20-sis FamilyRelationshipService & FamilyService DB-backed integration.
 *
 * Contracts:
 *   - Admin-only create / patch / delete via stu-002:admin or isSchoolAdmin
 *   - Both guardians must live in the calling school (P2-H1 defence-in-depth)
 *   - Self-link rejection (CHECK constraint surfaces as BadRequest)
 *   - UNIQUE(family_id, guardian_a_id, guardian_b_id) collision → 409
 *   - Custody / relationship type enum validation
 *   - Cross-school: a School A admin cannot read or mutate School B's
 *     family_relationships (sis_guardians.school_id JOIN gate)
 *   - FamilyService.getStudentGuardians returns linked guardians with
 *     per-link booleans
 */
describe('integration:m20-sis/family-relationships', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: FamilyRelationshipService;
  let familyService: FamilyService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new FamilyRelationshipService(tenantPrisma, permCheck);
    familyService = new FamilyService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedGuardian(opts: Parameters<typeof seedGuardian>[1] = {}) {
    const g = await seedGuardian(rawClient, opts);
    guardianIds.push(g.guardianId);
    personIds.push(g.personId);
    accountIds.push(g.accountId);
    return g;
  }

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  describe('create', () => {
    it('admin can create a family relationship', async () => {
      const ga = await trackedGuardian({
        familyId: TEST_SIS_FAMILY_ID,
        firstName: 'Fam',
        lastName: 'A',
      });
      const gb = await trackedGuardian({
        familyId: TEST_SIS_FAMILY_ID,
        firstName: 'Fam',
        lastName: 'B',
      });

      const rel = await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'MARRIED',
            custodyArrangement: 'JOINT',
            notes: 'Test',
          } as any,
          adminActor(),
        ),
      );
      expect(rel.familyId).toBe(TEST_SIS_FAMILY_ID);
      expect(rel.relationshipType).toBe('MARRIED');
      expect(rel.custodyArrangement).toBe('JOINT');
    });

    it('non-admin → ForbiddenException', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              familyId: TEST_SIS_FAMILY_ID,
              guardianAId: ga.guardianId,
              guardianBId: gb.guardianId,
              relationshipType: 'MARRIED',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('self-link (guardian_a == guardian_b) → BadRequestException', async () => {
      const g = await trackedGuardian();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              familyId: TEST_SIS_FAMILY_ID,
              guardianAId: g.guardianId,
              guardianBId: g.guardianId,
              relationshipType: 'MARRIED',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid relationship type → BadRequestException', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              familyId: TEST_SIS_FAMILY_ID,
              guardianAId: ga.guardianId,
              guardianBId: gb.guardianId,
              relationshipType: 'INVALID_REL_TYPE',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid custody → BadRequestException', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              familyId: TEST_SIS_FAMILY_ID,
              guardianAId: ga.guardianId,
              guardianBId: gb.guardianId,
              relationshipType: 'MARRIED',
              custodyArrangement: 'NOT_VALID',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school guardian → BadRequestException (P2-H1)', async () => {
      const localG = await trackedGuardian();
      const otherG = await trackedGuardian({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              familyId: TEST_SIS_FAMILY_ID,
              guardianAId: localG.guardianId,
              guardianBId: otherG.guardianId,
              relationshipType: 'MARRIED',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate relationship between two guardians → ConflictException', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'MARRIED',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              familyId: TEST_SIS_FAMILY_ID,
              guardianAId: ga.guardianId,
              guardianBId: gb.guardianId,
              relationshipType: 'DIVORCED',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('read', () => {
    it('listForFamily returns relationships in the calling school only', async () => {
      const ga = await trackedGuardian({ firstName: 'L1', lastName: 'F' });
      const gb = await trackedGuardian({ firstName: 'L2', lastName: 'F' });
      const rel = await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'COHABITING',
          } as any,
          adminActor(),
        ),
      );

      const list = await withTestTenant(async () => service.listForFamily(TEST_SIS_FAMILY_ID));
      expect(list.map((r) => r.id)).toContain(rel.id);
    });

    it('getByIdOrFail: cross-school relationship id → NotFoundException', async () => {
      // Seed two School B guardians + a relationship between them
      const ga = await trackedGuardian({ schoolId: TEST_SCHOOL_B_ID });
      const gb = await trackedGuardian({ schoolId: TEST_SCHOOL_B_ID });
      const relId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_family_relationships
           (id, family_id, guardian_a_id, guardian_b_id, relationship_type)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MARRIED')`,
        relId,
        TEST_SIS_FAMILY_B_ID,
        ga.guardianId,
        gb.guardianId,
      );

      // School A admin probes School B's relationship id → 404
      await expect(withTestTenant(async () => service.getByIdOrFail(relId))).rejects.toBeInstanceOf(
        NotFoundException,
      );

      // School B context — visible
      const found = await withTestTenantB(async () => service.getByIdOrFail(relId));
      expect(found.id).toBe(relId);
    });
  });

  describe('patch', () => {
    it('admin can update notes + custody', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      const rel = await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'MARRIED',
          } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        service.patch(
          rel.id,
          { custodyArrangement: 'SOLE_A', notes: 'Updated' } as any,
          adminActor(),
        ),
      );
      expect(patched.custodyArrangement).toBe('SOLE_A');
      expect(patched.notes).toBe('Updated');
    });

    it('patch on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.patch(
            '00000000-0000-0000-0000-000000000000',
            { custodyArrangement: 'JOINT' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin patch → ForbiddenException', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      const rel = await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'MARRIED',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.patch(rel.id, { notes: 'attempt' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('invalid relationship_type → BadRequestException', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      const rel = await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'MARRIED',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.patch(rel.id, { relationshipType: 'NOPE' as any }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('delete', () => {
    it('admin can delete an existing relationship', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      const rel = await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'MARRIED',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.delete(rel.id, adminActor()));
      await expect(
        withTestTenant(async () => service.getByIdOrFail(rel.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin delete → ForbiddenException', async () => {
      const ga = await trackedGuardian();
      const gb = await trackedGuardian();
      const rel = await withTestTenant(async () =>
        service.create(
          {
            familyId: TEST_SIS_FAMILY_ID,
            guardianAId: ga.guardianId,
            guardianBId: gb.guardianId,
            relationshipType: 'MARRIED',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.delete(rel.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('delete unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.delete('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('FamilyService', () => {
    it('getStudentGuardians returns linked guardian + per-link flags', async () => {
      const s = await trackedStudent({ firstName: 'Fam', lastName: 'Stu' });
      const g = await trackedGuardian({
        firstName: 'Fam',
        lastName: 'Grd',
        email: 'fam-gd@test.local',
      });
      await linkStudentGuardian(rawClient, s.studentId, g.guardianId, {
        hasCustody: true,
        isEmergencyContact: true,
      });

      const list = await withTestTenant(async () => familyService.getStudentGuardians(s.studentId));
      expect(list).toHaveLength(1);
      const link = list[0]!;
      expect(link.id).toBe(g.guardianId);
      expect(link.hasCustody).toBe(true);
      expect(link.isEmergencyContact).toBe(true);
    });

    it('getById returns null on unknown guardian', async () => {
      const out = await withTestTenant(async () =>
        familyService.getById('00000000-0000-0000-0000-000000000000'),
      );
      expect(out).toBeNull();
    });

    it('getById returns guardian when found', async () => {
      const g = await trackedGuardian({ firstName: 'Look', lastName: 'Up' });
      const out = await withTestTenant(async () => familyService.getById(g.guardianId));
      expect(out?.id).toBe(g.guardianId);
      expect(out?.firstName).toBe('Look');
    });
  });
});
