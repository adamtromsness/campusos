import { Module } from '@nestjs/common';

/**
 * M0 Platform Core Module
 *
 * Owns: organisations, schools, platform_users, iam_person,
 * platform_families, audit_log, event consumer idempotency,
 * tenant routing, and cross-tenant infrastructure.
 *
 * Tables prefixed: platform_, iam_person
 * Schema: platform (shared across all tenants)
 *
 * Services added in Steps 5–7:
 * - OrganisationService
 * - SchoolService
 * - TenantService (provisioning, routing, freeze)
 * - AuditService
 */
@Module({
  controllers: [],
  providers: [],
  exports: [],
})
export class PlatformModule {}
