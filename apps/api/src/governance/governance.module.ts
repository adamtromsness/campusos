import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { GovernanceController } from './governance.controller';
import { RopaService } from './ropa.service';
import { DpiaService } from './dpia.service';
import { ProcessorService } from './processors.service';
import { BreachService } from './breach.service';
import { SarService } from './sar.service';
import {
  ConsentService,
  ComplianceConfigService,
  ErasureService,
  PrivacyNoticeService,
} from './erasure.service';

/**
 * GovernanceModule — M120 DPO Compliance Suite (Cycle 30).
 *
 * Wave 7 (Analytics & Governance) closing cycle. 10 services + 1
 * controller + ~46 endpoints under dpo-001..005 + 1 Kafka emit topic
 * (dpo.breach.discovered).
 *
 * Six structural keystones:
 *   1. 72-HOUR BREACH NOTIFICATION COUNTDOWN — BreachService.create
 *      emits dpo.breach.discovered AFTER tx commits when supervisory
 *      authority notification is required. Cycle 7 TaskWorker creates
 *      URGENT 72-hour escalating task. Highest-urgency automated
 *      escalation in CampusOS.
 *   2. DPIA + DPA GAP DETECTION — partial INDEXes back the dashboard
 *      gap rules: high_risk_processing=true AND dpia_id IS NULL on
 *      processing activities; dpa_in_place=false on processors.
 *   3. 30/45-DAY SAR DEADLINE — deadline_date computed from
 *      dpo_compliance_dashboard_config.sar_default_deadline_days. The
 *      dashboard surfaces overdue + due-soon as stat cards.
 *   4. AUDIT LOG FIELD-LEVEL PSEUDONYMISATION — ErasureService
 *      .pseudonymiseAuditLog rewrites platform.platform_audit_log
 *      .metadata for the data subject and writes one IMMUTABLE row
 *      per (target_table, target_field) into dpo_pseudonymisation_log.
 *   5. AGE-18 RIGHTS TRANSFER — SarService refuses GUARDIAN-submitted
 *      requests once platform_students.data_subject_is_self=true.
 *      Cycle 30 ships the read path; the actual flip is a future
 *      scheduled job.
 *   6. IMMUTABLE PSEUDONYMISATION LOG — append-only at the service
 *      layer (no UPDATE / no DELETE method exposed). Mirrors Cycle 8
 *      tkt_ticket_activity + Cycle 10 hlth_health_access_log.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    RopaService,
    DpiaService,
    ProcessorService,
    BreachService,
    SarService,
    ErasureService,
    ConsentService,
    PrivacyNoticeService,
    ComplianceConfigService,
  ],
  controllers: [GovernanceController],
})
export class GovernanceModule {}
