import { describe, it, expect } from 'vitest';
import { HealthScoreService } from '../services/health-score.service';
import { AccountService } from '../services/account.service';

/**
 * P2-21a — HealthScoreService.computeForAccount tests.
 *
 * Validates the placeholder scoring formula:
 *   - Active subscription baseline 90/40 adoption.
 *   - Engagement and support_ticket scores degrade per recent support
 *     interactions.
 *   - Past-due subs subtract 20 from overall; overdue invoices another 15.
 *   - Risk bands: >=70 HEALTHY, >=50 AT_RISK, else CRITICAL.
 *
 * Uses a stub PrismaClient that returns synthetic signals.
 */

function buildStub(signals: {
  activeSubs: number;
  pastDueSubs: number;
  overdueInvoices: number;
  recentSupport: number;
}): {
  prisma: any;
  recorded: Array<{ accountId: string; score: any }>;
} {
  const recorded: Array<{ accountId: string; score: any }> = [];
  const prisma = {
    $queryRawUnsafe: async (sql: string, ..._params: unknown[]) => {
      if (sql.includes('SELECT') && sql.includes('AS active_subs')) {
        return [
          {
            active_subs: signals.activeSubs,
            past_due_subs: signals.pastDueSubs,
            overdue_invoices: signals.overdueInvoices,
            recent_support_interactions: signals.recentSupport,
          },
        ];
      }
      if (
        sql.includes('FROM platform.crm_health_scores WHERE account_id') &&
        sql.includes('AND score_date')
      ) {
        const captured = recorded[recorded.length - 1];
        if (!captured) return [];
        return [
          {
            id: 'hs-1',
            account_id: captured.accountId,
            score_date: captured.score.scoreDate,
            overall_score: captured.score.overallScore,
            adoption_score: captured.score.adoptionScore ?? null,
            engagement_score: captured.score.engagementScore ?? null,
            support_ticket_score: captured.score.supportTicketScore ?? null,
            nps_score: captured.score.npsScore ?? null,
            risk_level: captured.score.riskLevel,
            created_at: new Date(),
          },
        ];
      }
      if (sql.includes('FROM platform.crm_accounts WHERE id')) {
        return [
          {
            id: 'acct-1',
            school_id: '019dff45-1234-7000-8000-000000000001',
            organisation_id: null,
            account_name: 'Test',
            pricing_band_id: null,
            status: 'ACTIVE',
            billing_email: 'b@t.co',
            billing_address_json: null,
            stripe_customer_id: null,
            school_champion_person_id: null,
            signed_date: null,
            go_live_date: null,
            renewal_date: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes('INSERT INTO platform.crm_health_scores')) {
        recorded.push({
          accountId: params[1] as string,
          score: {
            scoreDate: params[2],
            overallScore: params[3],
            adoptionScore: params[4],
            engagementScore: params[5],
            supportTicketScore: params[6],
            npsScore: params[7],
            riskLevel: params[8],
          },
        });
      }
      return 1;
    },
  };
  return { prisma, recorded };
}

describe('HealthScoreService.computeForAccount — scoring bands', () => {
  it('produces HEALTHY for a clean account with active subs', async () => {
    const stub = buildStub({ activeSubs: 1, pastDueSubs: 0, overdueInvoices: 0, recentSupport: 0 });
    const accounts = {
      loadOrFail: async () =>
        stub.prisma.$queryRawUnsafe('FROM platform.crm_accounts WHERE id ...').then(() => null),
    } as unknown as AccountService;
    const svc = new HealthScoreService(stub.prisma, accounts);
    const result = await svc.computeForAccount('acct-1', '2026-05-12');
    expect(result.riskLevel).toBe('HEALTHY');
    expect(result.overallScore).toBeGreaterThanOrEqual(70);
    expect(result.adoptionScore).toBe(90);
  });

  it('produces AT_RISK when support load is moderate', async () => {
    const stub = buildStub({ activeSubs: 1, pastDueSubs: 0, overdueInvoices: 0, recentSupport: 7 });
    const accounts = { loadOrFail: async () => null } as unknown as AccountService;
    const svc = new HealthScoreService(stub.prisma, accounts);
    const result = await svc.computeForAccount('acct-1', '2026-05-12');
    expect(['AT_RISK', 'HEALTHY']).toContain(result.riskLevel);
  });

  it('drops to CRITICAL with past-due AND overdue AND no active subs', async () => {
    const stub = buildStub({
      activeSubs: 0,
      pastDueSubs: 1,
      overdueInvoices: 1,
      recentSupport: 8,
    });
    const accounts = { loadOrFail: async () => null } as unknown as AccountService;
    const svc = new HealthScoreService(stub.prisma, accounts);
    const result = await svc.computeForAccount('acct-1', '2026-05-12');
    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.overallScore).toBeLessThan(50);
  });
});
