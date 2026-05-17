import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { HealthRecordsModule } from '@modules/m23-health/health/health-records.module';
import { HealthAdvancedController } from './health-advanced.controller';
import { ImmunisationComplianceService } from './immunisation-compliance.service';
import { ImmunisationComplianceWorker } from './immunisation-compliance.worker';
import { ImmunisationRequirementService } from './immunisation-requirement.service';
import { ScreeningReferralService } from './screening-referral.service';
import { TelehealthProviderService } from './telehealth-provider.service';
import { TelehealthSessionService } from './telehealth-session.service';

/**
 * Health Advanced Module — M23 Health .1 (Phase 2 Cycle 3).
 *
 * 5 services + 1 controller + 1 background worker + ~20 endpoints +
 * 1 Kafka emit topic (hlth.immunisation.noncompliant).
 *
 * Three structural keystones:
 *   1. HIPAA TELEHEALTH AUDIT — every TelehealthSessionService.list /
 *      getById call writes a hlth_health_access_log row with
 *      access_type=VIEW_TELEHEALTH before the response leaves the
 *      service. The schema's access_type CHECK was extended in
 *      migration 109 to accept VIEW_TELEHEALTH.
 *   2. NIGHTLY COMPLIANCE COMPUTATION — ImmunisationComplianceWorker
 *      runs every 24h, walks active schools, and UPSERTs
 *      hlth_immunisation_compliance keyed on (student_id, year). The
 *      worker preserves manually-set EXEMPT and PROVISIONAL statuses
 *      and only flips between COMPLIANT and NON_COMPLIANT based on
 *      the immunisations vs requirements diff. Newly-NON_COMPLIANT
 *      students emit hlth.immunisation.noncompliant exactly once.
 *   3. STATE COMPLIANCE CSV REPORT —
 *      ImmunisationComplianceService.stateReportCsv produces a
 *      state-formatted summary with the seven required columns. Used
 *      by the GET /health/immunisation/compliance/report endpoint to
 *      stream the annual submission file.
 *
 * Permission gates:
 *   HLT-001 Health Records — immunisation requirement config (admin
 *           tier) + compliance reads.
 *   HLT-004 Health Screenings — screening referral creation, list,
 *           and follow-up tracking.
 *   HLT-006 Telehealth — provider directory + session scheduling +
 *           document upload. NEW catalogue code; the plan typo'd
 *           HLT-005 but that code is already in use by Cycle 10
 *           Dietary Profiles & Allergens.
 *
 * The HealthRecordsModule import gives this module access to
 * HealthAccessLogService for the HIPAA audit writes.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, HealthRecordsModule],
  controllers: [HealthAdvancedController],
  providers: [
    TelehealthProviderService,
    TelehealthSessionService,
    ImmunisationRequirementService,
    ImmunisationComplianceService,
    ScreeningReferralService,
    ImmunisationComplianceWorker,
  ],
  exports: [ImmunisationComplianceService],
})
export class HealthAdvancedModule {}
