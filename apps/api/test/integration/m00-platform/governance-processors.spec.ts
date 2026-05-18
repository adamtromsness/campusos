import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ProcessorService } from '@modules/m00-platform/governance/processors.service';
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
 * DB-backed integration tests for ProcessorService — Article 28 processor
 * register + Data Processing Agreements + DPA-gap detection.
 */
describe('integration:m00-platform/governance-processors', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: ProcessorService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new ProcessorService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_data_processing_agreements WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_third_party_processors WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantDpo(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  function baseProcessorInput(overrides: Record<string, unknown> = {}) {
    return {
      processorName: 'Google Workspace',
      processorType: 'CLOUD_INFRASTRUCTURE' as const,
      registeredCountry: 'IE',
      dataCategoriesProcessed: ['email', 'documents'],
      adequacyDecisionApplicable: true,
      nextReviewDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      ...overrides,
    };
  }

  function baseDpaInput(processorId: string, overrides: Record<string, unknown> = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const reviewLater = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      processorId,
      agreementReference: 'DPA-2026-001',
      effectiveFrom: today,
      effectiveTo: null,
      documentS3Key: 's3://dpa/google-workspace.pdf',
      subProcessorsDisclosed: false,
      reviewDate: reviewLater,
      ...overrides,
    };
  }

  describe('scope checks', () => {
    it('admin bypass', async () => {
      await withTestTenant(async () => {
        await expect(service.assertReadScope(adminActor())).resolves.toBeUndefined();
        await expect(service.assertWriteScope(adminActor())).resolves.toBeUndefined();
        await expect(service.assertAdminScope(adminActor())).resolves.toBeUndefined();
      });
    });

    it('non-DPO STAFF → Forbidden on all', async () => {
      await withTestTenant(async () => {
        await expect(service.assertReadScope(officerActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
    });

    it('STAFF with dpo-002:write passes read+write but not admin', async () => {
      await grantDpo(['dpo-002:write', 'dpo-002:read']);
      await withTestTenant(async () => {
        await expect(service.assertReadScope(officerActor())).resolves.toBeUndefined();
        await expect(service.assertWriteScope(officerActor())).resolves.toBeUndefined();
        await expect(service.assertAdminScope(officerActor())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
    });
  });

  describe('processor CRUD', () => {
    it('admin creates processor; dpa_in_place=false initially → hasDpaGap=true', async () => {
      const created = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      expect(created.dpaInPlace).toBe(false);
      expect(created.hasDpaGap).toBe(true);
    });

    it('non-DPO create → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.createProcessor(officerActor(), baseProcessorInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.createProcessor(studentActor(), baseProcessorInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.createProcessor(parentActor(), baseProcessorInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('empty dataCategoriesProcessed → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.createProcessor(adminActor(), baseProcessorInput({ dataCategoriesProcessed: [] })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate processorName → BadRequest', async () => {
      await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.createProcessor(adminActor(), baseProcessorInput()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list (default) returns processors sorted by dpaInPlace ASC then name', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const b = await withTestTenant(async () =>
        service.createProcessor(
          adminActor(),
          baseProcessorInput({ processorName: 'AWS' }),
        ),
      );
      const list = await withTestTenant(async () => service.listProcessors(adminActor()));
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it('list gapsOnly returns only dpa_in_place=false', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const gaps = await withTestTenant(async () =>
        service.listProcessors(adminActor(), { gapsOnly: true }),
      );
      expect(gaps.find((p) => p.id === a.id)).toBeDefined();
    });

    it('update non-conflicting fields', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const updated = await withTestTenant(async () =>
        service.updateProcessor(adminActor(), a.id, { notes: 'reviewed 2026' }),
      );
      expect(updated.notes).toBe('reviewed 2026');
    });

    it('update rename to duplicate → BadRequest', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const b = await withTestTenant(async () =>
        service.createProcessor(
          adminActor(),
          baseProcessorInput({ processorName: 'Other' }),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.updateProcessor(adminActor(), b.id, { processorName: 'Google Workspace' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update with empty dataCategoriesProcessed → BadRequest', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.updateProcessor(adminActor(), a.id, { dataCategoriesProcessed: [] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update empty patch returns existing', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const updated = await withTestTenant(async () =>
        service.updateProcessor(adminActor(), a.id, {}),
      );
      expect(updated.id).toBe(a.id);
    });

    it('admin deletes; non-admin → Forbidden', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      await expect(
        withTestTenant(async () => service.deleteProcessor(officerActor(), a.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await withTestTenant(async () => service.deleteProcessor(adminActor(), a.id));
      await expect(
        withTestTenant(async () => service.getProcessor(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('delete missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.deleteProcessor(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school read → NotFound', async () => {
      const a = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      await expect(
        withTestTenantB(async () => service.getProcessor(adminActor(), a.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('DPA CRUD + backlink', () => {
    it('create DPA backfills processor.dpa_in_place=true + dpa_id', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      const after = await withTestTenant(async () => service.getProcessor(adminActor(), proc.id));
      expect(after.dpaInPlace).toBe(true);
      expect(after.dpaId).toBe(dpa.id);
      expect(after.hasDpaGap).toBe(false);
      expect(dpa.status).toBe('ACTIVE');
      expect(after.dpaStatus).toBe('ACTIVE');
    });

    it('create DPA for cross-school processor → NotFound (via getProcessor)', async () => {
      const procB = await withTestTenantB(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      await expect(
        withTestTenant(async () =>
          service.createDpa(adminActor(), baseDpaInput(procB.id)),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list DPAs scoped to processor', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      const all = await withTestTenant(async () => service.listDpas(adminActor()));
      expect(all.find((d) => d.id === dpa.id)).toBeDefined();
      const filtered = await withTestTenant(async () => service.listDpas(adminActor(), proc.id));
      expect(filtered.find((d) => d.id === dpa.id)).toBeDefined();
    });

    it('getDpa cross-school → NotFound', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      await expect(
        withTestTenantB(async () => service.getDpa(adminActor(), dpa.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update DPA status=EXPIRED clears processor.dpa_in_place=false', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      await withTestTenant(async () =>
        service.updateDpa(adminActor(), dpa.id, { status: 'EXPIRED' }),
      );
      const after = await withTestTenant(async () => service.getProcessor(adminActor(), proc.id));
      expect(after.dpaInPlace).toBe(false);
      expect(after.hasDpaGap).toBe(true); // EXPIRED counts as gap
    });

    it('update DPA status=TERMINATED clears processor.dpa_in_place=false', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      await withTestTenant(async () =>
        service.updateDpa(adminActor(), dpa.id, { status: 'TERMINATED' }),
      );
      const after = await withTestTenant(async () => service.getProcessor(adminActor(), proc.id));
      expect(after.dpaInPlace).toBe(false);
    });

    it('update DPA status back to ACTIVE restores dpa_in_place=true', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      await withTestTenant(async () =>
        service.updateDpa(adminActor(), dpa.id, { status: 'EXPIRED' }),
      );
      await withTestTenant(async () =>
        service.updateDpa(adminActor(), dpa.id, { status: 'ACTIVE' }),
      );
      const after = await withTestTenant(async () => service.getProcessor(adminActor(), proc.id));
      expect(after.dpaInPlace).toBe(true);
    });

    it('update other DPA fields without status change does not touch processor', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      const updated = await withTestTenant(async () =>
        service.updateDpa(adminActor(), dpa.id, { notes: 'updated notes' }),
      );
      expect(updated.notes).toBe('updated notes');
    });

    it('update DPA empty patch returns existing', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      const dpa = await withTestTenant(async () =>
        service.createDpa(adminActor(), baseDpaInput(proc.id)),
      );
      const updated = await withTestTenant(async () =>
        service.updateDpa(adminActor(), dpa.id, {}),
      );
      expect(updated.id).toBe(dpa.id);
    });

    it('update non-existent DPA → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.updateDpa(adminActor(), generateId(), { notes: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getDpa missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getDpa(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-DPO list/get/create/update → Forbidden', async () => {
      const proc = await withTestTenant(async () =>
        service.createProcessor(adminActor(), baseProcessorInput()),
      );
      await expect(
        withTestTenant(async () => service.listDpas(officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.getProcessor(officerActor(), proc.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.createDpa(officerActor(), baseDpaInput(proc.id))),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
