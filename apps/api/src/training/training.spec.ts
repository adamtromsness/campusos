import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { runWithTenantContext } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { CompletionService } from './completion.service';
import { TrainingProgrammeService } from './programme.service';
import { TrainingEventService } from './event.service';
import { TrainingController } from './training.controller';

const SCHOOL = { schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;
const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;
const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
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

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    },
  };
  return { outbox, enqueued };
}

describe('CompletionService — hr.training.completed outbox emit + auto-issue', () => {
  it('record() enqueues hr.training.completed via OutboxService.enqueueInTx with the documented payload contract', async () => {
    const eventId = '019e0e69-aaaa-7000-8000-0000aaaaaaaa';
    const programmeId = '019e0e69-aaaa-7000-8000-0000bbbbbbbb';
    const employeeId = '019e0e69-aaaa-7000-8000-0000cccccccc';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // event.loadInternalWithProgramme — JOIN events + programmes
      if (
        sql.includes('from hr_training_events e') &&
        sql.includes('join hr_training_programmes p')
      ) {
        return [
          {
            event_id: eventId,
            programme_id: programmeId,
            school_id: SCHOOL.schoolId,
            event_title: 'Safeguarding L1 — Spring',
            is_mandatory: true,
            renewal_months: 12,
          },
        ];
      }
      // employee tenant validation
      if (
        sql.includes('from hr_employees') &&
        sql.includes('school_id') &&
        sql.includes('limit 1')
      ) {
        return [{ id: employeeId }];
      }
      // cert type lookup — return one matching by name
      if (sql.includes('from hr_certification_types') && sql.includes('lower(name)')) {
        return [{ id: 'ct-1' }];
      }
      // existing employee certifications check — none exists yet
      if (sql.includes('from hr_employee_certifications') && sql.includes("status = 'active'")) {
        return [];
      }
      // programme name lookup
      if (sql.includes('select name from hr_training_programmes')) {
        return [{ name: 'Safeguarding Level 1' }];
      }
      // INSERT INTO hr_training_completions
      if (sql.includes('insert into hr_training_completions')) {
        return 1;
      }
      // INSERT INTO hr_employee_certifications (auto-issue)
      if (sql.includes('insert into hr_employee_certifications')) {
        return 1;
      }
      // Final reload
      if (sql.includes('from hr_training_completions c')) {
        return [
          {
            id: 'comp-1',
            event_id: eventId,
            event_title: 'Safeguarding L1 — Spring',
            programme_id: programmeId,
            programme_name: 'Safeguarding Level 1',
            employee_id: employeeId,
            employee_first: 'James',
            employee_last: 'Rivera',
            school_id: SCHOOL.schoolId,
            completed_at: '2026-04-01T00:00:00Z',
            score: '92.00',
            passed: true,
            notes: null,
            created_at: '2026-04-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox, enqueued } = makeOutbox();
    const programmes = new TrainingProgrammeService(
      fake.tenantPrisma as never,
      permissions as never,
    );
    const events = new TrainingEventService(fake.tenantPrisma as never, permissions as never);
    const svc = new CompletionService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
      events,
    );
    void programmes;
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.record(
        eventId,
        { employeeId, completedAt: '2026-04-01T00:00:00Z', score: 92 },
        ADMIN_ACTOR,
      ),
    );
    expect(dto.passed).toBe(true);
    expect(dto.score).toBe(92);

    // Outbox enqueue carries the documented payload contract.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('hr.training.completed');
    expect(enqueued[0]!.sourceModule).toBe('hr-training');
    const payload = enqueued[0]!.payload;
    expect(payload.eventId).toBe(eventId);
    expect(payload.programmeId).toBe(programmeId);
    expect(payload.employeeId).toBe(employeeId);
    expect(payload.schoolId).toBe(SCHOOL.schoolId);
    expect(payload.score).toBe(92);
    expect(payload.passed).toBe(true);
    // AUTO-ISSUE keystone — the auto-issued cert id is on the
    // payload. The hr_employee_certifications INSERT also fired.
    expect(payload.autoIssuedCertificationId).toBeTruthy();
    const certInsert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into hr_employee_certifications'),
    );
    expect(certInsert).toBeTruthy();
  });

  it('record() rejects duplicate completion via friendly UNIQUE catch', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('from hr_training_events e') &&
        sql.includes('join hr_training_programmes p')
      ) {
        return [
          {
            event_id: 'ev-1',
            programme_id: 'pg-1',
            school_id: SCHOOL.schoolId,
            event_title: 'X',
            is_mandatory: false,
            renewal_months: null,
          },
        ];
      }
      if (
        sql.includes('from hr_employees') &&
        sql.includes('school_id') &&
        sql.includes('limit 1')
      ) {
        return [{ id: 'emp-1' }];
      }
      if (sql.includes('insert into hr_training_completions')) {
        const err = new Error('unique_violation') as any;
        err.code = 'P2010';
        err.meta = { code: '23505' };
        throw err;
      }
      return [];
    });
    const permissions = { hasAnyPermissionInTenant: async () => true };
    const { outbox } = makeOutbox();
    const events = new TrainingEventService(fake.tenantPrisma as never, permissions as never);
    const svc = new CompletionService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
      events,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.record('ev-1', { employeeId: 'emp-1' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/already been recorded/);
  });

  it('non-admin without hr-004:write is rejected with Forbidden on record()', async () => {
    const fake = makeFake(() => []);
    const permissions = { hasAnyPermissionInTenant: async () => false };
    const { outbox } = makeOutbox();
    const events = new TrainingEventService(fake.tenantPrisma as never, permissions as never);
    const svc = new CompletionService(
      fake.tenantPrisma as never,
      permissions as never,
      outbox as never,
      events,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.record('ev-1', { employeeId: 'emp-1' }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TrainingController — permission gate distribution', () => {
  const proto = TrainingController.prototype as unknown as Record<string, () => unknown>;
  function gateFor(methodName: string): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) ?? [];
  }
  it('admin reads on hr-004:read; admin writes on hr-004:write', () => {
    expect(gateFor('listProgrammes')).toEqual(['hr-004:read']);
    expect(gateFor('createProgramme')).toEqual(['hr-004:write']);
    expect(gateFor('listEvents')).toEqual(['hr-004:read']);
    expect(gateFor('createEvent')).toEqual(['hr-004:write']);
    expect(gateFor('recordCompletion')).toEqual(['hr-004:write']);
    expect(gateFor('createCertType')).toEqual(['hr-004:write']);
    expect(gateFor('listExpiring')).toEqual(['hr-004:read']);
    expect(gateFor('createEmployeeCertification')).toEqual(['hr-004:write']);
    expect(gateFor('revokeEmployeeCertification')).toEqual(['hr-004:write']);
  });
});
