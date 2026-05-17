import { Module } from '@nestjs/common';
import { StoreModule } from './orders/store.module';
import { StoreAdvancedModule } from './orders/store-advanced.module';

/**
 * M67 School Store — canonical aggregator for store core (orders,
 * products, external customers, shipping, revenue) and store-advanced
 * (promotions, loyalty, gift cards, wishlists, price schedules,
 * inventory adjustments, categories).
 */
@Module({
  imports: [StoreModule, StoreAdvancedModule],
  exports: [StoreModule, StoreAdvancedModule],
})
export class M67StoreModule {}
