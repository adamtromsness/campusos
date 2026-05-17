import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import {
  AssetCategoryService,
  AssetDocumentService,
  AssetService,
  AssignmentService,
  DamageReportService,
  RepairRecordService,
} from './assets.service';
import { CredentialVaultService, LicenceService } from './licences.service';
import {
  DeviceSelectionService,
  InfrastructureService,
  MdmService,
  ProcurementService,
} from './mdm.service';
import {
  DeviceUsageService,
  InventoryAuditService,
  LicenceRenewalService,
  RemoteActionService,
} from './remote-actions.service';
import {
  ConfigDocumentationService,
  InfrastructureExtensionService,
  MonitoringService,
  PhoneExtensionService,
} from './voip-monitoring.service';
import { ItController } from './it.controller';
import { ItAdvancedController } from './it-advanced.controller';

/**
 * IT Infrastructure Module — M62 (Cycle 22) + M62.1 (P2-20a).
 *
 * Cycle 22 surface (kept): 12 services + ItController + ~38 endpoints +
 * tech.licence.near_capacity emit. Two structural keystones: encrypted
 * credential vault per ADR-065 and licence seat-utilisation auto-emit.
 *
 * P2-20a additions:
 *   - RemoteActionService — IMMUTABLE remote MDM actions with
 *     mandatory >=20 character justification. WIPE + COMPLETED
 *     atomically flips tech_assets.status to AVAILABLE inside the
 *     same tenant tx. Emits tech.remote_action.issued.
 *   - InventoryAuditService — formal physical inventory audit
 *     lifecycle with per-asset scan, completion totals, and
 *     discrepancy reporting.
 *   - LicenceRenewalService — renewal ledger that atomically
 *     updates tech_software_licences.expiry_date inside one tenant
 *     tx.
 *   - DeviceUsageService — per-(asset, date) usage rollup with
 *     flagged_activity emit (tech.usage.flagged).
 *   - PhoneExtensionService — VOIP extension directory.
 *   - ConfigDocumentationService — versioned IT documentation with
 *     atomic version increment.
 *   - MonitoringService — uptime monitoring with consecutive-failure
 *     alerting (tech.monitoring.alert).
 *   - InfrastructureExtensionService — extension on the Cycle 22
 *     InfrastructureService for last_checked_at and warranty
 *     lookahead.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    AssetCategoryService,
    AssetService,
    AssignmentService,
    AssetDocumentService,
    DamageReportService,
    RepairRecordService,
    LicenceService,
    CredentialVaultService,
    MdmService,
    InfrastructureService,
    ProcurementService,
    DeviceSelectionService,
    RemoteActionService,
    InventoryAuditService,
    LicenceRenewalService,
    DeviceUsageService,
    PhoneExtensionService,
    ConfigDocumentationService,
    MonitoringService,
    InfrastructureExtensionService,
  ],
  controllers: [ItController, ItAdvancedController],
  exports: [
    AssetCategoryService,
    AssetService,
    AssignmentService,
    AssetDocumentService,
    DamageReportService,
    RepairRecordService,
    LicenceService,
    CredentialVaultService,
    MdmService,
    InfrastructureService,
    ProcurementService,
    DeviceSelectionService,
    RemoteActionService,
    InventoryAuditService,
    LicenceRenewalService,
    DeviceUsageService,
    PhoneExtensionService,
    ConfigDocumentationService,
    MonitoringService,
    InfrastructureExtensionService,
  ],
})
export class ItModule {}
