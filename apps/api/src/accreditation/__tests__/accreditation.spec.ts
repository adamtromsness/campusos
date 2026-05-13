import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '../../tenant/tenant.context';
import { assertCoordinatorScope, assertStaffOrAdmin, isUniqueViolation } from '../access';
import { deterministicActionPlanOverdueEventId } from '../event-ids';
import { FrameworkService } from '../framework.service';
import { EvidenceService } from '../evidence.service';
import { SelfStudyService } from '../self-study.service';
import { ActionPlanService } from '../action-plan.service';
import { SiteVisitService } from '../site-visit.service';
import { ActionPlanOverdueWorker } from '../action-plan-overdue.worker';

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
  accountId: 'coordinator-account',
  personId: 'coordinator-person',
  employeeId: 'coordinator-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const TEACHER_READONLY_ACTOR = {
  accountId: 'teacher-readonly',
  personId: 'teacher-readonly-person',
  employeeId: 'teacher-readonly-emp',
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
    enqueueInTx: async (_tx: unknown, opts: any) => {
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

function makePermCheck(resolver: (accountId: string, codes: string[]) => boolean = () => false) {
  return {
    hasAnyPermissionInTenant: async (accountId: string, _schoolId: string, codes: string[]) =>
      resolver(accountId, codes),
  } as never;
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────
// 1. Access helpers
// ─────────────────────────────────────────────────────────────────

describe('access helpers', () => {
  it('assertStaffOrAdmin allows admin', () => {
    expect(() => assertStaffOrAdmin(ADMIN_ACTOR, 'X')).not.toThrow();
  });
  it('assertStaffOrAdmin allows STAFF', () => {
    expect(() => assertStaffOrAdmin(COORDINATOR_ACTOR, 'X')).not.toThrow();
  });
  it('assertStaffOrAdmin refuses GUARDIAN even if they hold the gate-tier perm', () => {
    expect(() => assertStaffOrAdmin(PARENT_ACTOR, 'Reading frameworks')).toThrow(
      ForbiddenException,
    );
  });
  it('assertStaffOrAdmin refuses STUDENT even if they hold the gate-tier perm', () => {
    expect(() => assertStaffOrAdmin(STUDENT_ACTOR, 'Reading frameworks')).toThrow(
      ForbiddenException,
    );
  });

  it('assertCoordinatorScope allows admin without IAM check', async () => {
    const perm = makePermCheck(() => false);
    await expect(assertCoordinatorScope(ADMIN_ACTOR, perm, 'X')).resolves.not.toThrow();
  });
  it('assertCoordinatorScope passes STAFF with tch-008:write', async () => {
    const perm = makePermCheck((_, codes) => codes.includes('tch-008:write'));
    await expect(
      withTenant(() => assertCoordinatorScope(COORDINATOR_ACTOR, perm, 'X')),
    ).resolves.not.toThrow();
  });
  it('assertCoordinatorScope refuses STAFF without tch-008:write', async () => {
    const perm = makePermCheck(() => false);
    await expect(
      withTenant(() => assertCoordinatorScope(TEACHER_READONLY_ACTOR, perm, 'X')),
    ).rejects.toThrow(ForbiddenException);
  });
  it('assertCoordinatorScope refuses GUARDIAN even with the perm', async () => {
    const perm = makePermCheck(() => true);
    await expect(withTenant(() => assertCoordinatorScope(PARENT_ACTOR, perm, 'X'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('isUniqueViolation matches Prisma P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });
  it('isUniqueViolation matches raw 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });
  it('isUniqueViolation matches P2010 with meta.code 23505', () => {
    expect(isUniqueViolation({ code: 'P2010', meta: { code: '23505' } })).toBe(true);
  });
  it('isUniqueViolation matches a message that mentions 23505', () => {
    expect(isUniqueViolation({ message: 'unique constraint violation 23505' })).toBe(true);
  });
  it('isUniqueViolation rejects unrelated error', () => {
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Deterministic event id
// ─────────────────────────────────────────────────────────────────

describe('deterministicActionPlanOverdueEventId', () => {
  it('produces a v5-shape UUID (version nibble 5, variant nibble 8/9/a/b)', () => {
    const id = deterministicActionPlanOverdueEventId('019dabcd-0000-7000-8000-000000000001');
    // Standard UUID hyphen pattern
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Version nibble at position 14 must be '5' per v5-shape
    expect(id[14]).toBe('5');
    // Variant nibble at position 19 must be 8/9/a/b per RFC 4122
    expect(['8', '9', 'a', 'b']).toContain(id[19]!.toLowerCase());
  });

  it('is stable across calls — same input produces same id', () => {
    const a = deterministicActionPlanOverdueEventId('plan-1');
    const b = deterministicActionPlanOverdueEventId('plan-1');
    expect(a).toBe(b);
  });

  it('produces distinct ids for distinct inputs', () => {
    const a = deterministicActionPlanOverdueEventId('plan-1');
    const b = deterministicActionPlanOverdueEventId('plan-2');
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. FrameworkService
// ─────────────────────────────────────────────────────────────────

describe('FrameworkService', () => {
  it('listFrameworks returns platform + tenant frameworks tagged with source', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_frameworks_platform')) {
        return [
          {
            id: 'pf-1',
            name: 'AdvancED',
            abbreviation: 'AdvancED',
            organisation: 'Cognia',
            description: null,
            version: '2024',
            is_active: true,
            standard_count: 30,
            is_adopted: true,
          },
        ];
      }
      if (call.sql.includes('FROM acc_frameworks')) {
        return [{ id: 'tf-1', name: 'Lincoln Custom', description: 'In-house', is_active: true }];
      }
      return [];
    });
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());
    const out = await withTenant(() => svc.listFrameworks(ADMIN_ACTOR));
    expect(out.length).toBe(2);
    expect(out[0]!.source).toBe('PLATFORM');
    expect(out[0]!.isAdopted).toBe(true);
    expect(out[1]!.source).toBe('TENANT');
  });

  it('listFrameworks refuses GUARDIAN even with tch-008:read', async () => {
    const fake = makeFake(() => []);
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());
    await expect(withTenant(() => svc.listFrameworks(PARENT_ACTOR))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('createAdoption requires coordinator scope', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => false);
    const svc = new FrameworkService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.createAdoption(TEACHER_READONLY_ACTOR, {
          platformFrameworkId: '019dabcd-0000-7000-8000-000000000001',
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('createAdoption translates 23505 to ConflictException', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_frameworks_platform')) {
        return [{ id: 'pf-1', name: 'AdvancED', abbreviation: 'AdvancED' }];
      }
      if (call.sql.includes('INSERT INTO acc_school_framework_adoptions')) {
        // simulate 23505
        const e = new Error('duplicate key value violates unique constraint 23505') as Error & {
          code: string;
        };
        e.code = '23505';
        throw e;
      }
      return [];
    });
    const svc = new FrameworkService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    await expect(
      withTenant(() =>
        svc.createAdoption(COORDINATOR_ACTOR, {
          platformFrameworkId: '019dabcd-0000-7000-8000-000000000001',
        }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('createAdoption 404s when platform framework missing', async () => {
    const fake = makeFake(() => []);
    const svc = new FrameworkService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    await expect(
      withTenant(() =>
        svc.createAdoption(COORDINATOR_ACTOR, {
          platformFrameworkId: '019dabcd-0000-7000-8000-000000000001',
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('getStandardById resolves PLATFORM source', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [
          {
            id: 's-1',
            framework_id: 'pf-1',
            standard_code: '1.1',
            domain: 'Purpose',
            standard_text: 'Mission',
          },
        ];
      }
      return [];
    });
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());
    const out = await withTenant(() =>
      svc.getStandardById(ADMIN_ACTOR, '019dabcd-0000-7000-8000-000000000001'),
    );
    expect(out.source).toBe('PLATFORM');
    expect(out.standardCode).toBe('1.1');
  });

  it('getStandardById falls back to TENANT custom framework', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) return [];
      if (call.sql.includes('FROM acc_frameworks')) {
        return [{ id: 'tf-1', name: 'Custom Standard' }];
      }
      return [];
    });
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());
    const out = await withTenant(() =>
      svc.getStandardById(ADMIN_ACTOR, '019dabcd-0000-7000-8000-000000000001'),
    );
    expect(out.source).toBe('TENANT');
    expect(out.standardCode).toBe('Custom Standard');
  });

  it('getStandardById 404s when SOFT INTEGRITY misses on both sides', async () => {
    const fake = makeFake(() => []);
    const svc = new FrameworkService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() => svc.getStandardById(ADMIN_ACTOR, '019dabcd-0000-7000-8000-000000000001')),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. EvidenceService — type-shape validation + lifecycle
// ─────────────────────────────────────────────────────────────────

describe('EvidenceService', () => {
  function buildSvc(handler: (call: CapturedCall) => unknown) {
    const fake = makeFake(handler);
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new EvidenceService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    return { svc, fake };
  }

  it('create rejects DOCUMENT without s3Key', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [
          {
            id: 's-1',
            framework_id: 'pf-1',
            standard_code: '1.1',
            domain: 'Purpose',
            standard_text: 'X',
          },
        ];
      }
      return [];
    });
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'DOCUMENT',
          title: 'Mission doc',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('create rejects URL evidence without url', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [
          {
            id: 's-1',
            framework_id: 'pf-1',
            standard_code: '1.1',
            domain: 'X',
            standard_text: 'X',
          },
        ];
      }
      return [];
    });
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'URL',
          title: 'Strategic plan',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('create rejects standardId that resolves nowhere (SOFT INTEGRITY 404)', async () => {
    const { svc } = buildSvc(() => []);
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          evidenceType: 'METRIC',
          title: 'Coverage',
          metricValue: '94%',
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('review refuses non-DRAFT → SUBMITTED', async () => {
    let calls = 0;
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM acc_evidence_items')) {
        calls += 1;
        return [
          {
            id: 'e-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            evidence_type: 'DOCUMENT',
            title: 't',
            description: null,
            s3_key: 'k',
            url: null,
            metric_value: null,
            status: 'SUBMITTED', // already submitted
            submitted_by: 'u',
            submitted_at: '2026-01-01',
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    await expect(
      withTenant(() => svc.review(COORDINATOR_ACTOR, 'e-1', { status: 'SUBMITTED' })),
    ).rejects.toThrow(BadRequestException);
    expect(calls).toBeGreaterThan(0);
  });

  it('review APPROVED requires SUBMITTED current state', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [
          {
            id: 'e-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            evidence_type: 'DOCUMENT',
            title: 't',
            description: null,
            s3_key: 'k',
            url: null,
            metric_value: null,
            status: 'DRAFT',
            submitted_by: 'u',
            submitted_at: null,
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    await expect(
      withTenant(() => svc.review(COORDINATOR_ACTOR, 'e-1', { status: 'APPROVED' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('review REJECTED requires reviewerNotes', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [
          {
            id: 'e-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            evidence_type: 'DOCUMENT',
            title: 't',
            description: null,
            s3_key: 'k',
            url: null,
            metric_value: null,
            status: 'SUBMITTED',
            submitted_by: 'u',
            submitted_at: '2026-01-01',
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    await expect(
      withTenant(() => svc.review(COORDINATOR_ACTOR, 'e-1', { status: 'REJECTED' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('listForStandard refuses GUARDIAN', async () => {
    const { svc } = buildSvc(() => []);
    await expect(withTenant(() => svc.listForStandard(PARENT_ACTOR, 'std-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. SelfStudyService
// ─────────────────────────────────────────────────────────────────

describe('SelfStudyService', () => {
  function buildSvc(handler: (call: CapturedCall) => unknown) {
    const fake = makeFake(handler);
    const siteVisit = {
      recomputeReadinessForSchool: async () => undefined,
    } as unknown as SiteVisitService;
    const svc = new SelfStudyService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
      siteVisit,
    );
    return { svc, fake };
  }

  it('create translates UNIQUE(standard_id, school_id, cycle_id) violation to ConflictException', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [
          {
            id: 's-1',
            framework_id: 'pf-1',
            standard_code: '1.1',
            domain: 'X',
            standard_text: 'X',
          },
        ];
      }
      if (call.sql.includes('INSERT INTO acc_self_study_ratings')) {
        const e = new Error('23505 duplicate') as Error & { code: string };
        e.code = '23505';
        throw e;
      }
      return [];
    });
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          cycleId: '2025-2026',
          rating: 'ACCOMPLISHED',
          rationale: 'Strong evidence base',
        }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('summary aggregates by rating and domain', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM acc_self_study_ratings r')) {
        return [
          { rating: 'EXEMPLARY', domain: 'Purpose', n: 2 },
          { rating: 'ACCOMPLISHED', domain: 'Purpose', n: 1 },
          { rating: 'DEVELOPING', domain: 'Teaching', n: 3 },
          { rating: 'NOT_MET', domain: 'Custom', n: 1 },
        ];
      }
      return [];
    });
    const summary = await withTenant(() => svc.summary(ADMIN_ACTOR, '2025-2026'));
    expect(summary.totals.EXEMPLARY).toBe(2);
    expect(summary.totals.ACCOMPLISHED).toBe(1);
    expect(summary.totals.DEVELOPING).toBe(3);
    expect(summary.totals.NOT_MET).toBe(1);
    expect(summary.totalRated).toBe(7);
    expect(summary.byDomain.length).toBe(3);
    const purpose = summary.byDomain.find((d) => d.domain === 'Purpose')!;
    expect(purpose.EXEMPLARY).toBe(2);
    expect(purpose.ACCOMPLISHED).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. ActionPlanService
// ─────────────────────────────────────────────────────────────────

describe('ActionPlanService', () => {
  function buildSvc(handler: (call: CapturedCall) => unknown) {
    const fake = makeFake(handler);
    const svc = new ActionPlanService(
      fake.tenantPrisma as never,
      makePermCheck(() => true),
    );
    return { svc, fake };
  }

  it('create rejects bogus responsibleParty (not in hr_employees)', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [
          {
            id: 's-1',
            framework_id: 'pf-1',
            standard_code: '1.1',
            domain: 'X',
            standard_text: 'X',
          },
        ];
      }
      if (call.sql.includes('FROM hr_employees')) return [];
      return [];
    });
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          goal: 'Test',
          actions: [{ description: 'A1', due_date: '2026-12-01', status: 'PENDING' }],
          responsibleParty: '019dabcd-0000-7000-8000-000000000099',
          targetDate: '2027-01-01',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('create normalises actions JSON and rejects malformed sub-action', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM platform.acc_standards_platform')) {
        return [
          {
            id: 's-1',
            framework_id: 'pf-1',
            standard_code: '1.1',
            domain: 'X',
            standard_text: 'X',
          },
        ];
      }
      if (call.sql.includes('FROM hr_employees')) return [{ ok: 1 }];
      return [];
    });
    await expect(
      withTenant(() =>
        svc.create(COORDINATOR_ACTOR, {
          standardId: '019dabcd-0000-7000-8000-000000000001',
          goal: 'Test',
          actions: [{ description: '', due_date: '2026-12-01', status: 'PENDING' }],
          responsibleParty: '019dabcd-0000-7000-8000-000000000050',
          targetDate: '2027-01-01',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('updateSubAction auto-completes parent when all sub-actions are COMPLETED', async () => {
    let writeSql = '';
    let writeArgs: unknown[] = [];
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM acc_action_plans')) {
        return [
          {
            id: 'ap-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            goal: 'Plan',
            actions: JSON.stringify([
              { description: 'A1', due_date: '2026-01-01', status: 'COMPLETED' },
              { description: 'A2', due_date: '2026-02-01', status: 'PENDING' },
            ]),
            responsible_party: 'emp-1',
            target_date: '2027-01-01',
            status: 'IN_PROGRESS',
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      if (call.sql.includes('UPDATE acc_action_plans')) {
        writeSql = call.sql;
        writeArgs = call.args;
      }
      if (call.sql.includes('FROM hr_employees')) return [{ ok: 1 }];
      return [];
    });
    await withTenant(() =>
      svc.updateSubAction(COORDINATOR_ACTOR, 'ap-1', {
        index: 1,
        status: 'COMPLETED',
      }),
    );
    expect(writeSql).toContain('UPDATE acc_action_plans');
    // Effective status arg should be COMPLETE (auto-flip)
    const setStatus = writeArgs.find((a) => a === 'COMPLETE');
    expect(setStatus).toBe('COMPLETE');
  });

  it('delete refuses COMPLETE plan (audit retention)', async () => {
    const { svc } = buildSvc((call) => {
      if (call.sql.includes('FROM acc_action_plans')) {
        return [
          {
            id: 'ap-1',
            school_id: SCHOOL.schoolId,
            standard_id: 's-1',
            goal: 'Plan',
            actions: JSON.stringify([]),
            responsible_party: 'emp-1',
            target_date: '2027-01-01',
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
    await expect(withTenant(() => svc.delete(COORDINATOR_ACTOR, 'ap-1'))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('list refuses GUARDIAN', async () => {
    const { svc } = buildSvc(() => []);
    await expect(withTenant(() => svc.list(PARENT_ACTOR))).rejects.toThrow(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. SiteVisitService — readiness score formula
// ─────────────────────────────────────────────────────────────────

describe('SiteVisitService.readinessForVisit', () => {
  it('readinessScore = round(ready / total × 100), gaps populated correctly', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_site_visit_prep')) {
        return [
          {
            id: 'v-1',
            school_id: SCHOOL.schoolId,
            visit_date: '2026-10-15',
            accreditor_org: 'AdvancED',
            lead_contact_name: null,
            lead_contact_email: null,
            status: 'PREPARING',
            readiness_score: null,
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      // Most-recent cycle resolution
      if (call.sql.includes('GROUP BY cycle_id')) {
        return [{ cycle_id: '2025-2026' }];
      }
      // Adopted platform standards: 4 standards
      if (
        call.sql.includes('FROM acc_school_framework_adoptions a') &&
        call.sql.includes('JOIN platform.acc_standards_platform')
      ) {
        return [
          { id: 's1', standard_code: '1.1', domain: 'D' },
          { id: 's2', standard_code: '1.2', domain: 'D' },
          { id: 's3', standard_code: '1.3', domain: 'D' },
          { id: 's4', standard_code: '1.4', domain: 'D' },
        ];
      }
      // Custom standards: empty
      if (call.sql.includes('FROM acc_frameworks')) return [];
      // Rated set: s1, s2, s3
      if (call.sql.includes('FROM acc_self_study_ratings')) {
        return [{ standard_id: 's1' }, { standard_id: 's2' }, { standard_id: 's3' }];
      }
      // Evidenced (APPROVED) set: s1, s2, s4
      if (call.sql.includes('FROM acc_evidence_items')) {
        return [{ standard_id: 's1' }, { standard_id: 's2' }, { standard_id: 's4' }];
      }
      return [];
    });
    const svc = new SiteVisitService(fake.tenantPrisma as never, makePermCheck());
    const out = await withTenant(() => svc.readinessForVisit(ADMIN_ACTOR, 'v-1'));
    // ready = intersection {s1, s2} = 2; total = 4 → 50
    expect(out.readinessScore).toBe(50);
    expect(out.totalAdoptedStandards).toBe(4);
    expect(out.standardsWithRating).toBe(3);
    expect(out.standardsWithApprovedEvidence).toBe(3);
    expect(out.standardsReady).toBe(2);
    expect(out.gaps.length).toBe(2);
    // s3 rated but no evidence
    const s3 = out.gaps.find((g) => g.standardId === 's3')!;
    expect(s3.hasRating).toBe(true);
    expect(s3.hasApprovedEvidence).toBe(false);
    // s4 evidence but no rating
    const s4 = out.gaps.find((g) => g.standardId === 's4')!;
    expect(s4.hasRating).toBe(false);
    expect(s4.hasApprovedEvidence).toBe(true);
  });

  it('readinessScore = 0 when school has no adopted standards', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_site_visit_prep')) {
        return [
          {
            id: 'v-1',
            school_id: SCHOOL.schoolId,
            visit_date: '2026-10-15',
            accreditor_org: 'X',
            lead_contact_name: null,
            lead_contact_email: null,
            status: 'PREPARING',
            readiness_score: null,
            notes: null,
            created_by: 'u',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });
    const svc = new SiteVisitService(fake.tenantPrisma as never, makePermCheck());
    const out = await withTenant(() => svc.readinessForVisit(ADMIN_ACTOR, 'v-1'));
    expect(out.readinessScore).toBe(0);
    expect(out.totalAdoptedStandards).toBe(0);
  });

  it('update enforces VISIT_COMPLETE terminality', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM acc_site_visit_prep')) {
        return [
          {
            id: 'v-1',
            school_id: SCHOOL.schoolId,
            visit_date: '2026-10-15',
            accreditor_org: 'X',
            lead_contact_name: null,
            lead_contact_email: null,
            status: 'VISIT_COMPLETE',
            readiness_score: '95',
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
    await expect(
      withTenant(() => svc.update(COORDINATOR_ACTOR, 'v-1', { status: 'PREPARING' })),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. ActionPlanOverdueWorker — outbox shape + emit contract
// ─────────────────────────────────────────────────────────────────

describe('ActionPlanOverdueWorker', () => {
  it('flips IN_PROGRESS → OVERDUE and emits acc.action_plan.overdue per row', async () => {
    let updateRan = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE acc_action_plans')) {
        updateRan = true;
        // simulate two rows flipping
        return [
          {
            id: 'ap-1',
            standard_id: 's-1',
            responsible_party: 'emp-1',
            target_date: '2026-04-30',
            goal: 'Goal A',
          },
          {
            id: 'ap-2',
            standard_id: 's-2',
            responsible_party: 'emp-2',
            target_date: '2026-04-15',
            goal: 'Goal B',
          },
        ];
      }
      return [];
    });
    const { outbox, emitted } = makeOutbox();
    const worker = new ActionPlanOverdueWorker(fake.tenantPrisma as never, outbox as never);
    const flipped = await worker.tickForSchool('tenant_demo', SCHOOL.schoolId, SCHOOL.subdomain);
    expect(flipped).toBe(2);
    expect(updateRan).toBe(true);
    expect(emitted.length).toBe(2);
    for (const env of emitted) {
      expect(env.topic).toBe('acc.action_plan.overdue');
      expect(env.sourceModule).toBe('accreditation');
      expect(env.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(env.payload).toHaveProperty('actionPlanId');
      expect(env.payload).toHaveProperty('schoolId');
      expect(env.payload).toHaveProperty('standardId');
      expect(env.payload).toHaveProperty('responsiblePartyEmployeeId');
      expect(env.payload).toHaveProperty('targetDate');
      expect(env.payload).toHaveProperty('goal');
      expect(env.payload).toHaveProperty('sourceRefId');
      // sourceRefId === actionPlanId for downstream consumer dedup
      expect(env.payload.sourceRefId).toBe(env.payload.actionPlanId);
    }
    // Deterministic event_id stability — re-derive from the planId
    expect(emitted[0]!.eventId).toBe(deterministicActionPlanOverdueEventId('ap-1'));
    expect(emitted[1]!.eventId).toBe(deterministicActionPlanOverdueEventId('ap-2'));
  });

  it('emits zero envelopes when no rows are overdue', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE acc_action_plans')) return [];
      return [];
    });
    const { outbox, emitted } = makeOutbox();
    const worker = new ActionPlanOverdueWorker(fake.tenantPrisma as never, outbox as never);
    const flipped = await worker.tickForSchool('tenant_demo', SCHOOL.schoolId, SCHOOL.subdomain);
    expect(flipped).toBe(0);
    expect(emitted.length).toBe(0);
  });
});
