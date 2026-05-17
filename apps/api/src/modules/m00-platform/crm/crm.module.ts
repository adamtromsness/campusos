import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { KafkaModule } from '@shared/kafka';
import { CrmController } from './crm.controller';
import { HealthScoreWorker } from './health-score.worker';
import { AccountService } from './services/account.service';
import { ContactService } from './services/contact.service';
import { HealthScoreService } from './services/health-score.service';
import { OnboardingService } from './services/onboarding.service';
import { RenewalService } from './services/renewal.service';
import { SubscriptionService } from './services/subscription.service';

/**
 * P2-21a — CRM Module (M90 Customer Management).
 *
 * Internal-only customer-management surface for CampusOS-the-company.
 * Every route mounts under /api/v1/internal/crm/* with @PlatformScoped()
 * — no tenant subdomain header is required. PermissionGuard resolves
 * permissions against the PLATFORM IAM scope. Schools (the tenants)
 * cannot reach this surface even with sch-001:admin at SCHOOL scope.
 *
 * 5 services + 1 controller + ~22 endpoints + 1 worker:
 *   AccountService       — lifecycle + transitions + timeline
 *   SubscriptionService  — Stripe-synced subs + MRR rollup
 *   ContactService       — contacts + interactions
 *   OnboardingService    — checklist + tasks + account auto-flip keystone
 *   HealthScoreService   — weekly snapshots + at-risk view + manual recompute
 *   RenewalService       — pipeline board + upcoming
 *   HealthScoreWorker    — weekly cron writing one row per active account
 *
 * Schema lives in platform.* via migration 20260512140000_add_p2c21a_crm.
 * 9 tables: crm_accounts, crm_subscriptions, crm_contacts, crm_interactions,
 * crm_onboarding_checklists, crm_onboarding_tasks, crm_health_scores,
 * crm_renewal_pipeline, crm_invoices.
 */
@Module({
  imports: [KafkaModule],
  providers: [
    {
      provide: PrismaClient,
      useFactory: () =>
        new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        }),
    },
    AccountService,
    SubscriptionService,
    ContactService,
    OnboardingService,
    HealthScoreService,
    RenewalService,
    HealthScoreWorker,
  ],
  controllers: [CrmController],
  exports: [
    AccountService,
    SubscriptionService,
    ContactService,
    OnboardingService,
    HealthScoreService,
    RenewalService,
  ],
})
export class CrmModule {}
