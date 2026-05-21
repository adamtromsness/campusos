import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { DpiaService } from '@modules/m00-platform/governance/dpia.service';
import { RopaService } from '@modules/m00-platform/governance/ropa.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * DB-backed integration tests for DpiaService — GDPR Article 35 Data
 * Protection Impact Assessment, status state machine, soft-FK to ROPA.
 */
describe('integration:m00-platform/governance-dpia', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let ropa: RopaService;
  let service: DpiaService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    ropa = new RopaService(tenantPrisma, permCheck);
    service = new DpiaService(tenantPrisma, ropa);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_processing_activities WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_dpias WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantDpoWrite(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['dpo-001:write', 'dpo-001:read'],
    );
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      dpiaTitle: 'Cafeteria Photo Sharing DPIA',
      triggerReason: 'Sharing student photos to social media',
      descriptionOfProcessing: 'Photos posted to school Facebook page',
      necessityProportionalityAssessment: 'Photos are necessary for community engagement',
      risksIdentified: [
        {
          riskDescription: 'Photo could identify a vulnerable student',
          likelihood: 'medium' as const,
          severity: 'high' as const,
          mitigationMeasures: 'Use silhouettes for vulnerable cases',
        },
      ],
      supervisoryAuthorityConsultationRequired: false,
      ...overrides,
    };
  }

  describe('create', () => {
    it('admin creates a DPIA (SCOPING) without processing activity link', async () => {
      const created = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      expect(created.status).toBe('SCOPING');
      expect(created.dpiaTitle).toBe('Cafeteria Photo Sharing DPIA');
      expect(created.processingActivityId).toBeNull();
      expect(created.risksIdentified).toHaveLength(1);
      expect(created.completedAt).toBeNull();
      expect(created.approvedById).toBeNull();
    });

    it('officer with dpo-001:write can create', async () => {
      await grantDpoWrite();
      const created = await withTestTenant(async () => service.create(officerActor(), baseInput()));
      expect(created.status).toBe('SCOPING');
    });

    it('officer without DPO write → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.create(officerActor(), baseInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-staff persona → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.create(studentActor(), baseInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(parentActor(), baseInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('processingActivityId pointing to another school → BadRequest', async () => {
      // Seed a processing activity in School B
      const paBId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_processing_activities
          (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, is_active)
         VALUES ($1::uuid, $2::uuid, 'School B PA', 'p', 'PUBLIC_TASK', ARRAY['c'], ARRAY['s'], true)`,
        paBId,
        TEST_SCHOOL_B_ID,
      );
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), baseInput({ processingActivityId: paBId })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('linked processing activity in same school → DTO carries the activity name', async () => {
      const paId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_processing_activities
          (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, is_active)
         VALUES ($1::uuid, $2::uuid, 'Cafeteria Imagery', 'p', 'PUBLIC_TASK', ARRAY['photos'], ARRAY['students'], true)`,
        paId,
        TEST_SCHOOL_ID,
      );
      const created = await withTestTenant(async () =>
        service.create(adminActor(), baseInput({ processingActivityId: paId })),
      );
      expect(created.processingActivityId).toBe(paId);
      expect(created.processingActivityName).toBe('Cafeteria Imagery');
    });
  });

  describe('list + getById', () => {
    it('list returns DPIAs scoped to current school; cross-school invisible', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      const b = await withTestTenantB(async () => service.create(adminActor(), baseInput()));
      const listA = await withTestTenant(async () => service.list(adminActor()));
      expect(listA.find((d) => d.id === a.id)).toBeDefined();
      expect(listA.find((d) => d.id === b.id)).toBeUndefined();
    });

    it('status filter', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      const b = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      await withTestTenant(async () => service.update(adminActor(), b.id, { status: 'COMPLETED' }));
      const scoping = await withTestTenant(async () =>
        service.list(adminActor(), { status: 'SCOPING' }),
      );
      expect(scoping.find((d) => d.id === a.id)).toBeDefined();
      expect(scoping.find((d) => d.id === b.id)).toBeUndefined();
    });

    it('list as non-DPO → ForbiddenException', async () => {
      await expect(withTestTenant(async () => service.list(officerActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getById → NotFoundException', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      await expect(
        withTestTenantB(async () => service.getById(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update — status state machine', () => {
    async function seed(): Promise<string> {
      const r = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      return r.id;
    }

    it('SCOPING → IN_PROGRESS works', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, { status: 'IN_PROGRESS' }),
      );
      expect(updated.status).toBe('IN_PROGRESS');
      expect(updated.completedAt).toBeNull();
    });

    it('SCOPING → COMPLETED stamps completedAt + completedById', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, { status: 'COMPLETED' }),
      );
      expect(updated.status).toBe('COMPLETED');
      expect(updated.completedAt).not.toBeNull();
      expect(updated.completedById).toBe(adminActor().accountId);
    });

    it('SCOPING → APPROVED stamps both completed + approved metadata', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, { status: 'APPROVED' }),
      );
      expect(updated.status).toBe('APPROVED');
      expect(updated.approvedById).toBe(adminActor().accountId);
      expect(updated.completedAt).not.toBeNull();
    });

    it('REJECTED is terminal — cannot transition out except to REJECTED itself', async () => {
      const id = await seed();
      await withTestTenant(async () => service.update(adminActor(), id, { status: 'REJECTED' }));
      await expect(
        withTestTenant(async () => service.update(adminActor(), id, { status: 'IN_PROGRESS' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () => service.update(adminActor(), id, { status: 'APPROVED' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('APPROVED → REJECTED is allowed; APPROVED → IN_PROGRESS is blocked', async () => {
      const id = await seed();
      await withTestTenant(async () => service.update(adminActor(), id, { status: 'APPROVED' }));
      // Allowed transition: APPROVED → REJECTED
      const rejected = await withTestTenant(async () =>
        service.update(adminActor(), id, { status: 'REJECTED' }),
      );
      expect(rejected.status).toBe('REJECTED');
    });

    it('APPROVED → IN_PROGRESS blocked', async () => {
      const id = await seed();
      await withTestTenant(async () => service.update(adminActor(), id, { status: 'APPROVED' }));
      await expect(
        withTestTenant(async () => service.update(adminActor(), id, { status: 'IN_PROGRESS' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('multi-field update preserves unspecified fields', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, {
          dpoOpinion: 'Approved with mitigations',
          residualRiskLevel: 'LOW',
          documentS3Key: 's3://dpia.pdf',
          status: 'COMPLETED',
        }),
      );
      expect(updated.dpoOpinion).toBe('Approved with mitigations');
      expect(updated.residualRiskLevel).toBe('LOW');
      expect(updated.documentS3Key).toBe('s3://dpia.pdf');
      expect(updated.status).toBe('COMPLETED');
    });

    it('empty patch is no-op', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () => service.update(adminActor(), id, {}));
      expect(updated.id).toBe(id);
      expect(updated.status).toBe('SCOPING');
    });

    it('non-DPO update → ForbiddenException', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () => service.update(officerActor(), id, { status: 'IN_PROGRESS' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing DPIA → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), generateId(), { status: 'IN_PROGRESS' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('admin can hard-delete', async () => {
      const id = await withTestTenant(async () =>
        service.create(adminActor(), baseInput()).then((d) => d.id),
      );
      await withTestTenant(async () => service.remove(adminActor(), id));
      await expect(
        withTestTenant(async () => service.getById(adminActor(), id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin without dpo-001:admin → ForbiddenException', async () => {
      const id = await withTestTenant(async () =>
        service.create(adminActor(), baseInput()).then((d) => d.id),
      );
      await expect(
        withTestTenant(async () => service.remove(officerActor(), id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.remove(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school remove → NotFoundException', async () => {
      const id = await withTestTenant(async () =>
        service.create(adminActor(), baseInput()).then((d) => d.id),
      );
      await expect(
        withTestTenantB(async () => service.remove(adminActor(), id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
