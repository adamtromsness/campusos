import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { FrameworkService, StandardService } from './frameworks.service';
import { CurriculumMapService, UnitService } from './maps.service';
import { DeliveryGapService, ResourceLinkService } from './gaps.service';
import { CurriculumController } from './curriculum.controller';

/**
 * Curriculum & Standards Module — M25 (Cycle 23).
 *
 * 6 services + 1 controller + ~32 endpoints + 1 Kafka emit topic
 * (cur.delivery_gap.detected). Opens Wave 5.
 *
 * Three structural keystones:
 *   1. PLATFORM/TENANT DUAL RESOLUTION — national frameworks
 *      (CCSS, NGSS) live in platform.cur_standards_frameworks_platform
 *      + platform.cur_standards_platform; school-custom frameworks
 *      live in tenant cur_standards_frameworks + cur_standards.
 *      The cur_unit_standards.standard_id column resolves from
 *      either side via app-layer lookup (StandardService.resolveById).
 *   2. GIN-INDEXED STANDARDS SEARCH — platform.cur_standards_platform
 *      carries a tsvector GIN index on (code || description) for
 *      keyword search. ?q=narrative returns CCSS.ELA-LITERACY.W.5.3
 *      immediately.
 *   3. NIGHTLY MATERIALISED DELIVERY GAPS (ADR-018) — the Step 6
 *      DeliveryGapService.materialiseCurrentTenant walks every
 *      PUBLISHED curriculum map, counts planned vs delivered
 *      lessons per (unit, standard) tuple, and UPSERTs
 *      cur_delivery_gaps. Emits cur.delivery_gap.detected for
 *      new NOT_STARTED / PARTIAL gaps. First nightly read-model
 *      worker that reads across module boundaries (curriculum →
 *      classroom).
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    FrameworkService,
    StandardService,
    CurriculumMapService,
    UnitService,
    DeliveryGapService,
    ResourceLinkService,
  ],
  controllers: [CurriculumController],
  exports: [
    FrameworkService,
    StandardService,
    CurriculumMapService,
    UnitService,
    DeliveryGapService,
    ResourceLinkService,
  ],
})
export class CurriculumModule {}
