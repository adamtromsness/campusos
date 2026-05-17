import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantAccessService, rowToGrantDto } from '../services/tenant-access.service';
import { OutboxService } from '@shared/kafka';

/**
 * P2-21b — TenantAccessService.grant prerequisite gates.
 *
 * Tests target the service-layer state machine:
 *  - approver != requester
 *  - approver holds INTERNAL_ADMIN ops_permissions scope
 *  - justification length >= 20 after trim
 *  - durationHours bounded 1..4
 *  - emits ops.tenant_access.granted on success
 *  - schema CHECKs (duration_chk, justification_chk, window_chk)
 *    translated to friendly 400s when the DB raises 23514.
 */

interface GrantRow {
  id: string;
  employee_id: string;
  tenant_schema: string;
  justification: string;
  access_type: string;
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  approved_by: string;
}

function makeStub(opts: {
  employeeExists?: boolean;
  approverExists?: boolean;
  approverHasInternalAdmin?: boolean;
  insertError?: { message: string };
}): {
  prisma: any;
  emits: Array<{ topic: string; payload: any; sourceModule: string }>;
  inserts: Array<{ sql: string; params: unknown[] }>;
  updates: Array<{ sql: string; params: unknown[] }>;
} {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const emits: Array<{ topic: string; payload: any; sourceModule: string; eventId?: string }> = [];
  let lastInsertedRow: GrantRow | null = null;

  const queryRawUnsafe = async (sql: string, ...params: unknown[]) => {
    if (sql.includes('FROM platform.ops_employees') && sql.includes('WHERE id')) {
      const id = params[0] as string;
      if (id === 'emp-requester' && opts.employeeExists !== false) {
        return [
          {
            id,
            person_id: 'p1',
            department: 'ENGINEERING',
            role: 'eng',
            hire_date: '2026-01-01',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (id === 'emp-approver' && opts.approverExists !== false) {
        return [
          {
            id,
            person_id: 'p2',
            department: 'OPERATIONS',
            role: 'admin',
            hire_date: '2026-01-01',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    }
    if (sql.includes('FROM platform.ops_permissions')) {
      return [{ count: opts.approverHasInternalAdmin ? 1 : 0 }];
    }
    if (sql.includes('FROM platform.ops_tenant_access_grants') && sql.includes('WHERE id')) {
      return lastInsertedRow ? [lastInsertedRow] : [];
    }
    return [];
  };

  const executeRawUnsafe = async (sql: string, ...params: unknown[]) => {
    if (sql.includes('INSERT INTO platform.ops_tenant_access_grants')) {
      if (opts.insertError) throw opts.insertError;
      inserts.push({ sql, params });
      const hours = Number(params[5] as string);
      const grantedAt = new Date();
      lastInsertedRow = {
        id: params[0] as string,
        employee_id: params[1] as string,
        tenant_schema: params[2] as string,
        justification: params[3] as string,
        access_type: params[4] as string,
        granted_at: grantedAt,
        expires_at: new Date(grantedAt.getTime() + hours * 3600_000),
        revoked_at: null,
        approved_by: params[6] as string,
      };
      return 1;
    }
    // REVIEW-P2C21 BLOCKING 1 — capture outbox INSERTs so the existing
    // tests' `emits` assertions keep working against the new outbox
    // pathway (the production code now writes via OutboxService.enqueueInTx
    // INSIDE the same tx as the grant INSERT).
    if (sql.includes('INSERT INTO platform.platform_outbox')) {
      try {
        const envelope = JSON.parse(params[2] as string);
        emits.push({
          topic: params[1] as string,
          payload: envelope.payload,
          sourceModule: params[5] as string,
          eventId: envelope.event_id,
        });
      } catch {
        // ignore — outbox shape regression handled by other tests
      }
      return 1;
    }
    if (sql.includes('UPDATE platform.ops_tenant_access_grants')) {
      updates.push({ sql, params });
      return 1;
    }
    return 0;
  };

  const prisma = {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
    // REVIEW-P2C21 BLOCKING 1 — grant() wraps INSERT + outbox enqueue
    // in one Prisma $transaction so a broker outage cannot lose the
    // audit event.
    $transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
      fn({
        $queryRawUnsafe: queryRawUnsafe,
        $executeRawUnsafe: executeRawUnsafe,
      }),
  };

  return { prisma, emits, inserts, updates };
}

// REVIEW-P2C21 BLOCKING 1 — production now uses OutboxService instead
// of KafkaProducerService. The OutboxService writes via the tx's
// $executeRawUnsafe; the stub captures that via the INSERT INTO
// platform_outbox handler above.
function makeOutbox(): OutboxService {
  return new OutboxService();
}

function makeEmployeeStub(stub: ReturnType<typeof makeStub>): any {
  return {
    loadOrFail: async (id: string) => {
      const rows = (await stub.prisma.$queryRawUnsafe(
        'SELECT id FROM platform.ops_employees WHERE id = $1',
        id,
      )) as unknown[];
      if (rows.length === 0) {
        throw new NotFoundException(`ops_employees ${id} not found.`);
      }
    },
    hasScope: async (id: string, scope: string) => {
      const rows = (await stub.prisma.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS count FROM platform.ops_permissions WHERE employee_id = $1 AND scope = $2',
        id,
        scope,
      )) as Array<{ count: number }>;
      return (rows[0]?.count ?? 0) > 0;
    },
  };
}

describe('TenantAccessService.grant', () => {
  it('rejects self-approval (approver === requester) with 403', async () => {
    const stub = makeStub({ approverHasInternalAdmin: true });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-requester',
        tenantSchema: 'tenant_demo',
        justification: 'A valid 20 plus character justification text',
        accessType: 'READ_ONLY',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when approver lacks INTERNAL_ADMIN scope', async () => {
    const stub = makeStub({ approverHasInternalAdmin: false });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-approver',
        tenantSchema: 'tenant_demo',
        justification: 'A valid 20 plus character justification text',
        accessType: 'READ_ONLY',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects justification < 20 chars with 400', async () => {
    const stub = makeStub({ approverHasInternalAdmin: true });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-approver',
        tenantSchema: 'tenant_demo',
        justification: 'too short',
        accessType: 'READ_ONLY',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects whitespace-padded justification that is < 20 chars after trim', async () => {
    const stub = makeStub({ approverHasInternalAdmin: true });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-approver',
        tenantSchema: 'tenant_demo',
        justification: '          short          ',
        accessType: 'READ_ONLY',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects durationHours > 4 with 400', async () => {
    const stub = makeStub({ approverHasInternalAdmin: true });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-approver',
        tenantSchema: 'tenant_demo',
        justification: 'A valid 20 plus character justification text',
        accessType: 'READ_ONLY',
        durationHours: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects durationHours < 1 with 400', async () => {
    const stub = makeStub({ approverHasInternalAdmin: true });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-approver',
        tenantSchema: 'tenant_demo',
        justification: 'A valid 20 plus character justification text',
        accessType: 'READ_ONLY',
        durationHours: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('happy path — 3-hour READ_ONLY grant succeeds + emits ops.tenant_access.granted', async () => {
    const stub = makeStub({ approverHasInternalAdmin: true });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    const dto = await svc.grant({
      employeeId: 'emp-requester',
      approvedBy: 'emp-approver',
      tenantSchema: 'tenant_demo',
      justification: 'Investigating data import issue with full context',
      accessType: 'READ_ONLY',
      durationHours: 3,
    });
    expect(dto.tenantSchema).toBe('tenant_demo');
    expect(dto.accessType).toBe('READ_ONLY');
    expect(dto.isActive).toBe(true);
    expect(dto.remainingMinutes).toBeGreaterThan(170);
    expect(stub.emits.length).toBe(1);
    expect(stub.emits[0]!.topic).toBe('ops.tenant_access.granted');
    expect(stub.emits[0]!.sourceModule).toBe('ops');
    expect(stub.emits[0]!.payload.employeeId).toBe('emp-requester');
    expect(stub.emits[0]!.payload.tenantSchema).toBe('tenant_demo');
    expect(stub.emits[0]!.payload.approvedBy).toBe('emp-approver');
  });

  it('passes durationHours through to the INSERT as $6 (interval string)', async () => {
    const stub = makeStub({ approverHasInternalAdmin: true });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await svc.grant({
      employeeId: 'emp-requester',
      approvedBy: 'emp-approver',
      tenantSchema: 'tenant_demo',
      justification: 'Investigating data import issue with full context',
      accessType: 'READ_WRITE',
      durationHours: 4,
    });
    expect(stub.inserts.length).toBe(1);
    const ins = stub.inserts[0]!;
    expect(ins.sql).toContain("now() + ($6 || ' hours')::interval");
    expect(ins.params[5]).toBe('4');
  });

  it('translates schema duration_chk violation to 400 with hint', async () => {
    const stub = makeStub({
      approverHasInternalAdmin: true,
      insertError: {
        message:
          'new row for relation "ops_tenant_access_grants" violates check constraint "ops_tenant_access_grants_duration_chk"',
      },
    });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-approver',
        tenantSchema: 'tenant_demo',
        justification: 'Investigating data import issue with full context',
        accessType: 'READ_ONLY',
        durationHours: 4,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('translates schema justification_chk violation to 400', async () => {
    const stub = makeStub({
      approverHasInternalAdmin: true,
      insertError: {
        message:
          'new row for relation "ops_tenant_access_grants" violates check constraint "ops_tenant_access_grants_justification_chk"',
      },
    });
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    await expect(
      svc.grant({
        employeeId: 'emp-requester',
        approvedBy: 'emp-approver',
        tenantSchema: 'tenant_demo',
        justification: 'A valid-looking 30+ character justification text',
        accessType: 'READ_ONLY',
        durationHours: 4,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TenantAccessService — DTO mapper isActive + remainingMinutes', () => {
  it('reports isActive=true with remaining minutes for a future expiry', () => {
    const grantedAt = new Date();
    const expiresAt = new Date(grantedAt.getTime() + 2 * 3600_000); // +2h
    const dto = rowToGrantDto({
      id: 'g1',
      employee_id: 'emp',
      tenant_schema: 'tenant_demo',
      justification: 'A valid-looking 30+ character justification text',
      access_type: 'READ_ONLY',
      granted_at: grantedAt,
      expires_at: expiresAt,
      revoked_at: null,
      approved_by: 'approver',
    });
    expect(dto.isActive).toBe(true);
    expect(dto.remainingMinutes).toBeGreaterThan(100);
  });

  it('reports isActive=false when revoked', () => {
    const grantedAt = new Date();
    const dto = rowToGrantDto({
      id: 'g1',
      employee_id: 'emp',
      tenant_schema: 'tenant_demo',
      justification: 'A valid-looking 30+ character justification text',
      access_type: 'READ_ONLY',
      granted_at: grantedAt,
      expires_at: new Date(grantedAt.getTime() + 3600_000),
      revoked_at: new Date(),
      approved_by: 'approver',
    });
    expect(dto.isActive).toBe(false);
    expect(dto.remainingMinutes).toBe(0);
  });

  it('reports isActive=false when expired', () => {
    const past = new Date(Date.now() - 3600_000);
    const dto = rowToGrantDto({
      id: 'g1',
      employee_id: 'emp',
      tenant_schema: 'tenant_demo',
      justification: 'A valid-looking 30+ character justification text',
      access_type: 'READ_ONLY',
      granted_at: new Date(past.getTime() - 3600_000),
      expires_at: past,
      revoked_at: null,
      approved_by: 'approver',
    });
    expect(dto.isActive).toBe(false);
    expect(dto.remainingMinutes).toBe(0);
  });
});

describe('TenantAccessService.revoke', () => {
  it('is idempotent — calling on already-revoked row returns the same row', async () => {
    const stub = makeStub({});
    // Pre-load a revoked row
    const revokedRow: GrantRow = {
      id: 'g1',
      employee_id: 'emp',
      tenant_schema: 'tenant_demo',
      justification: 'A valid-looking 30+ character justification text',
      access_type: 'READ_ONLY',
      granted_at: new Date(),
      expires_at: new Date(Date.now() + 3600_000),
      revoked_at: new Date(),
      approved_by: 'approver',
    };
    // Override $queryRawUnsafe to return the revoked row for the load
    stub.prisma.$queryRawUnsafe = async (sql: string) => {
      if (sql.includes('FROM platform.ops_employees')) {
        return [{ id: 'emp' }];
      }
      return [revokedRow];
    };
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    const dto = await svc.revoke('g1', 'emp');
    expect(dto.revokedAt).not.toBeNull();
    // No UPDATE issued — the service short-circuits on already-revoked.
    expect(stub.updates.length).toBe(0);
  });
});

describe('TenantAccessService.sweepExpired', () => {
  it('runs the canonical sweep UPDATE', async () => {
    const stub = makeStub({});
    let capturedSql = '';
    stub.prisma.$executeRawUnsafe = async (sql: string) => {
      capturedSql = sql;
      return 3;
    };
    const svc = new TenantAccessService(stub.prisma, makeOutbox(), makeEmployeeStub(stub));
    const count = await svc.sweepExpired();
    expect(count).toBe(3);
    expect(capturedSql).toContain('UPDATE platform.ops_tenant_access_grants');
    expect(capturedSql).toContain('SET revoked_at = now()');
    expect(capturedSql).toContain('WHERE revoked_at IS NULL AND expires_at < now()');
  });
});
