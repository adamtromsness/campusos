import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { InventoryAdjustmentService } from '../inventory/inventory-adjustment.service';
import { PromotionService } from '../promotions/promotion.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { GiftCardService } from '../gift-cards/gift-card.service';
import { WishlistService } from '../wishlists/wishlist.service';
import { PriceScheduleService } from '../inventory/price-schedule.service';
import { CategoryHierarchyService } from '../categories/category-hierarchy.service';
import { StoreAdvancedController } from './store-advanced.controller';

/**
 * Store Advanced — promotions, loyalty, gift cards, wishlists, price
 * schedules, inventory adjustments, category hierarchy. Owns all str_*
 * tables not covered by the core StoreModule (orders, products,
 * external customers, shipping, revenue).
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    InventoryAdjustmentService,
    PromotionService,
    LoyaltyService,
    GiftCardService,
    WishlistService,
    PriceScheduleService,
    CategoryHierarchyService,
  ],
  controllers: [StoreAdvancedController],
  exports: [
    InventoryAdjustmentService,
    PromotionService,
    LoyaltyService,
    GiftCardService,
    WishlistService,
    PriceScheduleService,
    CategoryHierarchyService,
  ],
})
export class StoreAdvancedModule {}
