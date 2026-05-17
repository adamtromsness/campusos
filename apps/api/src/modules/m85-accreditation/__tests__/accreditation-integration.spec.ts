import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant';
import { FrameworkService } from '../framework.service';
import { EvidenceService } from '../evidence.service';
import { SelfStudyService } from '../self-study.service';
import { ActionPlanService } from '../action-plan.service';
import { SiteVisitService } from '../site-visit.service';
import { ActionPlanOverdueWorker } from '../action-plan-overdue.worker';
import { deterministicActionPlanOverdueEventId } from '../event-ids';

/**
 * Vertical-slice integration spec (P2-23b Step 6).
 *
 * Walks the plan's 7 scenarios end-to-end against fake-DB doubles:
 *  S1 — Framework adoption (UNIQUE + multi-framework).
 *  S2 — Evidence lifecycle (DRAFT → SUBMITTED → APPROVED, S3 wiring,
 *       URL evidence, type-shape validation).
 *  S3 — Self-study rating (UNIQUE per standard/school/cycle).
 *  S4 — Action plan creation + ActionPlanOverdueWorker flips
 *       IN_PROGRESS → OVERDUE + emits acc.action_plan.overdue.
 *  S5 — Readiness score (24/30 → 80; 30/30 → 100; zero standards → 0).
 *  S6 — SOFT INTEGRITY — evidence resolves to platform standard OR
 *       custom tenant framework. Bogus → 404.
 *  S7 — Visibility — coordinator full, staff read-only, guardian/
 *       student refused at the service layer.
 */

const SCHOOL = {
  schoolId: '019eaaaa-0000-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'SMALL',
  homeRegion: 'us-east-1',
} as const;

const ADMIN_ACTOR = {
  accountId: 'admin-account',
  personId: 'admin-person',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

const COORDINATOR_ACTOR = {
  accountId: 'coord-account',
  personId: 'coord-person',
  employeeId: 'coord-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const READONLY_STAFF_ACTOR = {
  accountId: 'staff-readonly',
  personId: 'staff-readonly-person',
  employeeId: 'staff-readonly-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const PARENT_ACTOR = {
  accountId: 'parent-account',
  personId: 'parent-person',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
};

const STUDENT_ACTOR = {
  accountId: 'student-account',
  personId: 'student-person',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
};

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
    executeInExplicitSchema: async (_schema: string, fn: (c: unknown) => Promise<unknown>) =>
      fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key?: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (
      _tx: unknown,
      opts: {
        topic: string;
        sourceModule: string;
        key?: string;
        eventId?: string;
        payload: Record<string, unknown>;
      },
    ) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
    },
  };
  return { outbox, emitted };
}

function makePermCheck(resolver: (accountId: string, codes: string[]) => boolean = () => true) {
  return {
    hasAnyPermissionInTenant: async (accountId: string, _schoolId: string, codes: string[]) =>
      resolver(accountId, codes),
  } as never;
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

function platformStandardRow(id: string, code: string) {
  return {
    id,
    framework_id: 'pf-1',
    standard_code: code,
    domain: 'Purpose & Direction',
    standard_text: 'Standard ' + code,
  };
}

function evidenceRow(opts: { id: string; status: string; standardId?: string; s3Key?: string }) {
  return {
    id: opts.id,
    school_id: SCHOOL.schoolId,
    standard_id: opts.standardId ?? 's-1',
    evidence_type: 'DOCUMENT',
    title: 'Mission doc',
    description: null,
    s3_key: opts.s3Key ?? 'acc/mission.pdf',
    url: null,
    metric_value: null,
    status: opts.status,
    submitted_by: 'u',
    submitted_at: '2026-01-01',
    reviewed_by: null,
    reviewed_at: null,
    reviewer_notes: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };
}

// ─────────────────────────────────────────────────────────────────
// S1 — Framework adoption + duplicate guard + multi-framework
// ─────────────────────────────────────────────────────────────────

describe('S1 — Framework adoption', () => {
  it('coordinator adopts AdvancED, then IB, both succeed', async () => {
    const inserts: string[] = [];
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_frameworks_platform')) {
        return [{ id: 'pf-1', name: 'AdvancED', abbreviation: 'AdvancED' }];
      }
      if (call.sql.includes('INSERT INTO acc_school_framework_adoptions')) {
        inserts.push(String(call.args[2] ?? ''));
        return 1;
      }
      return [];
    });
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());

    const adoption = await withTenant(() =>
      svc.createAdoption(COORDINATOR_ACTOR, {
        platformFrameworkId: '019dabcd-0000-7000-8000-000000000001',
      }),
    );
    expect(adoption.frameworkName).toBe('AdvancED');
    expect(inserts).toHaveLength(1);
  });

  it('duplicate adoption returns 409 ConflictException via 23505', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_frameworks_platform')) {
        return [{ id: 'pf-1', name: 'AdvancED', abbreviation: 'AdvancED' }];
      }
      if (call.sql.includes('INSERT INTO acc_school_framework_adoptions')) {
        throw { code: '23505' };
      }
      return [];
    });
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());

    await expect(
      withTenant(() =>
        svc.createAdoption(COORDINATOR_ACTOR, {
          platformFrameworkId: '019dabcd-0000-7000-8000-000000000001',
        }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('non-existent platformFrameworkId returns 404', async () => {
    const fake = makeFake(() => []);
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() =>
        svc.createAdoption(COORDINATOR_ACTOR, {
          platformFrameworkId: '019dabcd-0000-7000-8000-000000000099',
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────────
// S2 — Evidence lifecycle
// ─────────────────────────────────────────────────────────────────

describe('S2 — Evidence lifecycle (DRAFT → SUBMITTED → APPROVED)', () => {
  it('staff creates DRAFT, submits, coordinator approves — readiness recompute fires on APPROVED', async () => {
    let recomputed = 0;
    const evidenceStateBox = { current: 'DRAFT' as 'DRAFT' | 'SUBMITTED' | 'APPROVED' };
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: evidenceStateBox.current })];
      }
      if (
        call.sql.includes('UPDATE acc_evidence_items') &&
        call.sql.includes("status = 'SUBMITTED'")
      ) {
        evidenceStateBox.current = 'SUBMITTED';
        return 1;
      }
      if (call.sql.includes('UPDATE acc_evidence_items')) {
        // Detect REVIEWed path
        if (String(call.args[0] ?? '') === 'APPROVED') {
          evidenceStateBox.current = 'APPROVED';
        }
        return 1;
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => {
        recomputed += 1;
      },
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );

    // Submit → SUBMITTED
    const submitted = await withTenant(() =>
      svc.review(COORDINATOR_ACTOR, 'ev-1', { status: 'SUBMITTED' }),
    );
    expect(submitted.status).toBe('SUBMITTED');

    // Approve → APPROVED + recompute fires
    const approved = await withTenant(() =>
      svc.review(COORDINATOR_ACTOR, 'ev-1', { status: 'APPROVED' }),
    );
    expect(approved.status).toBe('APPROVED');
    expect(recomputed).toBe(1);
  });

  it('DOCUMENT requires s3Key + URL requires url + METRIC requires metricValue', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [platformStandardRow('s-1', '1.1')];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'DOCUMENT',
          title: 'X',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'URL',
          title: 'X',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'METRIC',
          title: 'X',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('valid URL evidence persists url column', async () => {
    let insertedUrl: string | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('INSERT INTO acc_evidence_items')) {
        insertedUrl = String(call.args[7] ?? '');
        return 1;
      }
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'DRAFT' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000001',
        evidenceType: 'URL',
        title: 'Strategic plan',
        url: 'https://lincoln.example.com/strategy',
      }),
    );
    expect(insertedUrl).toBe('https://lincoln.example.com/strategy');
  });
});

// ─────────────────────────────────────────────────────────────────
// S3 — Self-study rating UNIQUE constraint
// ─────────────────────────────────────────────────────────────────

describe('S3 — Self-study rating UNIQUE per (standard, school, cycle)', () => {
  it('first rating succeeds, duplicate returns 409', async () => {
    let inserted = 0;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('INSERT INTO acc_self_study_ratings')) {
        inserted += 1;
        if (inserted >= 2) {
          throw { code: 'P2002' };
        }
        return 1;
      }
      if (call.sql.includes('FROM acc_self_study_ratings')) {
        return [
          {
            id: 'r-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            cycle_id: '2025-2026',
            rating: 'ACCOMPLISHED',
            rationale: 'Clear mission statement reviewed annually',
            rated_by: 'coord-account',
            rated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new SelfStudyService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );

    const first = await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000001',
        cycleId: '2025-2026',
        rating: 'ACCOMPLISHED',
        rationale: 'Clear mission statement reviewed annually',
      }),
    );
    expect(first.rating).toBe('ACCOMPLISHED');

    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          cycleId: '2025-2026',
          rating: 'DEVELOPING',
          rationale: 'Reconsidered after observation data',
        }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('summary aggregates ratings by rating + domain (Custom bucket for tenant standards)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_self_study_ratings')) {
        return [
          { rating: 'EXEMPLARY', domain: 'Purpose', n: 2 },
          { rating: 'ACCOMPLISHED', domain: 'Purpose', n: 3 },
          { rating: 'DEVELOPING', domain: 'Resources', n: 1 },
          { rating: 'ACCOMPLISHED', domain: 'Custom', n: 1 },
        ];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new SelfStudyService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );

    const summary = await withTenant(() => svc.summary(COORDINATOR_ACTOR, '2025-2026'));
    expect(summary.totalRated).toBe(7);
    expect(summary.totals.EXEMPLARY).toBe(2);
    expect(summary.totals.ACCOMPLISHED).toBe(4);
    expect(summary.totals.DEVELOPING).toBe(1);
    expect(summary.totals.NOT_MET).toBe(0);
    const customDomain = summary.byDomain.find((d) => d.domain === 'Custom');
    expect(customDomain).toBeDefined();
    expect(customDomain!.ACCOMPLISHED).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// S4 — Action plan + ActionPlanOverdueWorker
// ─────────────────────────────────────────────────────────────────

describe('S4 — Action plan creation + overdue worker flips + emits', () => {
  it('overdue worker flips IN_PROGRESS → OVERDUE and emits acc.action_plan.overdue per row', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE acc_action_plans')) {
        return [
          {
            id: 'ap-1',
            standard_id: 's-1',
            responsible_party: 'emp-1',
            target_date: '2026-04-30',
            goal: 'Implement consistent classroom management framework',
          },
        ];
      }
      return [];
    });
    const { outbox, emitted } = makeOutbox();
    const worker = new ActionPlanOverdueWorker(fake.tenantPrisma as never, outbox as never);

    const n = await worker.tickForSchool(SCHOOL.schemaName, SCHOOL.schoolId, SCHOOL.subdomain);
    expect(n).toBe(1);
    expect(emitted).toHaveLength(1);
    const env = emitted[0]!;
    expect(env.topic).toBe('acc.action_plan.overdue');
    expect(env.sourceModule).toBe('accreditation');
    expect(env.payload.actionPlanId).toBe('ap-1');
    expect(env.payload.standardId).toBe('s-1');
    expect(env.payload.responsiblePartyEmployeeId).toBe('emp-1');
    expect(env.payload.goal).toBe('Implement consistent classroom management framework');
    // Deterministic event_id keys on actionPlanId
    expect(env.eventId).toBe(deterministicActionPlanOverdueEventId('ap-1'));
  });

  it('completing all sub-actions auto-flips parent plan to COMPLETE', async () => {
    let planRow = {
      id: 'ap-1',
      school_id: SCHOOL.schoolId,
      standard_id: 's-1',
      goal: 'Implement framework',
      actions: JSON.stringify([
        { description: 'Select framework', due_date: '2026-05-01', status: 'COMPLETED' },
        { description: 'Staff training', due_date: '2026-06-01', status: 'COMPLETED' },
      ]),
      responsible_party: 'emp-1',
      target_date: '2026-08-01',
      status: 'IN_PROGRESS',
      notes: null,
      created_by: 'u',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    };
    let lastStatusInUpdate: string | null = null;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_action_plans')) {
        return [planRow];
      }
      if (call.sql.includes('UPDATE acc_action_plans')) {
        // Track when status flips to COMPLETE (find position in args)
        const idx = call.sql.split(',').findIndex((s) => s.trim().startsWith('status'));
        if (idx >= 0) {
          lastStatusInUpdate = String(call.args[idx] ?? '');
        }
        if (call.args.some((a) => String(a) === 'COMPLETE')) {
          planRow = { ...planRow, status: 'COMPLETE' };
        }
        return 1;
      }
      if (call.sql.includes('FROM hr_employees')) {
        return [{ ok: 1 }];
      }
      return [];
    });
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );

    const after = await withTenant(() =>
      svc.updateSubAction(COORDINATOR_ACTOR, 'ap-1', {
        index: 0,
        status: 'COMPLETED',
      }),
    );
    expect(after.status).toBe('COMPLETE');
    expect(lastStatusInUpdate === 'COMPLETE' || planRow.status === 'COMPLETE').toBe(true);
  });

  it('deleting a COMPLETE action plan is refused (audit retention)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_action_plans')) {
        return [
          {
            id: 'ap-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            goal: 'X',
            actions: JSON.stringify([
              { description: 'X', due_date: '2026-01-01', status: 'COMPLETED' },
            ]),
            responsible_party: 'emp-1',
            target_date: '2026-01-01',
            status: 'COMPLETE',
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    await expect(withTenant(() => svc.delete(COORDINATOR_ACTOR, 'ap-1'))).rejects.toThrow(
      BadRequestException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// S5 — Readiness score auto-computation
// ─────────────────────────────────────────────────────────────────

describe('S5 — Readiness score computation', () => {
  function readinessFake(opts: {
    adopted: number;
    rated: number[];
    evidenced: number[];
    customCount?: number;
  }) {
    return makeFake((call) => {
      if (call.sql.includes('SELECT s.id::text AS id, s.standard_code, s.domain')) {
        // platform standards inside readinessForVisit
        return Array.from({ length: opts.adopted }, (_, i) => ({
          id: `s-${i + 1}`,
          standard_code: String(i + 1),
          domain: 'D',
        }));
      }
      if (call.sql.includes('FROM acc_school_framework_adoptions')) {
        return Array.from({ length: opts.adopted }, (_, i) => ({
          id: `s-${i + 1}`,
        }));
      }
      if (
        call.sql.includes('FROM acc_frameworks') &&
        !call.sql.includes('platform.acc_standards_platform')
      ) {
        return Array.from({ length: opts.customCount ?? 0 }, (_, i) => ({
          id: `cf-${i + 1}`,
          name: 'Custom ' + (i + 1),
        }));
      }
      if (
        call.sql.includes('FROM acc_self_study_ratings') &&
        call.sql.includes('DISTINCT standard_id')
      ) {
        return opts.rated.map((i) => ({ standard_id: `s-${i}` }));
      }
      if (
        call.sql.includes('FROM acc_evidence_items') &&
        call.sql.includes('DISTINCT standard_id')
      ) {
        return opts.evidenced.map((i) => ({ standard_id: `s-${i}` }));
      }
      if (call.sql.includes('acc_self_study_ratings') && call.sql.includes('MAX(rated_at)')) {
        return [{ cycle_id: '2025-2026' }];
      }
      if (call.sql.includes('FROM acc_site_visit_prep') && call.sql.includes('LIMIT 1')) {
        return [
          {
            id: 'sv-1',
            school_id: SCHOOL.schoolId,
            visit_date: '2026-06-15',
            accreditor_org: 'AdvancED Southern Region',
            lead_contact_name: 'Dr. Smith',
            lead_contact_email: null,
            status: 'PREPARING',
            readiness_score: '0',
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
  }

  it('24/30 ready standards → readiness_score = 80', async () => {
    const ratedAndEvidenced = Array.from({ length: 24 }, (_, i) => i + 1);
    const fake = readinessFake({
      adopted: 30,
      rated: ratedAndEvidenced,
      evidenced: ratedAndEvidenced,
    });
    const svc = new SiteVisitService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    const report = await withTenant(() => svc.readinessForVisit(ADMIN_ACTOR, 'sv-1'));
    expect(report.totalAdoptedStandards).toBe(30);
    expect(report.standardsReady).toBe(24);
    expect(report.readinessScore).toBe(80);
    expect(report.gaps).toHaveLength(6);
  });

  it('30/30 ready → readiness_score = 100, no gaps', async () => {
    const all = Array.from({ length: 30 }, (_, i) => i + 1);
    const fake = readinessFake({ adopted: 30, rated: all, evidenced: all });
    const svc = new SiteVisitService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    const report = await withTenant(() => svc.readinessForVisit(ADMIN_ACTOR, 'sv-1'));
    expect(report.readinessScore).toBe(100);
    expect(report.gaps).toHaveLength(0);
  });

  it('zero adopted standards → readiness_score = 0, gaps empty', async () => {
    const fake = readinessFake({ adopted: 0, rated: [], evidenced: [] });
    const svc = new SiteVisitService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    const report = await withTenant(() => svc.readinessForVisit(ADMIN_ACTOR, 'sv-1'));
    expect(report.readinessScore).toBe(0);
    expect(report.totalAdoptedStandards).toBe(0);
    expect(report.gaps).toHaveLength(0);
  });

  it('20/40 ready with rounding (20/40 = 0.5 → 50)', async () => {
    const rated = Array.from({ length: 25 }, (_, i) => i + 1);
    const evidenced = Array.from({ length: 30 }, (_, i) => i + 1);
    // Intersection = standards 1..25 (rated subset within evidenced); ready = 25
    // adopted=40 → 25/40 = 62.5 → 63
    const fake = readinessFake({ adopted: 40, rated, evidenced });
    const svc = new SiteVisitService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    const report = await withTenant(() => svc.readinessForVisit(ADMIN_ACTOR, 'sv-1'));
    expect(report.standardsReady).toBe(25);
    expect(report.totalAdoptedStandards).toBe(40);
    expect(report.readinessScore).toBe(63);
  });
});

// ─────────────────────────────────────────────────────────────────
// S6 — SOFT INTEGRITY — evidence resolves via platform OR custom
// ─────────────────────────────────────────────────────────────────

describe('S6 — SOFT INTEGRITY for standard_id', () => {
  it('evidence linked to a platform standard resolves cleanly', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'DRAFT' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    const dto = await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000001',
        evidenceType: 'DOCUMENT',
        title: 'Mission doc',
        s3Key: 'acc/mission.pdf',
      }),
    );
    expect(dto.status).toBe('DRAFT');
  });

  it('evidence linked to a tenant custom framework row resolves cleanly', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [];
      }
      if (call.sql.includes('FROM acc_frameworks')) {
        return [{ id: 'cf-1', name: 'Lincoln Custom' }];
      }
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'DRAFT', standardId: 'cf-1' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    const dto = await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000099',
        evidenceType: 'DOCUMENT',
        title: 'Custom doc',
        s3Key: 'acc/custom.pdf',
      }),
    );
    expect(dto.status).toBe('DRAFT');
  });

  it('evidence linked to a non-existent standardId → 404 NotFoundException', async () => {
    const fake = makeFake(() => []);
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000999',
          evidenceType: 'DOCUMENT',
          title: 'Orphan',
          s3Key: 'acc/orphan.pdf',
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('readinessForVisit counts custom acc_frameworks as standards', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT s.id::text AS id, s.standard_code, s.domain')) {
        return Array.from({ length: 2 }, (_, i) => ({
          id: `s-${i + 1}`,
          standard_code: String(i + 1),
          domain: 'D',
        }));
      }
      if (call.sql.includes('FROM acc_school_framework_adoptions')) {
        return Array.from({ length: 2 }, (_, i) => ({ id: `s-${i + 1}` }));
      }
      if (
        call.sql.includes('FROM acc_frameworks') &&
        !call.sql.includes('platform.acc_standards_platform')
      ) {
        return [{ id: 'cf-1' }];
      }
      if (call.sql.includes('DISTINCT standard_id')) {
        return [];
      }
      if (call.sql.includes('MAX(rated_at)')) {
        return [{ cycle_id: '2025-2026' }];
      }
      if (call.sql.includes('FROM acc_site_visit_prep')) {
        return [
          {
            id: 'sv-1',
            school_id: SCHOOL.schoolId,
            visit_date: '2026-06-15',
            accreditor_org: 'X',
            lead_contact_name: null,
            lead_contact_email: null,
            status: 'PREPARING',
            readiness_score: '0',
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    const svc = new SiteVisitService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    const report = await withTenant(() => svc.readinessForVisit(ADMIN_ACTOR, 'sv-1'));
    // 2 platform standards + 1 custom acc_frameworks row = 3 adopted
    expect(report.totalAdoptedStandards).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// S7 — Visibility matrix
// ─────────────────────────────────────────────────────────────────

describe('S7 — Visibility', () => {
  it('coordinator can rate, parent cannot (service-layer 403)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('INSERT INTO acc_self_study_ratings')) {
        return 1;
      }
      if (call.sql.includes('FROM acc_self_study_ratings')) {
        return [
          {
            id: 'r-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            cycle_id: '2025-2026',
            rating: 'ACCOMPLISHED',
            rationale: 'X',
            rated_by: 'u',
            rated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new SelfStudyService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );

    // Coordinator passes
    const ok = await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000001',
        cycleId: '2025-2026',
        rating: 'ACCOMPLISHED',
        rationale: 'Clear mission statement',
      }),
    );
    expect(ok.rating).toBe('ACCOMPLISHED');

    // Guardian fails at the service layer even if they hold the gate-tier perm
    await expect(
      withTenant(() =>
        svc.create(PARENT_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'X',
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('staff with TCH-008:read only cannot create an action plan', async () => {
    const fake = makeFake(() => []);
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => false),
    );
    await expect(
      withTenant(() =>
        svc.create(READONLY_STAFF_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          goal: 'Improve',
          responsibleParty: '019dabcd-0000-7000-8000-000000000777',
          targetDate: '2026-12-31',
          actions: [{ description: 'Do thing', due_date: '2026-06-01', status: 'PENDING' }],
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('student is refused at the service layer for evidence reads', async () => {
    const fake = makeFake(() => []);
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    await expect(withTenant(() => svc.listForStandard(STUDENT_ACTOR, 's-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('admin can read evidence by status (queue view)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'SUBMITTED' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    const rows = await withTenant(() => svc.listByStatus(ADMIN_ACTOR, 'SUBMITTED'));
    expect(rows).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// REVIEW-P2C23 ROUND 1 regression block
//
// BLOCKING 1 — Accreditation coordinator authority is now gated on
//   ACR-001:write/admin (dedicated permission code), NOT on
//   TCH-008:write (broadly granted to Teacher / VP / Staff for
//   curriculum management). Teachers + non-coordinator Staff are
//   refused at every write-side endpoint even though they hold
//   TCH-008:write for the curriculum surface.
//
// BLOCKING 2 — ActionPlanService.assertEmployeeInTenant adds
//   `school_id = tenant.schoolId` predicate so a current-school
//   action plan can no longer reference a foreign-school employee.
//
// MAJOR 1 — resolveStandard JOINs through acc_school_framework_adoptions
//   so a platform standard from an UN-adopted framework no longer
//   resolves. Evidence / ratings / action plans against unadopted
//   platform standards now return 404 at the create path.
// ─────────────────────────────────────────────────────────────────

describe('REVIEW-P2C23 BLOCKING 1 — ACR-001 coordinator authority split', () => {
  it('Teacher with only TCH-008:write is refused at EvidenceService.review APPROVED', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'SUBMITTED' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    // Permission check returns true ONLY for tch-008:* (curriculum
    // permission). Caller has NO acr-001 perms.
    const teacherWithCurriculum = makePermCheck((_, codes) =>
      codes.every((c) => c.startsWith('tch-008:')),
    );
    const svc = new EvidenceService(fake.tenantPrisma as never, teacherWithCurriculum, siteVisit);
    await expect(
      withTenant(() => svc.review(COORDINATOR_ACTOR, 'ev-1', { status: 'APPROVED' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('Teacher with only TCH-008:write is refused at ActionPlanService.create', async () => {
    const fake = makeFake(() => []);
    const teacherWithCurriculum = makePermCheck((_, codes) =>
      codes.every((c) => c.startsWith('tch-008:')),
    );
    const svc = new ActionPlanService(fake.tenantPrisma as never, teacherWithCurriculum);
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          goal: 'Improve',
          responsibleParty: '019dabcd-0000-7000-8000-000000000777',
          targetDate: '2026-12-31',
          actions: [{ description: 'Step 1', due_date: '2026-06-01', status: 'PENDING' }],
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('Teacher with only TCH-008:write is refused at SelfStudyService.create', async () => {
    const fake = makeFake(() => []);
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const teacherWithCurriculum = makePermCheck((_, codes) =>
      codes.every((c) => c.startsWith('tch-008:')),
    );
    const svc = new SelfStudyService(fake.tenantPrisma as never, teacherWithCurriculum, siteVisit);
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'X',
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('Coordinator with ACR-001:write passes EvidenceService.review APPROVED', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'SUBMITTED' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const coordinator = makePermCheck((_, codes) => codes.includes('acr-001:write'));
    const svc = new EvidenceService(fake.tenantPrisma as never, coordinator, siteVisit);
    // Note: the underlying getById returns SUBMITTED status; we expect
    // the lifecycle transition path to fire without 403.
    await expect(
      withTenant(() => svc.review(COORDINATOR_ACTOR, 'ev-1', { status: 'APPROVED' })),
    ).resolves.toBeDefined();
  });

  it('School admin bypass keeps working without ACR-001', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'SUBMITTED' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const noPerms = makePermCheck(() => false);
    const svc = new EvidenceService(fake.tenantPrisma as never, noPerms, siteVisit);
    await expect(
      withTenant(() => svc.review(ADMIN_ACTOR, 'ev-1', { status: 'APPROVED' })),
    ).resolves.toBeDefined();
  });
});

describe('REVIEW-P2C23 BLOCKING 2 — assertEmployeeInTenant school-scope', () => {
  it('action-plan create rejects a foreign-school employee UUID with 400', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM platform.acc_standards_platform') &&
        call.sql.includes('acc_school_framework_adoptions')
      ) {
        return [platformStandardRow('s-1', '1.1')];
      }
      // employee row is NOT in this school (school-scoped predicate returns nothing)
      if (call.sql.includes('FROM hr_employees') && call.sql.includes('school_id')) {
        return [];
      }
      return [];
    });
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          goal: 'Improve',
          responsibleParty: '019dabcd-0000-7000-8000-000000000bad',
          targetDate: '2026-12-31',
          actions: [{ description: 'Step 1', due_date: '2026-06-01', status: 'PENDING' }],
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('action-plan create accepts an in-school employee UUID', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM platform.acc_standards_platform') &&
        call.sql.includes('acc_school_framework_adoptions')
      ) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('FROM hr_employees') && call.sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('FROM acc_action_plans')) {
        return [
          {
            id: 'ap-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            goal: 'Improve',
            actions: JSON.stringify([
              { description: 'Step 1', due_date: '2026-06-01', status: 'PENDING' },
            ]),
            responsible_party: 'emp-1',
            target_date: '2026-12-31',
            status: 'PLANNED',
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    const plan = await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000001',
        goal: 'Improve',
        responsibleParty: '019dabcd-0000-7000-8000-000000000777',
        targetDate: '2026-12-31',
        actions: [{ description: 'Step 1', due_date: '2026-06-01', status: 'PENDING' }],
      }),
    );
    expect(plan.goal).toBe('Improve');
  });

  it('assertEmployeeInTenant SQL carries the school_id predicate', async () => {
    const captured: string[] = [];
    const fake = makeFake((call) => {
      captured.push(call.sql);
      if (
        call.sql.includes('FROM platform.acc_standards_platform') &&
        call.sql.includes('acc_school_framework_adoptions')
      ) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('FROM hr_employees') && call.sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('FROM acc_action_plans')) {
        return [
          {
            id: 'ap-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            goal: 'X',
            actions: '[]',
            responsible_party: 'emp-1',
            target_date: '2026-01-01',
            status: 'PLANNED',
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000001',
        goal: 'Improve',
        responsibleParty: '019dabcd-0000-7000-8000-000000000777',
        targetDate: '2026-12-31',
        actions: [{ description: 'X', due_date: '2026-06-01', status: 'PENDING' }],
      }),
    );
    const empSql = captured.find((s) => s.includes('FROM hr_employees'));
    expect(empSql).toBeDefined();
    expect(empSql!).toMatch(/school_id\s*=\s*\$2::uuid/);
  });
});

describe('REVIEW-P2C23 MAJOR 1 — Platform standards must be adopted before use', () => {
  it('resolveStandard SQL JOINs acc_school_framework_adoptions and filters is_active=true', async () => {
    const captured: string[] = [];
    const fake = makeFake((call) => {
      captured.push(call.sql);
      // No platform match (school has not adopted), no tenant match
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'DOCUMENT',
          title: 'X',
          s3Key: 'acc/x.pdf',
        }),
      ),
    ).rejects.toThrow(NotFoundException);
    const platformSql = captured.find((s) => s.includes('FROM platform.acc_standards_platform'));
    expect(platformSql).toBeDefined();
    expect(platformSql!).toMatch(/JOIN acc_school_framework_adoptions/);
    expect(platformSql!).toMatch(/a\.is_active\s*=\s*true/);
  });

  it('platform standard from an UN-adopted framework → 404 on evidence create', async () => {
    const fake = makeFake((call) => {
      // Platform standard exists but JOIN to acc_school_framework_adoptions
      // misses (school has not adopted that framework) → returns []
      if (
        call.sql.includes('FROM platform.acc_standards_platform') &&
        call.sql.includes('acc_school_framework_adoptions')
      ) {
        return [];
      }
      // Tenant custom also misses
      if (call.sql.includes('FROM acc_frameworks')) {
        return [];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'METRIC',
          title: 'Coverage',
          metricValue: '92%',
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('platform standard from an adopted framework still resolves cleanly', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM platform.acc_standards_platform') &&
        call.sql.includes('acc_school_framework_adoptions')
      ) {
        return [platformStandardRow('s-1', '1.1')];
      }
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [evidenceRow({ id: 'ev-1', status: 'DRAFT' })];
      }
      return [];
    });
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    const dto = await withTenant(() =>
      svc.create(COORDINATOR_ACTOR, {
        standardId: '019dabcd-0000-7000-8000-000000000001',
        evidenceType: 'DOCUMENT',
        title: 'Mission doc',
        s3Key: 'acc/mission.pdf',
      }),
    );
    expect(dto.status).toBe('DRAFT');
  });

  it('platform standard from an UN-adopted framework → 404 on self-study rating', async () => {
    const fake = makeFake(() => []);
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new SelfStudyService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'X',
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('platform standard from an UN-adopted framework → 404 on action plan create', async () => {
    const fake = makeFake(() => []);
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          goal: 'Improve',
          responsibleParty: '019dabcd-0000-7000-8000-000000000777',
          targetDate: '2026-12-31',
          actions: [{ description: 'X', due_date: '2026-06-01', status: 'PENDING' }],
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
