import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { VendorCatalogueService } from './vendor-catalogue.service';
import { ContractService } from './contract.service';
import { ContractExpiryWorker } from './contract-expiry.worker';
import { ProcurementAnalyticsWorker, SpendingAnalyticsService } from './spending-analytics.service';
import { ProcurementAdvancedController } from './procurement-advanced.controller';

/**
 * Procurement Advanced — vendor catalogues, contracts (with amendments
 * + expiry alerting), and spending analytics. Split out of the P2-29
 * commerce bundle so prc_* tables live alongside the rest of M86.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    VendorCatalogueService,
    ContractService,
    ContractExpiryWorker,
    SpendingAnalyticsService,
    ProcurementAnalyticsWorker,
  ],
  controllers: [ProcurementAdvancedController],
  exports: [
    VendorCatalogueService,
    ContractService,
    ContractExpiryWorker,
    SpendingAnalyticsService,
    ProcurementAnalyticsWorker,
  ],
})
export class ProcurementAdvancedModule {}
