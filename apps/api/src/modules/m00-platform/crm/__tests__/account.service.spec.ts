import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AccountService, assertTransitionAllowed } from '../services/account.service';
import { OutboxService } from '@shared/kafka/outbox.service';

/**
 * P2-21a — AccountService.transitionStatus + lifecycle gate tests.
 *
 * Tests target the service-layer state machine: which transitions
 * are allowed, and which require prerequisite conditions
 * (signed_date for PROSPECT > PILOT and PILOT > ONBOARDING;
 * onboarding checklist COMPLETED for ONBOARDING > ACTIVE).
 *
 * Uses a stub PrismaClient that records SQL strings and returns
 * synthetic rows.
 */

interface AccountRowState {
  id: string;
  school_id: string | null;
  organisation_id: string | null;
  account_name: string;
  pricing_band_id: string | null;
  status: string;
  billing_email: string;
  billing_address_json: Record<string, unknown> | null;
  stripe_customer_id: string | null;
  school_champion_person_id: string | null;
  signed_date: string | null;
  go_live_date: string | null;
  renewal_date: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StubState {
  account: AccountRowState;
  checklistStatus: string | null;
}

function newStub(initial: Partial<AccountRowState>): {
  state: StubState;
  prisma: any;
  emits: Array<{ topic: string; payload: any }>;
} {
  const state: StubState = {
    account: {
      id: 'acct-1',
      school_id: '019dff45-1234-7000-8000-000000000001',
      organisation_id: null,
      account_name: 'Test Co',
      pricing_band_id: null,
      status: 'PROSPECT',
      billing_email: 'billing@test.co',
      billing_address_json: null,
      stripe_customer_id: null,
      school_champion_person_id: null,
      signed_date: null,
      go_live_date: null,
      renewal_date: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...initial,
    },
    checklistStatus: null,
  };

  const emits: Array<{ topic: string; payload: any; eventId?: string }> = [];

  const queryRawUnsafe = async (sql: string, ..._params: unknown[]) => {
    if (sql.includes('FROM platform.crm_onboarding_checklists') && sql.includes('LIMIT 1')) {
      return state.checklistStatus ? [{ status: state.checklistStatus }] : [];
    }
    if (sql.includes('FROM platform.crm_accounts') && sql.includes('WHERE id')) {
      return [state.account];
    }
    return [];
  };
  const executeRawUnsafe = async (sql: string, ...params: unknown[]) => {
    if (sql.includes('UPDATE platform.crm_accounts SET status =')) {
      state.account.status = params[0] as string;
    }
    if (sql.includes("SET status = 'ACTIVE'")) {
      state.account.status = 'ACTIVE';
    }
    // The OutboxService writes via $executeRawUnsafe — the stub captures it.
    if (sql.includes('INSERT INTO platform.platform_outbox')) {
      const envelope = JSON.parse(params[2] as string);
      emits.push({
        topic: params[1] as string,
        payload: envelope.payload,
        eventId: envelope.event_id,
      });
    }
    return 1;
  };

  const prisma = {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
    // REVIEW-P2C21 BLOCKING 1 — transitionStatus + autoFlip now wrap
    // the UPDATE + outbox enqueue in a single $transaction. The stub
    // invokes the callback with a tx client that proxies through to
    // the same queryRawUnsafe/executeRawUnsafe so the captured state
    // is consistent with how the production code path mutates rows.
    $transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      return fn({
        $queryRawUnsafe: queryRawUnsafe,
        $executeRawUnsafe: executeRawUnsafe,
      });
    },
  };

  // OutboxService is what the production code calls — but for the
  // existing tests we expose an `emits` array shaped like the legacy
  // KafkaProducerService spy. The actual outbox writes are captured
  // via the $executeRawUnsafe INSERT INTO platform.platform_outbox
  // path above.
  return { state, prisma, emits } as any;
}

// Construct the OutboxService stub used by the new AccountService
// constructor signature. The stub mirrors the real OutboxService API
// — enqueueInTx writes to the tx client's $executeRawUnsafe.
function makeOutboxStub(): OutboxService {
  return new OutboxService();
}

describe('AccountService — transition graph (assertTransitionAllowed)', () => {
  it('allows PROSPECT > PILOT', () => {
    expect(() => assertTransitionAllowed('PROSPECT', 'PILOT')).not.toThrow();
  });
  it('rejects PROSPECT > ACTIVE (skipping PILOT + ONBOARDING)', () => {
    expect(() => assertTransitionAllowed('PROSPECT', 'ACTIVE')).toThrow(BadRequestException);
  });
  it('allows PILOT > ONBOARDING', () => {
    expect(() => assertTransitionAllowed('PILOT', 'ONBOARDING')).not.toThrow();
  });
  it('allows ONBOARDING > ACTIVE', () => {
    expect(() => assertTransitionAllowed('ONBOARDING', 'ACTIVE')).not.toThrow();
  });
  it('allows ACTIVE > CHURNED', () => {
    expect(() => assertTransitionAllowed('ACTIVE', 'CHURNED')).not.toThrow();
  });
  it('rejects ACTIVE > PILOT (no demotion to pre-sales)', () => {
    expect(() => assertTransitionAllowed('ACTIVE', 'PILOT')).toThrow(BadRequestException);
  });
  it('allows SUSPENDED > any previous state', () => {
    expect(() => assertTransitionAllowed('SUSPENDED', 'PROSPECT')).not.toThrow();
    expect(() => assertTransitionAllowed('SUSPENDED', 'ACTIVE')).not.toThrow();
  });
});

describe('AccountService.transitionStatus — prerequisite gates', () => {
  it('PROSPECT > PILOT requires signed_date', async () => {
    const { prisma } = newStub({ status: 'PROSPECT', signed_date: null }) as any;
    const svc = new AccountService(prisma, makeOutboxStub());
    await expect(svc.transitionStatus('acct-1', 'PILOT')).rejects.toThrow(ConflictException);
  });

  it('PROSPECT > PILOT succeeds when signed_date populated', async () => {
    const { prisma, state } = newStub({ status: 'PROSPECT', signed_date: '2026-01-01' }) as any;
    const emits: Array<unknown> = [];
    const svc = new AccountService(prisma, makeOutboxStub());
    const updated = await svc.transitionStatus('acct-1', 'PILOT');
    expect(updated.status).toBe('PILOT');
    expect(state.account.status).toBe('PILOT');
  });

  it('ONBOARDING > ACTIVE requires checklist COMPLETED', async () => {
    const stub = newStub({ status: 'ONBOARDING', signed_date: '2026-01-01' }) as any;
    stub.state.checklistStatus = 'IN_PROGRESS';
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    await expect(svc.transitionStatus('acct-1', 'ACTIVE')).rejects.toThrow(ConflictException);
  });

  it('ONBOARDING > ACTIVE succeeds when checklist COMPLETED', async () => {
    const stub = newStub({ status: 'ONBOARDING', signed_date: '2026-01-01' }) as any;
    stub.state.checklistStatus = 'COMPLETED';
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    const updated = await svc.transitionStatus('acct-1', 'ACTIVE');
    expect(updated.status).toBe('ACTIVE');
  });

  // REVIEW-P2C21 BLOCKING 1 — lifecycle event lands via the platform
  // outbox now, captured by the stub's INSERT INTO platform_outbox path
  // (stub.emits).
  it('emits crm.account.lifecycle_changed on flip (via platform outbox)', async () => {
    const stub = newStub({ status: 'PROSPECT', signed_date: '2026-01-01' }) as any;
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    await svc.transitionStatus('acct-1', 'PILOT');
    expect(stub.emits.length).toBe(1);
    expect(stub.emits[0]!.topic).toBe('crm.account.lifecycle_changed');
    expect(stub.emits[0]!.payload.fromStatus).toBe('PROSPECT');
    expect(stub.emits[0]!.payload.toStatus).toBe('PILOT');
    expect(stub.emits[0]!.payload.schoolId).toBe(stub.state.account.school_id);
    // Deterministic event_id — keyed on (accountId, toStatus).
    expect(stub.emits[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('skips emit for org-only accounts (no schoolId)', async () => {
    const stub = newStub({
      status: 'PROSPECT',
      signed_date: '2026-01-01',
      school_id: null,
      organisation_id: '019dff45-1234-7000-8000-000000000099',
    }) as any;
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    await svc.transitionStatus('acct-1', 'PILOT');
    expect(stub.emits.length).toBe(0);
  });

  it('autoFlipOnOnboardingComplete only fires on ONBOARDING accounts', async () => {
    const stub = newStub({ status: 'PILOT' }) as any;
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    await svc.autoFlipOnOnboardingComplete('acct-1');
    expect(stub.state.account.status).toBe('PILOT');
  });

  it('autoFlipOnOnboardingComplete flips ONBOARDING > ACTIVE (via platform outbox)', async () => {
    const stub = newStub({ status: 'ONBOARDING' }) as any;
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    await svc.autoFlipOnOnboardingComplete('acct-1');
    expect(stub.state.account.status).toBe('ACTIVE');
    expect(stub.emits.length).toBe(1);
    expect(stub.emits[0]!.payload.toStatus).toBe('ACTIVE');
  });

  it('loadOrFail throws NotFound when account missing', async () => {
    const stub = newStub({}) as any;
    stub.prisma.$queryRawUnsafe = async (sql: string) => {
      if (sql.includes('FROM platform.crm_accounts')) return [];
      return [];
    };
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    await expect(svc.loadOrFail('missing-id')).rejects.toThrow(NotFoundException);
  });
});

describe('AccountService.transitionStatus — no-op same-status', () => {
  it('returns existing DTO when status equals current', async () => {
    const stub = newStub({ status: 'ACTIVE' }) as any;
    const svc = new AccountService(stub.prisma, makeOutboxStub());
    const result = await svc.transitionStatus('acct-1', 'ACTIVE');
    expect(result.status).toBe('ACTIVE');
    expect(stub.emits.length).toBe(0);
  });
});
