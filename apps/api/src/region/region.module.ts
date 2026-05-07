import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RegionMismatchInterceptor } from './region-mismatch.interceptor';
import { RegionRoutingService } from './region-routing.service';

/**
 * Cycle 32 Step 6 — Region Module.
 *
 * Wires the global RegionMismatchInterceptor + the
 * RegionRoutingService.
 *
 * The interceptor is registered as APP_INTERCEPTOR so it runs after
 * the guard chain (Auth → Tenant → Permission) on every controller.
 * The interceptor only fires when:
 *   1. process.env.AWS_REGION is set (production), AND
 *   2. the route is marked @HomeRegionRequired() (or its containing
 *      controller is), AND
 *   3. a tenant context is available.
 *
 * Local dev / test environments without AWS_REGION skip the gate
 * entirely.
 */
@Module({
  providers: [
    RegionRoutingService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RegionMismatchInterceptor,
    },
  ],
  exports: [RegionRoutingService],
})
export class RegionModule {}
