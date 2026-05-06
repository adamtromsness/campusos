import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
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
import { ItController } from './it.controller';

/**
 * IT Infrastructure Module — M62 (Cycle 22).
 *
 * 12 services + 1 controller + ~38 endpoints + 1 Kafka emit topic
 * (tech.licence.near_capacity).
 *
 * Two structural keystones:
 *   1. Encrypted Credential Vault (ADR-065). AES-256-GCM via Node
 *      crypto. Tiered access (STANDARD / ELEVATED / CRITICAL).
 *      CredentialVaultService.getByIdWithPassword refuses to
 *      decrypt when actor tier < credential tier. Every
 *      successful read writes a VIEW row to
 *      tech_credential_access_log inside the same tenant tx.
 *   2. Software licence seat-utilisation auto-emit. The
 *      LicenceService.assignSeat path locks the parent licence
 *      FOR UPDATE, validates seat capacity, INSERTs the
 *      assignment, bumps used_seats, then emits
 *      tech.licence.near_capacity AFTER the tx commits when
 *      utilisation crosses 80%.
 *
 * Device Selection (ADR-066) closes the Wave-4 onboarding loop —
 * students self-select during enrolment, parents select on behalf
 * of their own children, IT staff approve and provision.
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
  ],
  controllers: [ItController],
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
  ],
})
export class ItModule {}
