import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { ConfigurationController } from './configuration.controller';
import {
  AcademicTreeService,
  BulkImportService,
  ConfigurationService,
  ConnectionsSummaryService,
  FacilityTreeService,
  PositionTreeService,
  SetupWizardService,
} from './configuration.service';

/**
 * School Configuration Admin Module — Steps 1-7.
 *
 * Mounts /api/v1/admin/configuration/* (gated on sys-001:admin).
 *
 * Step 1: ConfigurationService + GET setup-status for the hub.
 * Step 2: FacilityTreeService — facility-tree / building delete /
 *         space delete / room CSV import.
 * Step 3: AcademicTreeService — academic-tree + grade bands config.
 * Step 4: PositionTreeService — position-tree (recursive build).
 * Step 5: ConnectionsSummaryService — 4 cross-structure tables.
 * Step 6: SetupWizardService — resumable wizard progress.
 * Step 7: BulkImportService — staff + student CSV imports.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [
    ConfigurationService,
    FacilityTreeService,
    AcademicTreeService,
    PositionTreeService,
    ConnectionsSummaryService,
    SetupWizardService,
    BulkImportService,
  ],
  controllers: [ConfigurationController],
  exports: [
    ConfigurationService,
    FacilityTreeService,
    AcademicTreeService,
    PositionTreeService,
    ConnectionsSummaryService,
    SetupWizardService,
    BulkImportService,
  ],
})
export class ConfigurationModule {}
