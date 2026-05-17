import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { LocationService } from './location.service';
import { LocationController } from './location.controller';
import { CatalogueItemService } from './catalogue-item.service';
import { CatalogueItemController } from './catalogue-item.controller';
import { CopyService } from './copy.service';
import { CopyController } from './copy.controller';
import { CheckoutService } from './checkout.service';
import { CheckoutController } from './checkout.controller';
import { HoldService } from './hold.service';
import { HoldController } from './hold.controller';
import { FineService } from './fine.service';
import { FineController } from './fine.controller';
import { ReadingProgrammeService } from './reading-programme.service';
import { ReadingProgrammeController } from './reading-programme.controller';
import { ReadingLogService } from './reading-log.service';
import { ReadingLogController } from './reading-log.controller';
import { ReadingListService } from './reading-list.service';
import { ReadingListController } from './reading-list.controller';
import { ReviewService } from './review.service';
import { ReviewController } from './review.controller';
// P2-25a — Library Advanced
import { ClassSetService } from './class-set.service';
import { ClassSetController } from './class-set.controller';
import { ClassSetOverdueWorker } from './class-set-overdue.worker';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.controller';
import { InterlibraryLoanService } from './interlibrary-loan.service';
import { InterlibraryLoanController } from './interlibrary-loan.controller';
import { CatalogueImportService } from './catalogue-import.service';
import { CatalogueImportController } from './catalogue-import.controller';
import { CatalogueImportWorker } from './catalogue-import.worker';

/**
 * Library Module — Cycle 12 Step 5.
 *
 * Wires the M24 Library catalogue tables (Step 1 migration) into a
 * request-path API surface. Step 5 lands three services + ~11
 * endpoints under the /library URL prefix:
 *
 *   - LocationService        — lib_locations CRUD with the
 *                              UNIQUE(school_id, name) keystone catch.
 *                              Librarian or admin (lib-001:write) for
 *                              writes; everyone with lib-001:read can
 *                              browse the location list because the
 *                              catalogue + copy view surfaces the
 *                              location label.
 *   - CatalogueItemService   — lib_catalogue_items CRUD plus the GIN
 *                              full-text search keystone via
 *                              plainto_tsquery + ts_rank ordering. The
 *                              getById endpoint inlines copies +
 *                              availability count + active holds count
 *                              + average rating + review count via
 *                              sub-selects against the live
 *                              circulation + reviews state.
 *   - CopyService            — lib_catalogue_copies CRUD plus the
 *                              barcode lookup keystone (GET
 *                              /library/copies/barcode/:barcode) that
 *                              the Step 6 CheckoutService will read on
 *                              every scan to validate availability
 *                              before flipping the copy state.
 *
 * Step 6 will add the CheckoutService + HoldService + FineService
 * with the lib.fine.issued Kafka emit. Step 7 lands the reading
 * programmes + reviews module — the second student-input surface.
 *
 * Authorisation contract (per the Step 4 seed):
 *   - lib-001:read   — granted to Teacher, Parent, Student, Staff,
 *                      Admin (catalogue browsing is public to
 *                      authenticated users).
 *   - lib-001:write  — Staff (librarian) + Admin (everyFunction).
 *                      Creates locations, catalogue items, and
 *                      copies. Patches all three.
 *   - lib-001:admin  — School Admin + Platform Admin via everyFunction.
 *                      Reserved for the future bulk-import + hard-
 *                      delete paths the librarian UI doesn't expose.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    LocationService,
    CatalogueItemService,
    CopyService,
    CheckoutService,
    HoldService,
    FineService,
    ReadingProgrammeService,
    ReadingLogService,
    ReadingListService,
    ReviewService,
    // P2-25a — Library Advanced
    ClassSetService,
    ClassSetOverdueWorker,
    RecommendationService,
    InterlibraryLoanService,
    CatalogueImportService,
    CatalogueImportWorker,
  ],
  controllers: [
    LocationController,
    CatalogueItemController,
    CopyController,
    CheckoutController,
    HoldController,
    FineController,
    ReadingProgrammeController,
    ReadingLogController,
    ReadingListController,
    ReviewController,
    // P2-25a — Library Advanced
    ClassSetController,
    RecommendationController,
    InterlibraryLoanController,
    CatalogueImportController,
  ],
  exports: [
    LocationService,
    CatalogueItemService,
    CopyService,
    CheckoutService,
    HoldService,
    FineService,
    ReadingProgrammeService,
    ReadingLogService,
    ReadingListService,
    ReviewService,
    ClassSetService,
    RecommendationService,
    InterlibraryLoanService,
    CatalogueImportService,
  ],
})
export class LibraryModule {}
