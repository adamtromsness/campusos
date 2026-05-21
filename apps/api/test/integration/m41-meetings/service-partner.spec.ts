import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ServicePartnerService } from '@modules/m41-meetings/meetings/service-partner.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor, parentActor, teacherActor } from '../helpers/actor';

/**
 * Wave 5 — m41-meetings ServicePartnerService.
 *
 * Per-school catalogue of external service-learning partner orgs.
 * UNIQUE(school_id, org_name).
 */
describe('integration:m41-meetings/service-partner', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: ServicePartnerService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new ServicePartnerService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.ext_service_partner_orgs WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  describe('CRUD', () => {
    it('admin creates partner → row inserted', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            orgName: 'Community Library',
            contactName: 'Jane',
            contactEmail: 'jane@community.org',
            serviceTypes: ['LITERACY', 'TUTORING'],
            websiteUrl: 'https://community.org',
            description: 'partner for after-school programs',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.orgName).toBe('Community Library');
      expect(dto.serviceTypes).toEqual(['LITERACY', 'TUTORING']);
      expect(dto.isActive).toBe(true);
    });

    it('duplicate org_name in same school → BadRequestException', async () => {
      await withTestTenant(async () => service.create({ orgName: 'Dup Org' } as any, adminActor()));
      await expect(
        withTestTenant(async () => service.create({ orgName: 'Dup Org' } as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('STUDENT cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.create({ orgName: 'Forbidden' } as any, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.create({ orgName: 'Forbidden' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin staff (teacher) can create', async () => {
      const dto = await withTestTenant(async () =>
        service.create({ orgName: 'Teacher Created' } as any, teacherActor()),
      );
      expect(dto.orgName).toBe('Teacher Created');
    });

    it('list returns active partners by default; includeInactive=true returns all', async () => {
      const a = await withTestTenant(async () =>
        service.create({ orgName: 'Active' } as any, adminActor()),
      );
      const b = await withTestTenant(async () =>
        service.create({ orgName: 'To deactivate' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        service.patch(b.id, { isActive: false } as any, adminActor()),
      );
      const active = await withTestTenant(async () => service.list(adminActor()));
      const activeIds = active.map((r) => r.id);
      expect(activeIds).toContain(a.id);
      expect(activeIds).not.toContain(b.id);

      const all = await withTestTenant(async () => service.list(adminActor(), true));
      expect(all.map((r) => r.id)).toContain(b.id);
    });

    it('getById returns the partner; missing → NotFoundException', async () => {
      const created = await withTestTenant(async () =>
        service.create({ orgName: 'Findable' } as any, adminActor()),
      );
      const fetched = await withTestTenant(async () => service.getById(created.id, adminActor()));
      expect(fetched.id).toBe(created.id);
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('STUDENT cannot list / getById → ForbiddenException', async () => {
      await expect(withTestTenant(async () => service.list(studentActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000', studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch updates fields', async () => {
      const created = await withTestTenant(async () =>
        service.create({ orgName: 'Original' } as any, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        service.patch(
          created.id,
          {
            orgName: 'Renamed',
            contactName: 'new contact',
            contactEmail: 'new@org.com',
            contactPhone: '555-1234',
            serviceTypes: ['NEW_TYPE'],
            description: 'updated',
            websiteUrl: 'https://new.org',
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(updated.orgName).toBe('Renamed');
      expect(updated.serviceTypes).toEqual(['NEW_TYPE']);
      expect(updated.isActive).toBe(false);
    });

    it('patch with empty body returns current row', async () => {
      const created = await withTestTenant(async () =>
        service.create({ orgName: 'unchanged' } as any, adminActor()),
      );
      const after = await withTestTenant(async () =>
        service.patch(created.id, {} as any, adminActor()),
      );
      expect(after.id).toBe(created.id);
    });

    it('patch on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.patch(
            '00000000-0000-0000-0000-000000000000',
            { orgName: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch rename to existing name → BadRequestException', async () => {
      const a = await withTestTenant(async () =>
        service.create({ orgName: 'A' } as any, adminActor()),
      );
      await withTestTenant(async () => service.create({ orgName: 'B' } as any, adminActor()));
      await expect(
        withTestTenant(async () => service.patch(a.id, { orgName: 'B' } as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('cross-school isolation', () => {
    it('list returns only the current school partners', async () => {
      const a = await withTestTenant(async () =>
        service.create({ orgName: 'A-side' } as any, adminActor()),
      );
      const b = await withTestTenantB(async () =>
        service.create({ orgName: 'B-side' } as any, adminActor()),
      );
      const aList = await withTestTenant(async () => service.list(adminActor()));
      const aIds = aList.map((r) => r.id);
      expect(aIds).toContain(a.id);
      expect(aIds).not.toContain(b.id);
    });

    it('School A admin cannot getById a School B partner → NotFoundException', async () => {
      const b = await withTestTenantB(async () =>
        service.create({ orgName: 'B private' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => service.getById(b.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('same org name allowed in different schools', async () => {
      await withTestTenant(async () =>
        service.create({ orgName: 'Cross-school' } as any, adminActor()),
      );
      await withTestTenantB(async () =>
        service.create({ orgName: 'Cross-school' } as any, adminActor()),
      );
      // Both should succeed; no UNIQUE collision across schools
    });
  });
});
