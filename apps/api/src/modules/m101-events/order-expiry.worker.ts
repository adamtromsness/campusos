import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '@shared/tenant/tenant.context';

/**
 * OrderExpiryWorker — P2-12 Step 4.
 *
 * Sweeps evt_orders rows WHERE status='PENDING' AND expires_at <= now()
 * every 5 minutes. For each expired order, atomically:
 *   - decrements tier.quantity_sold for each linked ticket
 *   - flips every linked ticket to CANCELLED
 *   - flips the order to CANCELLED with cancellation_reason='Expired'
 *   - logs the Stripe PaymentIntent that the Cycle 6 StripeService
 *     would cancel in production (stubbed in this cycle)
 *
 * The partial INDEX evt_orders_pending_expiry_idx on (expires_at)
 * WHERE status='PENDING' is the hot path. The UPDATE is idempotent —
 * a redelivered tick that finds the same row in a different status
 * matches 0 rows and exits cleanly.
 *
 * Configurable via env:
 *   EVT_EXPIRY_DISABLED=1            fully disable
 *   EVT_EXPIRY_INTERVAL_MS           poll interval (default 300_000ms = 5min)
 *   EVT_EXPIRY_WARMUP_MS             first-tick delay (default 60_000ms = 1min)
 */
@Injectable()
export class OrderExpiryWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OrderExpiryWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  onModuleInit(): void {
    if (process.env.EVT_EXPIRY_DISABLED === '1') {
      this.logger.log('OrderExpiryWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.EVT_EXPIRY_INTERVAL_MS || 300_000);
    const warmup = Number(process.env.EVT_EXPIRY_WARMUP_MS || 60_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('order-expiry tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('order-expiry tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'OrderExpiryWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip expiry tick — previous still running');
      return;
    }
    this.running = true;
    try {
      const schools = await this.loadActiveSchools();
      for (const school of schools) {
        await this.tickForTenant(school);
      }
    } finally {
      this.running = false;
    }
  }

  private async loadActiveSchools(): Promise<TenantInfo[]> {
    try {
      const client = this.tenantPrisma.getPlatformClient();
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, subdomain, schema_name, organisation_id::text AS organisation_id ' +
          'FROM platform.schools WHERE is_active = true',
      )) as Array<{
        id: string;
        subdomain: string;
        schema_name: string;
        organisation_id: string | null;
      }>;
      return rows.map((r) => ({
        schoolId: r.id,
        subdomain: r.subdomain,
        schemaName: r.schema_name,
        organisationId: r.organisation_id,
        isFrozen: false,
        planTier: 'STANDARD' as const,
        homeRegion: process.env.AWS_REGION ?? 'us-east-1',
      }));
    } catch (e: unknown) {
      this.logger.warn(
        'order-expiry: could not load schools: ' + ((e as Error)?.message || String(e)),
      );
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      await runWithTenantContextAsync({ tenant }, async () => {
        const expired = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
          // Lock + load every expired PENDING order for this school
          const orderRows = (await tx.$queryRawUnsafe(
            `SELECT o.id::text AS id, o.event_id::text AS event_id,
                    o.stripe_payment_intent_id
             FROM evt_orders o
             JOIN evt_events e ON e.id = o.event_id
             WHERE e.school_id = $1::uuid
               AND o.status = 'PENDING'
               AND o.expires_at IS NOT NULL
               AND o.expires_at <= now()
             FOR UPDATE OF o
             LIMIT 100`,
            tenant.schoolId,
          )) as Array<{ id: string; event_id: string; stripe_payment_intent_id: string | null }>;

          for (const order of orderRows) {
            // Decrement tier.quantity_sold for each linked ticket
            await tx.$executeRawUnsafe(
              `UPDATE evt_ticket_tiers t
               SET quantity_sold = GREATEST(0, t.quantity_sold - tk.cnt), updated_at = now()
               FROM (
                 SELECT tier_id, COUNT(*)::int AS cnt FROM evt_tickets
                 WHERE order_id = $1::uuid AND status IN ('VALID','USED') GROUP BY tier_id
               ) tk
               WHERE t.id = tk.tier_id`,
              order.id,
            );
            await tx.$executeRawUnsafe(
              `UPDATE evt_tickets SET status = 'CANCELLED', scanned_at = NULL, updated_at = now()
               WHERE order_id = $1::uuid AND status IN ('VALID','USED')`,
              order.id,
            );
            await tx.$executeRawUnsafe(
              `UPDATE evt_orders
               SET status = 'CANCELLED', cancelled_at = now(), updated_at = now(),
                   cancellation_reason = COALESCE(cancellation_reason, 'Expired — order PENDING longer than 15 minutes'),
                   expires_at = NULL
               WHERE id = $1::uuid AND status = 'PENDING'`,
              order.id,
            );
            if (order.stripe_payment_intent_id) {
              // STUBBED: a future Cycle 6 wire would call
              // StripeService.cancelPaymentIntent(intent). In dev the
              // PaymentIntent is a stub id only — log + skip.
              this.logger.debug(
                `[order-expiry] would cancel Stripe intent ${order.stripe_payment_intent_id} for order ${order.id}`,
              );
            }
          }
          return orderRows.length;
        });
        if (expired > 0) {
          this.logger.log(
            `order-expiry: tenant=${tenant.subdomain} expired ${expired} PENDING order(s)`,
          );
        }
      });
    } catch (e: unknown) {
      this.logger.warn(
        `order-expiry: tenant tick failed for ${tenant.subdomain}: ${(e as Error)?.stack || (e as Error)?.message || String(e)}`,
      );
    }
  }
}
