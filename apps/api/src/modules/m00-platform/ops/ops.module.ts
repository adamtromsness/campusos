import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { OpsController } from './ops.controller';
import { TenantAccessExpiryWorker } from './tenant-access-expiry.worker';
import { AccountAssignmentService } from './services/account-assignment.service';
import { InternalTicketService } from './services/internal-ticket.service';
import { OpsEmployeeService } from './services/ops-employee.service';
import { PricingService } from './services/pricing.service';
import { TenantAccessService } from './services/tenant-access.service';

/**
 * P2-21b — Internal Ops + Pricing Module (M91 + Platform Pricing).
 *
 * Internal-only operations surface for CampusOS-the-company. Every
 * route mounts under /api/v1/internal/* with @PlatformScoped() — no
 * tenant subdomain header is required. PermissionGuard resolves
 * permissions against the PLATFORM IAM scope. Schools (the tenants)
 * cannot reach this surface even with ops-001:admin at SCHOOL scope.
 *
 * 5 services + 1 controller + 1 worker + ~20 endpoints:
 *   OpsEmployeeService          — CampusOS staff CRUD + permissions
 *   AccountAssignmentService    — CSM/TAM/AE account mappings
 *   TenantAccessService         — FERPA/GDPR audited tenant access (4h max)
 *   InternalTicketService       — internal cross-team tickets + comments
 *   PricingService              — bands + history audit + support tiers
 *   TenantAccessExpiryWorker    — sweeps expired grants every 5min
 *
 * Schema lives in platform.* via migration
 * 20260512150000_add_p2c21b_ops_pricing. 9 tables: ops_employees,
 * ops_permissions, ops_account_assignments, ops_tenant_access_grants,
 * ops_internal_tickets, ops_internal_ticket_comments,
 * platform_pricing_bands, platform_pricing_history,
 * platform_support_tiers.
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
    OpsEmployeeService,
    AccountAssignmentService,
    TenantAccessService,
    InternalTicketService,
    PricingService,
    TenantAccessExpiryWorker,
  ],
  controllers: [OpsController],
  exports: [
    OpsEmployeeService,
    AccountAssignmentService,
    TenantAccessService,
    InternalTicketService,
    PricingService,
  ],
})
export class OpsModule {}
