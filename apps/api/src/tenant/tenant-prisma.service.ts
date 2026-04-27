import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getCurrentTenant } from './tenant.context';

/**
 * TenantPrismaService
 *
 * Provides Prisma clients scoped to the current tenant.
 * Uses the AsyncLocalStorage tenant context to determine which
 * schema to target via PostgreSQL search_path.
 *
 * Architecture (Dev Plan Section 18, Layer 2):
 * - search_path = tenant_<id>, platform, public
 * - Tenant tables resolve first, then platform tables
 * - If no tenant context → query rejected (never default schema)
 */
@Injectable()
export class TenantPrismaService implements OnModuleDestroy {
  private platformClient: PrismaClient;

  constructor() {
    this.platformClient = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL,
    });
  }

  /**
   * Get the platform Prisma client.
   * Always targets the platform schema. No tenant scoping.
   * Used for: organisations, schools, iam_person, platform_users, etc.
   */
  getPlatformClient(): PrismaClient {
    return this.platformClient;
  }

  /**
   * Execute a query within the current tenant's schema.
   *
   * Wraps the callback in a Prisma interactive transaction and pins the
   * search_path on the transaction's connection via SET LOCAL. This is
   * critical under connection pooling: a session-level SET on a shared
   * client can leak between concurrent requests and serve another tenant's
   * data. The transactional SET LOCAL is scoped to a single pinned
   * connection and is automatically reset on COMMIT/ROLLBACK.
   *
   * Usage:
   *   var result = await tenantPrisma.executeInTenantContext(async (client) => {
   *     return client.schoolConfig.findMany();
   *   });
   */
  async executeInTenantContext<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> {
    var tenant = getCurrentTenant();
    var schemaName = tenant.schemaName;
    return this.platformClient.$transaction(async function (tx: any): Promise<T> {
      await tx.$executeRawUnsafe('SET LOCAL search_path TO "' + schemaName + '", platform, public');
      return fn(tx as PrismaClient);
    });
  }

  /**
   * Execute raw SQL within the current tenant's schema.
   *
   * Same SET LOCAL discipline as executeInTenantContext — runs inside a tx
   * so the search_path can never leak across concurrent requests.
   */
  async executeTenantSQL(sql: string): Promise<void> {
    var tenant = getCurrentTenant();
    var schemaName = tenant.schemaName;
    await this.platformClient.$transaction(async function (tx: any): Promise<void> {
      await tx.$executeRawUnsafe('SET LOCAL search_path TO "' + schemaName + '", platform, public');
      await tx.$executeRawUnsafe(sql);
    });
  }

  /**
   * Execute a tenant-scoped interactive transaction.
   *
   * Opens a Prisma interactive transaction, sets search_path on the
   * transaction's pinned connection via SET LOCAL (so it doesn't bleed
   * into other queries), then runs the callback. Any error — including
   * raw $executeRawUnsafe failures or a thrown HttpException — rolls the
   * whole transaction back atomically.
   *
   * Use this when a single mutation spans multiple inserts/updates that
   * must commit together (e.g. POST /students, which writes to
   * platform.iam_person, platform.platform_students, and
   * tenant_X.sis_students).
   */
  async executeInTenantTransaction<T>(
    fn: (tx: PrismaClient) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T> {
    var tenant = getCurrentTenant();
    var schemaName = tenant.schemaName;
    return this.platformClient.$transaction(async function (tx: any): Promise<T> {
      await tx.$executeRawUnsafe('SET LOCAL search_path TO "' + schemaName + '", platform, public');
      return fn(tx as PrismaClient);
    }, options);
  }

  async onModuleDestroy() {
    await this.platformClient.$disconnect();
  }
}
