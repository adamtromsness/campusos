import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { AccreditationController } from '@modules/m85-accreditation/accreditation.controller';
import { FrameworkService } from '@modules/m85-accreditation/framework.service';
import { EvidenceService } from '@modules/m85-accreditation/evidence.service';
import { SelfStudyService } from '@modules/m85-accreditation/self-study.service';
import { ActionPlanService } from '@modules/m85-accreditation/action-plan.service';
import { SiteVisitService } from '@modules/m85-accreditation/site-visit.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
} from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetAccreditationTables,
  seedAdoption,
  TEST_PLATFORM_FRAMEWORK_ID,
  TEST_PLATFORM_STANDARD_A_ID,
} from '../fixtures/accreditation';

class StubActorContext {
  current: ResolvedActor = adminActor();
  async resolveActor(): Promise<ResolvedActor> {
    return this.current;
  }
}

/**
 * Wave 7 — m85-accreditation AccreditationController.
 *
 * Smokes every controller handler through a stub ActorContextService.
 * Deeper service contracts live in accreditation.spec.ts.
 */
describe('integration:m85-accreditation/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: AccreditationController;
  let actorStub: StubActorContext;
  let req: { user: { accountId: string; personId: string } };

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const frameworks = new FrameworkService(tenantPrisma, permCheck);
    const siteVisits = new SiteVisitService(tenantPrisma, permCheck);
    const evidence = new EvidenceService(tenantPrisma, permCheck, siteVisits);
    const selfStudy = new SelfStudyService(tenantPrisma, permCheck, siteVisits);
    const actionPlans = new ActionPlanService(tenantPrisma, permCheck);

    actorStub = new StubActorContext();
    ctl = new AccreditationController(
      actorStub as unknown as ActorContextService,
      frameworks,
      evidence,
      selfStudy,
      actionPlans,
      siteVisits,
    );

    req = { user: { accountId: TEST_ADMIN_ACCOUNT_ID, personId: TEST_ADMIN_PERSON_ID } };
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAccreditationTables(rawClient);
    actorStub.current = adminActor();
  });

  function isoDate(offset: number): string {
    return new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
  }

  describe('framework + adoption handlers', () => {
    it('listFrameworks + createAdoption + listAdoptions + listStandards + getStandardById', async () => {
      const frameworks = await withTestTenant(async () => ctl.listFrameworks(req as any));
      expect(frameworks.length).toBeGreaterThan(0);

      const adoption = await withTestTenant(async () =>
        ctl.createAdoption(req as any, { platformFrameworkId: TEST_PLATFORM_FRAMEWORK_ID } as any),
      );
      expect(adoption.platformFrameworkId).toBe(TEST_PLATFORM_FRAMEWORK_ID);

      const adoptions = await withTestTenant(async () => ctl.listAdoptions(req as any));
      expect(adoptions.length).toBe(1);

      const standards = await withTestTenant(async () =>
        ctl.listStandards(req as any, TEST_PLATFORM_FRAMEWORK_ID),
      );
      expect(standards.length).toBeGreaterThanOrEqual(3);

      const standard = await withTestTenant(async () =>
        ctl.getStandardById(req as any, TEST_PLATFORM_STANDARD_A_ID),
      );
      expect(standard.id).toBe(TEST_PLATFORM_STANDARD_A_ID);
    });

    it('createCustomFramework round-trip', async () => {
      const f = await withTestTenant(async () =>
        ctl.createCustomFramework(req as any, { name: 'Custom', description: 'd' } as any),
      );
      expect(f.source).toBe('TENANT');
    });
  });

  describe('evidence handlers', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    it('createEvidence + listEvidenceForStandard + listEvidenceByStatus + getEvidence + reviewEvidence', async () => {
      const ev = await withTestTenant(async () =>
        ctl.createEvidence(req as any, {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          evidenceType: 'OBSERVATION',
          title: 'Note',
          description: 'desc',
        } as any),
      );
      expect(ev.status).toBe('DRAFT');

      const list = await withTestTenant(async () =>
        ctl.listEvidenceForStandard(req as any, TEST_PLATFORM_STANDARD_A_ID),
      );
      expect(list.length).toBe(1);

      const byStatus = await withTestTenant(async () =>
        ctl.listEvidenceByStatus(req as any, 'DRAFT'),
      );
      expect(byStatus.length).toBe(1);
      const noFilter = await withTestTenant(async () =>
        ctl.listEvidenceByStatus(req as any, undefined),
      );
      expect(noFilter.length).toBe(1);

      const got = await withTestTenant(async () => ctl.getEvidence(req as any, ev.id));
      expect(got!.id).toBe(ev.id);

      const submitted = await withTestTenant(async () =>
        ctl.reviewEvidence(req as any, ev.id, { status: 'SUBMITTED' } as any),
      );
      expect(submitted.status).toBe('SUBMITTED');
    });
  });

  describe('self-study handlers', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    it('createSelfStudyRating + listSelfStudy + selfStudySummary', async () => {
      const rating = await withTestTenant(async () =>
        ctl.createSelfStudyRating(req as any, {
          standardId: TEST_PLATFORM_STANDARD_A_ID,
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'r',
        } as any),
      );
      expect(rating.rating).toBe('ACCOMPLISHED');

      const list = await withTestTenant(async () =>
        ctl.listSelfStudy(req as any, '2025-2026'),
      );
      expect(list.length).toBe(1);

      const summary = await withTestTenant(async () =>
        ctl.selfStudySummary(req as any, '2025-2026'),
      );
      expect(summary.totals.ACCOMPLISHED).toBe(1);
    });
  });

  describe('action plan handlers', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    function dto(extras: Record<string, unknown> = {}): any {
      return {
        standardId: TEST_PLATFORM_STANDARD_A_ID,
        goal: 'g',
        actions: [{ description: 'a', due_date: isoDate(1), status: 'PENDING' }],
        responsibleParty: TEST_ADMIN_EMPLOYEE_ID,
        targetDate: isoDate(30),
        ...extras,
      };
    }

    it('createActionPlan + listActionPlans + getActionPlan + updateActionPlan + updateSubAction + deleteActionPlan', async () => {
      const ap = await withTestTenant(async () => ctl.createActionPlan(req as any, dto()));
      expect(ap.status).toBe('PLANNED');

      const list = await withTestTenant(async () =>
        ctl.listActionPlans(req as any, undefined),
      );
      expect(list.length).toBe(1);
      const filtered = await withTestTenant(async () =>
        ctl.listActionPlans(req as any, 'PLANNED'),
      );
      expect(filtered.length).toBe(1);

      const got = await withTestTenant(async () => ctl.getActionPlan(req as any, ap.id));
      expect(got.id).toBe(ap.id);

      const updated = await withTestTenant(async () =>
        ctl.updateActionPlan(req as any, ap.id, {
          status: 'IN_PROGRESS',
          notes: 'going',
        } as any),
      );
      expect(updated.status).toBe('IN_PROGRESS');

      const subActed = await withTestTenant(async () =>
        ctl.updateSubAction(req as any, ap.id, {
          index: 0,
          status: 'COMPLETED',
        } as any),
      );
      expect(subActed.status).toBe('COMPLETE');

      // Cannot delete COMPLETE — but verify the handler routes to delete()
      // on a deletable plan instead.
      const ap2 = await withTestTenant(async () => ctl.createActionPlan(req as any, dto()));
      const out = await withTestTenant(async () =>
        ctl.deleteActionPlan(req as any, ap2.id),
      );
      expect(out).toEqual({ ok: true });
    });
  });

  describe('site visit handlers', () => {
    beforeEach(async () => {
      await seedAdoption(rawClient);
    });

    it('createSiteVisit + listSiteVisits + getSiteVisit + updateSiteVisit + siteVisitReadiness', async () => {
      const v = await withTestTenant(async () =>
        ctl.createSiteVisit(req as any, {
          visitDate: isoDate(30),
          accreditorOrg: 'O',
        } as any),
      );
      expect(v.status).toBe('PREPARING');

      const list = await withTestTenant(async () => ctl.listSiteVisits(req as any));
      expect(list.length).toBe(1);

      const got = await withTestTenant(async () => ctl.getSiteVisit(req as any, v.id));
      expect(got.id).toBe(v.id);

      const ready = await withTestTenant(async () =>
        ctl.updateSiteVisit(req as any, v.id, { status: 'READY' } as any),
      );
      expect(ready.status).toBe('READY');

      const report = await withTestTenant(async () =>
        ctl.siteVisitReadiness(req as any, v.id),
      );
      expect(report.visitId).toBe(v.id);
      expect(report.totalAdoptedStandards).toBe(3);
    });
  });

  describe('cross-school isolation through the controller', () => {
    it('listFrameworks: tenant custom in School B not visible from School A', async () => {
      await withTestTenantB(async () =>
        ctl.createCustomFramework(req as any, { name: 'B-only' } as any),
      );
      const listA = await withTestTenant(async () => ctl.listFrameworks(req as any));
      expect(listA.find((f) => f.name === 'B-only')).toBeUndefined();
    });
  });
});
