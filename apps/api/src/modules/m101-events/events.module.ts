import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { EventService, TierService } from './events.service';
import { OrderService, RefundService } from './orders.service';
import {
  CompListService,
  GateScanService,
  SeasonPassService,
  VolunteerService,
} from './gate.service';
import { OrderExpiryWorker } from './order-expiry.worker';
import { EventRevenueService } from './revenue.service';
import { EventsController } from './events.controller';

/**
 * Events Module — M101 Events & Ticketing (Phase 2 Cycle 12).
 *
 * Wave C operational depth cycle. 8 services + 1 worker + 1 controller
 * + ~28 endpoints under EVT-001 (and ATH-010 mirroring for athletic
 * games) + 3 Kafka emit topics (evt.order.confirmed,
 * evt.refund.issued, evt.event.completed).
 *
 * Two structural keystones:
 *   1. ATOMIC TICKET SALE — UPDATE evt_ticket_tiers
 *      SET quantity_sold = quantity_sold + $qty
 *      WHERE id = $tier_id AND quantity_sold + $qty <= quantity.
 *      Single statement, never SELECT-then-UPDATE. Zero rows matched
 *      equals 409 Sold Out. Plus the schema-side sold_chk and
 *      venue_capacity_chk CHECK constraints as belt-and-braces.
 *   2. ATOMIC GATE SCAN — UPDATE evt_tickets
 *      SET status='USED', scanned_at=now()
 *      WHERE qr_code_token=$1 AND status='VALID'.
 *      Zero rows matched means already scanned or invalid token.
 *      Every scan attempt logged to evt_ticket_scans regardless of
 *      result (RANGE partition by scanned_at MONTHLY).
 *
 * OrderExpiryWorker sweeps PENDING orders every 5 minutes whose
 * expires_at has passed, cancels them, decrements tier.quantity_sold,
 * and (in a future Stripe integration) cancels the PaymentIntent.
 *
 * Cross-cycle integration:
 *   - Cycle 6 StripeService — purchases create PaymentIntent stubs in
 *     this cycle; future integration wires the actual Stripe API call.
 *   - Cycle 13 ath_games — linked_game_id on evt_events for
 *     ATHLETIC_GAME events with auto-populated comp lists from roster.
 *   - Cycle 21 fac_spaces — venue_id soft FK for on-campus events.
 *   - Cycle 26 GLConsumer — evt.event.completed + evt.refund.issued
 *     drive the revenue journal posting on event close-out.
 *
 * Permission codes (already in catalogue from P2-12 Step 3):
 *   - EVT-001 School Events & Ticketing
 *   - ATH-010 Athletic Ticketing (mirrors EVT-001 for athletic games)
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    EventService,
    TierService,
    OrderService,
    RefundService,
    GateScanService,
    SeasonPassService,
    CompListService,
    VolunteerService,
    OrderExpiryWorker,
    EventRevenueService,
  ],
  controllers: [EventsController],
  exports: [],
})
export class EventsModule {}
