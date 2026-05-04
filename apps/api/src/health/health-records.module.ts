import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthAccessLogController } from './health-access-log.controller';
import { HealthRecordService } from './health-record.service';
import { HealthRecordController } from './health-record.controller';
import { ConditionService } from './condition.service';
import { ConditionController } from './condition.controller';
import { ImmunisationService } from './immunisation.service';
import { ImmunisationController } from './immunisation.controller';

/**
 * Health Records Module — Cycle 10 Step 5.
 *
 * Wires the M23 Health record / condition / immunisation surface into
 * the request-path API. 4 services + 4 controllers + 13 endpoints.
 * Named `HealthRecordsModule` (not `HealthModule`) because the existing
 * `HealthModule` covers the system /health check endpoint at
 * apps/api/src/health/health.controller.ts.
 *
 * The Step 6 Medication services and Step 7 IEP / Nurse / Screening /
 * Dietary services will live in this module too (added in their
 * respective steps) and will reuse `HealthAccessLogService` for the
 * canonical HIPAA audit write.
 *
 * Authorisation contract:
 *   - hlt-001:read   — list + read records / conditions / immunisations.
 *                      Row-scoped at the service layer for non-managers
 *                      (teacher = students in their classes with PII
 *                      stripped + no immunisations; parent = own
 *                      children with management_plan stripped; student
 *                      = no rows). Every read writes a row to
 *                      hlth_health_access_log via HealthAccessLogService.
 *   - hlt-001:write  — create / update / delete records, conditions,
 *                      and immunisations. Service layer enforces
 *                      hasNurseScope (isSchoolAdmin OR holds
 *                      hlt-001:write) so a teacher with read-only
 *                      hlt-001:read receives 403 at the service tier.
 *   - hlt-001:admin  — school-wide immunisation compliance dashboard
 *                      + HIPAA access log read. School Admin and
 *                      Platform Admin receive admin via the
 *                      everyFunction grant; nurses / counsellors do
 *                      not.
 *
 * HIPAA discipline: the schema's hlth_health_access_log is IMMUTABLE
 * per ADR-010. HealthAccessLogService is the only writer and there
 * is no UPDATE / DELETE method on the service. Every Step 5–7 read
 * endpoint calls recordAccess(actor, studentId, accessType) AFTER
 * the row-scope check passes and BEFORE the response body leaves
 * the server.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [HealthAccessLogService, HealthRecordService, ConditionService, ImmunisationService],
  controllers: [
    HealthAccessLogController,
    HealthRecordController,
    ConditionController,
    ImmunisationController,
  ],
  // Exports so the Step 6 + Step 7 services can call recordAccess +
  // the row-scope helpers (HealthRecordService.assertCanReadStudentExternal
  // + loadRecordIdForStudent + assertNurseScope).
  exports: [HealthAccessLogService, HealthRecordService],
})
export class HealthRecordsModule {}
