import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { HealthAdvancedController } from './health-advanced.controller';
import { TelehealthProviderService } from './telehealth-provider.service';
import { TelehealthSessionService } from './telehealth-session.service';
import { ImmunisationRequirementService } from './immunisation-requirement.service';
import { ImmunisationComplianceService } from './immunisation-compliance.service';
import { ScreeningReferralService } from './screening-referral.service';

/**
 * P2C3 keystone unit tests. Each test asserts a single load-bearing
 * invariant from the cycle.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ACTOR_BASE = {
  accountId: '019e0cf8-bbb8-7556-8c81-000000000001',
  personId: '019e0cf8-bbb8-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};
const ADMIN_ACTOR = { ...ACTOR_BASE, isSchoolAdmin: true } as never;

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
  const permissions = { hasAnyPermissionInTenant: async () => true };
  return { capture, client, tenantPrisma, permissions };
}

describe('TelehealthProviderService — admin gate + soft-deactivate', () => {
  it('list with includeInactive=false filters to is_active=true', async () => {
    const fake = makeFake(() => []);
    const svc = new TelehealthProviderService(
      fake.tenantPrisma as never,
      fake.permissions as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(false));
    expect(fake.capture).toHaveLength(1);
    expect(fake.capture[0]!.sql.toLowerCase()).toContain('is_active = true');
  });

  it('loadActiveOrFail rejects unknown / inactive providers with BadRequest', async () => {
    const fake = makeFake(() => []);
    const svc = new TelehealthProviderService(
      fake.tenantPrisma as never,
      fake.permissions as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.loadActiveOrFail('bogus-id')),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('TelehealthSessionService — HIPAA audit on every read', () => {
  it('list writes a hlth_health_access_log row per returned session', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      // 1: SELECT sessions
      if (stage === 1 && c.sql.toLowerCase().includes('from hlth_telehealth_sessions s')) {
        return [
          { id: 'sess-A', school_id: SCHOOL.schoolId, student_id: 'stu-1', status: 'COMPLETED' },
          { id: 'sess-B', school_id: SCHOOL.schoolId, student_id: 'stu-2', status: 'SCHEDULED' },
        ];
      }
      return [];
    });
    let recordAccessCalls = 0;
    const accessLog = {
      recordAccess: async () => {
        recordAccessCalls += 1;
      },
    };
    const providers = {
      loadActiveOrFail: async () => ({}),
    };
    const svc = new TelehealthSessionService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      providers as never,
      accessLog as never,
    );
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.list({}, ADMIN_ACTOR),
    );
    expect(out).toHaveLength(2);
    // Two rows → two audit entries.
    expect(recordAccessCalls).toBe(2);
  });

  it('getById writes exactly one hlth_health_access_log entry', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('from hlth_telehealth_sessions s')) {
        return [
          { id: 'sess-A', school_id: SCHOOL.schoolId, student_id: 'stu-1', status: 'COMPLETED' },
        ];
      }
      return [];
    });
    let recordAccessCalls = 0;
    const accessLog = {
      recordAccess: async (_actor: unknown, _studentId: string, accessType: string) => {
        if (accessType !== 'VIEW_TELEHEALTH') {
          throw new Error('expected VIEW_TELEHEALTH, got ' + accessType);
        }
        recordAccessCalls += 1;
      },
    };
    const providers = { loadActiveOrFail: async () => ({}) };
    const svc = new TelehealthSessionService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      providers as never,
      accessLog as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.getById('sess-A', ADMIN_ACTOR));
    expect(recordAccessCalls).toBe(1);
  });

  it('schedule rejects non-existent student with BadRequest', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('from sis_students where id')) {
        return []; // student not found
      }
      return [];
    });
    const accessLog = { recordAccess: async () => undefined };
    const providers = { loadActiveOrFail: async () => ({}) };
    const svc = new TelehealthSessionService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      providers as never,
      accessLog as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.schedule(
          {
            studentId: '019e0d40-aaaa-bbbb-cccc-000000000001',
            providerId: '019e0d40-aaaa-bbbb-cccc-000000000099',
            scheduledAt: new Date().toISOString(),
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('patch refuses transition out of terminal status (COMPLETED)', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [{ id: 'sess-A', status: 'COMPLETED' }];
      }
      return [];
    });
    const accessLog = { recordAccess: async () => undefined };
    const providers = { loadActiveOrFail: async () => ({}) };
    const svc = new TelehealthSessionService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      providers as never,
      accessLog as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('sess-A', { status: 'IN_PROGRESS' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/terminal status/);
  });

  // REVIEW-P2C3 BLOCKING #3 — CANCELLED requires a non-empty
  // cancellation_reason. The service surfaces a friendly 400 before
  // the UPDATE fires; migration 110 is the schema-side belt-and-braces.
  it('patch rejects CANCELLED transition without cancellationReason', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [{ id: 'sess-A', status: 'SCHEDULED' }];
      }
      return [];
    });
    const accessLog = { recordAccess: async () => undefined };
    const providers = { loadActiveOrFail: async () => ({}) };
    const svc = new TelehealthSessionService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      providers as never,
      accessLog as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('sess-A', { status: 'CANCELLED' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/cancellationReason/);
    // Whitespace-only reason is also rejected — service trims before
    // checking truthiness.
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('sess-A', { status: 'CANCELLED', cancellationReason: '   ' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/cancellationReason/);
  });

  it('patch accepts CANCELLED with a valid cancellationReason', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      if (c.sql.toLowerCase().includes('for update')) {
        return [{ id: 'sess-A', status: 'SCHEDULED' }];
      }
      // Final reload — return a row so rowToDto succeeds.
      if (stage > 2) {
        return [
          {
            id: 'sess-A',
            school_id: SCHOOL.schoolId,
            student_id: 'stu-1',
            student_first: 'Maya',
            student_last: 'Chen',
            provider_id: 'prov-1',
            provider_name: 'BetterMynd',
            provider_speciality: 'Mental Health',
            scheduled_at: new Date().toISOString(),
            duration_minutes: 30,
            status: 'CANCELLED',
            meeting_url: null,
            session_notes_s3_key: null,
            consent_signature_id: null,
            consent_received_at: null,
            completed_at: null,
            cancelled_at: new Date().toISOString(),
            cancellation_reason: 'Family emergency',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ];
      }
      return [];
    });
    const accessLog = { recordAccess: async () => undefined };
    const providers = { loadActiveOrFail: async () => ({}) };
    const svc = new TelehealthSessionService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      providers as never,
      accessLog as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch(
        'sess-A',
        { status: 'CANCELLED', cancellationReason: 'Family emergency' },
        ADMIN_ACTOR,
      ),
    );
    expect(dto.status).toBe('CANCELLED');
    expect(dto.cancellationReason).toBe('Family emergency');
    // The UPDATE statement should have stamped cancellation_reason.
    const updateCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update hlth_telehealth_sessions'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall!.sql).toContain('cancelled_at = now()');
    expect(updateCall!.sql).toContain('cancellation_reason');
    expect(updateCall!.args).toContain('Family emergency');
  });
});

describe('ImmunisationRequirementService — admin guard + UNIQUE catch', () => {
  it('create surfaces UNIQUE violation as friendly BadRequest', async () => {
    const fake = makeFake(() => {
      throw { code: '23505', message: 'duplicate key' };
    });
    const svc = new ImmunisationRequirementService(
      fake.tenantPrisma as never,
      fake.permissions as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            stateCode: 'KS',
            vaccineName: 'DTaP',
            requiredDoses: 5,
            requiredByGrade: 'K',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('patch refuses to mutate a platform-default row (school_id IS NULL)', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [{ id: 'req-A', school_id: null }];
      }
      return [];
    });
    const svc = new ImmunisationRequirementService(
      fake.tenantPrisma as never,
      fake.permissions as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('req-A', { requiredDoses: 6 }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('list returns platform defaults plus per-school overrides', async () => {
    const fake = makeFake(() => []);
    const svc = new ImmunisationRequirementService(
      fake.tenantPrisma as never,
      fake.permissions as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list());
    const sql = fake.capture[0]!.sql.toLowerCase();
    expect(sql).toContain('school_id is null or school_id = $1');
  });
});

describe('ImmunisationComplianceService — UPSERT idempotency + state CSV', () => {
  it('computeForSchool writes ON CONFLICT DO UPDATE on (student_id, year)', async () => {
    let stage = 0;
    const fake = makeFake(() => {
      stage += 1;
      // Order: year lookup, students, existing, immunisations, INSERT.
      if (stage === 1) return []; // year
      if (stage === 2) return [{ id: 'stu-1', grade_level: 'K' }];
      if (stage === 3) return []; // existing
      if (stage === 4) return []; // immunisations
      return [];
    });
    const requirements = {
      loadActiveForCompute: async () => [],
    };
    const kafka = { emit: async () => undefined };
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      requirements as never,
      kafka as never,
    );
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.computeForSchool(null),
    );
    expect(out.computed).toBe(1);
    // The INSERT must contain the UPSERT ON CONFLICT clause.
    const upsert = fake.capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into hlth_immunisation_compliance'),
    );
    expect(upsert).toBeDefined();
    expect(upsert!.sql.toLowerCase()).toContain('on conflict');
    expect(upsert!.sql.toLowerCase()).toContain('do update');
  });

  it('computeForSchool emits hlth.immunisation.noncompliant for newly NON_COMPLIANT', async () => {
    let stage = 0;
    const fake = makeFake(() => {
      stage += 1;
      if (stage === 1) return []; // year
      if (stage === 2) return [{ id: 'stu-1', grade_level: 'K' }];
      if (stage === 3) return []; // existing — student NOT previously NON_COMPLIANT
      if (stage === 4) return []; // immunisations — none, all required missing
      return [];
    });
    const requirements = {
      loadActiveForCompute: async () => [
        {
          id: 'req-A',
          school_id: null,
          state_code: 'KS',
          vaccine_name: 'DTaP',
          required_doses: 5,
          required_by_grade: 'K',
          allows_exemption: true,
          exemption_types: null,
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    };
    const emits: { topic: string; sourceModule?: string; payload: unknown }[] = [];
    const kafka = {
      emit: async (opts: { topic: string; sourceModule?: string; payload: unknown }) => {
        emits.push({ topic: opts.topic, sourceModule: opts.sourceModule, payload: opts.payload });
      },
    };
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      requirements as never,
      kafka as never,
    );
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.computeForSchool(null),
    );
    expect(out.newlyNonCompliant).toBe(1);
    // REVIEW-P2C3 BLOCKING #2 — emit fires AFTER tx commits with the
    // exact contract the consumer needs: topic, source module, and a
    // payload that carries the missing-vaccine breakdown so the
    // notification consumer doesn't have to round-trip back to the DB.
    expect(emits.length).toBeGreaterThanOrEqual(1);
    expect(emits[0]!.topic).toBe('hlth.immunisation.noncompliant');
    expect(emits[0]!.sourceModule).toBe('health-advanced');
    const payload = emits[0]!.payload as {
      schoolId: string;
      studentId: string;
      missingVaccines: Array<{ vaccineName: string; dosesRequired: number; dosesReceived: number }>;
      computedAt: string;
    };
    expect(payload.schoolId).toBe(SCHOOL.schoolId);
    expect(payload.studentId).toBe('stu-1');
    expect(payload.missingVaccines).toHaveLength(1);
    expect(payload.missingVaccines[0]!.vaccineName).toBe('DTaP');
    expect(payload.missingVaccines[0]!.dosesRequired).toBe(5);
    expect(payload.missingVaccines[0]!.dosesReceived).toBe(0);
    expect(typeof payload.computedAt).toBe('string');
    expect(Number.isNaN(Date.parse(payload.computedAt))).toBe(false);
  });

  it('computeForSchool preserves existing EXEMPT status across re-runs', async () => {
    let stage = 0;
    const fake = makeFake(() => {
      stage += 1;
      if (stage === 1) return []; // year
      if (stage === 2) return [{ id: 'stu-1', grade_level: 'K' }];
      if (stage === 3)
        return [{ student_id: 'stu-1', status: 'EXEMPT', exemption_type: 'RELIGIOUS' }];
      if (stage === 4) return []; // immunisations
      return [];
    });
    const requirements = {
      loadActiveForCompute: async () => [
        {
          id: 'req-A',
          school_id: null,
          state_code: 'KS',
          vaccine_name: 'DTaP',
          required_doses: 5,
          required_by_grade: 'K',
          allows_exemption: true,
          exemption_types: null,
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    };
    const emits: { topic: string }[] = [];
    const kafka = {
      emit: async (opts: { topic: string }) => {
        emits.push({ topic: opts.topic });
      },
    };
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      requirements as never,
      kafka as never,
    );
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.computeForSchool(null),
    );
    // EXEMPT preserved → NOT counted as newly NON_COMPLIANT.
    expect(out.newlyNonCompliant).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(emits).toHaveLength(0);
    // Verify the UPSERT used status=EXEMPT.
    const upsert = fake.capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into hlth_immunisation_compliance'),
    );
    expect(upsert).toBeDefined();
    expect(upsert!.args[4]).toBe('EXEMPT');
  });

  it('dashboard computes compliance_percent counting EXEMPT as compliant', async () => {
    const fake = makeFake(() => {
      return [
        {
          total: 10,
          compliant: 7,
          non_compliant: 2,
          exempt: 1,
          provisional: 0,
          last_computed_at: '2026-05-09T10:00:00Z',
        },
      ];
    });
    const requirements = { loadActiveForCompute: async () => [] };
    const kafka = { emit: async () => undefined };
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      requirements as never,
      kafka as never,
    );
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.dashboard());
    // (compliant + exempt) / total = 8/10 = 80.0%
    expect(out.compliancePercent).toBe(80);
    expect(out.compliant).toBe(7);
    expect(out.exempt).toBe(1);
  });

  // REVIEW-P2C3 Round 2 BLOCKING — per-student compliance access
  // matrix. The hlt-001:read controller gate is broad (Teacher /
  // Parent / Student / Staff). Service-layer narrowing is the actual
  // access boundary: GUARDIAN linked-only, STUDENT self-only, STAFF
  // requires HLT-007 (immunisation compliance), admin bypasses.
  function makeComplianceFake(opts: {
    guardianLinked?: boolean;
    studentSelf?: boolean;
    hasHlt007?: boolean;
  }) {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_student_guardians')) {
        return opts.guardianLinked ? [{ '?column?': 1 }] : [];
      }
      if (sql.includes('from sis_students') && sql.includes('platform_students')) {
        return opts.studentSelf ? [{ '?column?': 1 }] : [];
      }
      if (sql.includes('from hlth_immunisation_compliance')) {
        return [
          {
            id: 'cmp-A',
            student_id: 'stu-A',
            student_first: 'Maya',
            student_last: 'Chen',
            student_grade: '5',
            school_id: SCHOOL.schoolId,
            academic_year_id: null,
            status: 'COMPLIANT',
            missing_vaccines: [],
            exemption_type: null,
            exemption_document_s3_key: null,
            last_computed_at: new Date().toISOString(),
            parent_notified_at: null,
          },
        ];
      }
      return [];
    });
    const permissions = {
      hasAnyPermissionInTenant: async (_acc: string, _sch: string, codes: string[]) => {
        if (codes.some((c) => c.startsWith('hlt-007'))) {
          return Boolean(opts.hasHlt007);
        }
        return false;
      },
    };
    return { fake, permissions };
  }

  it('teacher with hlt-001:read but no hlt-007 cannot fetch compliance — 404', async () => {
    const { fake, permissions } = makeComplianceFake({ hasHlt007: false });
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      permissions as never,
      { loadActiveForCompute: async () => [] } as never,
      { emit: async () => undefined } as never,
    );
    const teacher = { ...ACTOR_BASE, personType: 'STAFF' as const, isSchoolAdmin: false };
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.getForStudent('stu-A', teacher as never),
      ),
    ).rejects.toThrow(/Compliance record not found/);
  });

  it('staff with hlt-007:read can fetch any student compliance', async () => {
    const { fake, permissions } = makeComplianceFake({ hasHlt007: true });
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      permissions as never,
      { loadActiveForCompute: async () => [] } as never,
      { emit: async () => undefined } as never,
    );
    const nurse = { ...ACTOR_BASE, personType: 'STAFF' as const, isSchoolAdmin: false };
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getForStudent('stu-A', nurse as never),
    );
    expect(dto.studentId).toBe('stu-A');
  });

  it('guardian linked to the student via sis_student_guardians can fetch', async () => {
    const { fake, permissions } = makeComplianceFake({ guardianLinked: true });
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      permissions as never,
      { loadActiveForCompute: async () => [] } as never,
      { emit: async () => undefined } as never,
    );
    const parent = {
      ...ACTOR_BASE,
      personType: 'GUARDIAN' as const,
      isSchoolAdmin: false,
    };
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getForStudent('stu-A', parent as never),
    );
    expect(dto.studentId).toBe('stu-A');
  });

  it('guardian with no link to the student is rejected — 404', async () => {
    const { fake, permissions } = makeComplianceFake({ guardianLinked: false });
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      permissions as never,
      { loadActiveForCompute: async () => [] } as never,
      { emit: async () => undefined } as never,
    );
    const parent = {
      ...ACTOR_BASE,
      personType: 'GUARDIAN' as const,
      isSchoolAdmin: false,
    };
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.getForStudent('stu-A', parent as never),
      ),
    ).rejects.toThrow(/Compliance record not found/);
  });

  it('student fetching own compliance row is allowed', async () => {
    const { fake, permissions } = makeComplianceFake({ studentSelf: true });
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      permissions as never,
      { loadActiveForCompute: async () => [] } as never,
      { emit: async () => undefined } as never,
    );
    const student = {
      ...ACTOR_BASE,
      personType: 'STUDENT' as const,
      isSchoolAdmin: false,
    };
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getForStudent('stu-A', student as never),
    );
    expect(dto.studentId).toBe('stu-A');
  });

  it('student fetching another student is rejected — 404', async () => {
    const { fake, permissions } = makeComplianceFake({ studentSelf: false });
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      permissions as never,
      { loadActiveForCompute: async () => [] } as never,
      { emit: async () => undefined } as never,
    );
    const student = {
      ...ACTOR_BASE,
      personType: 'STUDENT' as const,
      isSchoolAdmin: false,
    };
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.getForStudent('stu-A', student as never),
      ),
    ).rejects.toThrow(/Compliance record not found/);
  });

  it('school admin bypasses both relationship and HLT-007 gates', async () => {
    const { fake, permissions } = makeComplianceFake({
      guardianLinked: false,
      studentSelf: false,
      hasHlt007: false,
    });
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      permissions as never,
      { loadActiveForCompute: async () => [] } as never,
      { emit: async () => undefined } as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.getForStudent('stu-A', ADMIN_ACTOR),
    );
    expect(dto.studentId).toBe('stu-A');
  });
});

describe('ScreeningReferralService — FOLLOW_UP_COMPLETE precondition', () => {
  it('patch rejects FOLLOW_UP_COMPLETE without follow_up_date or outcome', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [{ id: 'ref-A', status: 'REFERRED', follow_up_date: null, follow_up_outcome: null }];
      }
      return [];
    });
    const svc = new ScreeningReferralService(fake.tenantPrisma as never, fake.permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.patch('ref-A', { status: 'FOLLOW_UP_COMPLETE' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/FOLLOW_UP_COMPLETE requires/);
  });

  it('patch accepts FOLLOW_UP_COMPLETE when both date + outcome are supplied', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      if (stage === 1) {
        return [
          {
            id: 'ref-A',
            status: 'REFERRED',
            follow_up_date: '2026-06-01',
            follow_up_outcome: null,
          },
        ];
      }
      if (c.sql.toLowerCase().includes('from hlth_screening_referrals r')) {
        return [
          {
            id: 'ref-A',
            screening_id: 'scr-A',
            student_id: 'stu-A',
            student_first: 'Maya',
            student_last: 'Chen',
            school_id: SCHOOL.schoolId,
            referral_type: 'VISION',
            reason: 'right eye 20/40',
            referred_to: null,
            referral_date: '2026-05-01',
            follow_up_date: '2026-06-01',
            follow_up_outcome: 'GLASSES_PRESCRIBED',
            follow_up_notes: null,
            status: 'FOLLOW_UP_COMPLETE',
            created_by: 'usr-A',
            created_by_first: 'Marcus',
            created_by_last: 'Hayes',
            created_at: '2026-05-01T10:00:00Z',
            updated_at: '2026-05-09T10:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ScreeningReferralService(fake.tenantPrisma as never, fake.permissions as never);
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch(
        'ref-A',
        { status: 'FOLLOW_UP_COMPLETE', followUpOutcome: 'GLASSES_PRESCRIBED' },
        ADMIN_ACTOR,
      ),
    );
    expect(out.status).toBe('FOLLOW_UP_COMPLETE');
    expect(out.followUpOutcome).toBe('GLASSES_PRESCRIBED');
  });

  it('overdue() emits a partial-index seek query (status=REFERRED + past follow_up_date)', async () => {
    const fake = makeFake(() => []);
    const svc = new ScreeningReferralService(fake.tenantPrisma as never, fake.permissions as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.overdue());
    expect(fake.capture).toHaveLength(1);
    const sql = fake.capture[0]!.sql.toLowerCase();
    expect(sql).toContain("status = 'referred'");
    expect(sql).toContain('follow_up_date < current_date');
  });
});

// REVIEW-P2C3 BLOCKING #1 — controller-level permission gate.
// Asserts the @RequirePermission metadata each compliance endpoint
// carries so future renames cannot silently fall back to hlt-001:read
// (held by Parent / Student / Teacher) for school-wide reads.
describe('HealthAdvancedController — compliance permission gate', () => {
  const proto = HealthAdvancedController.prototype as unknown as Record<string, () => unknown>;

  function gateFor(methodName: string): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) ?? [];
  }

  it('school-wide list/dashboard/report/run are gated on hlt-007', () => {
    expect(gateFor('listCompliance')).toEqual(['hlt-007:read']);
    expect(gateFor('complianceDashboard')).toEqual(['hlt-007:read']);
    expect(gateFor('complianceReport')).toEqual(['hlt-007:read']);
    expect(gateFor('runCompliance')).toEqual(['hlt-007:admin']);
  });

  it('per-student getForStudent stays on hlt-001:read with relationship enforcement', () => {
    // The narrower per-student endpoint can keep hlt-001:read because
    // ImmunisationComplianceService.getForStudent enforces guardian /
    // self relationship for non-admin actors.
    expect(gateFor('getComplianceForStudent')).toEqual(['hlt-001:read']);
  });
});

describe('CSV report keystone — state submission format', () => {
  it('stateReportCsv emits the seven required columns + at least one student row per applicable vaccine', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      // dashboard call(s) are not used by stateReportCsv directly — the
      // service uses requirements.loadActiveForCompute (stub) + list().
      // List returns one COMPLIANT student.
      if (c.sql.toLowerCase().includes('from hlth_immunisation_compliance c')) {
        return [
          {
            id: 'comp-A',
            student_id: 'stu-A',
            student_first: 'Maya',
            student_last: 'Chen',
            student_grade: 'K',
            school_id: SCHOOL.schoolId,
            academic_year_id: null,
            status: 'COMPLIANT',
            missing_vaccines: [],
            exemption_type: null,
            exemption_document_s3_key: null,
            last_computed_at: '2026-05-09T10:00:00Z',
            parent_notified_at: null,
          },
        ];
      }
      return [];
    });
    const requirements = {
      loadActiveForCompute: async () => [
        {
          id: 'req-A',
          school_id: null,
          state_code: 'KS',
          vaccine_name: 'DTaP',
          required_doses: 5,
          required_by_grade: 'K',
          allows_exemption: true,
          exemption_types: null,
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    };
    const kafka = { emit: async () => undefined };
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      requirements as never,
      kafka as never,
    );
    const csv = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.stateReportCsv());
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'student_state_id,grade_level,vaccine_name,doses_required,doses_received,compliance_status,exemption_type',
    );
    // One COMPLIANT student × one applicable vaccine = 1 data row.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('stu-A');
    expect(lines[1]).toContain('DTaP');
    expect(lines[1]).toContain('COMPLIANT');
  });

  it('NON_COMPLIANT emits one row per missing vaccine', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('from hlth_immunisation_compliance c')) {
        return [
          {
            id: 'comp-B',
            student_id: 'stu-B',
            student_first: 'Ethan',
            student_last: 'Rodriguez',
            student_grade: 'K',
            school_id: SCHOOL.schoolId,
            academic_year_id: null,
            status: 'NON_COMPLIANT',
            missing_vaccines: [
              { vaccine_name: 'MMR', doses_received: 1, doses_required: 2 },
              { vaccine_name: 'Varicella', doses_received: 1, doses_required: 2 },
            ],
            exemption_type: null,
            exemption_document_s3_key: null,
            last_computed_at: '2026-05-09T10:00:00Z',
            parent_notified_at: null,
          },
        ];
      }
      return [];
    });
    const requirements = { loadActiveForCompute: async () => [] };
    const kafka = { emit: async () => undefined };
    const svc = new ImmunisationComplianceService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      requirements as never,
      kafka as never,
    );
    const csv = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.stateReportCsv());
    const lines = csv.trimEnd().split('\n');
    // header + 2 missing vaccines
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('MMR');
    expect(lines[2]).toContain('Varicella');
    expect(lines[1]).toContain('NON_COMPLIANT');
  });
});
