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
   * Sets search_path based on the AsyncLocalStorage tenant context.
   *
   * Usage:
   *   var result = await tenantPrisma.executeInTenantContext(async (client) => {
   *     return client.schoolConfig.findMany();
   *   });
   */
  async executeInTenantContext<T>(
    fn: (client: PrismaClient) => Promise<T>,
  ): Promise<T> {
    var tenant = getCurrentTenant();
    var schemaName = tenant.schemaName;

    // Set search_path for this query
    await this.platformClient.$executeRawUnsafe(
      'SET search_path TO "' + schemaName + '", platform, public',
    );

    try {
      return await fn(this.platformClient);
    } finally {
      // Reset search_path after query
      await this.platformClient.$executeRawUnsafe(
        'SET search_path TO platform, public',
      );
    }
  }

  /**
   * Execute raw SQL within the current tenant's schema.
   */
  async executeTenantSQL(sql: string): Promise<void> {
    var tenant = getCurrentTenant();
    await this.platformClient.$executeRawUnsafe(
      'SET search_path TO "' + tenant.schemaName + '", platform, public; ' + sql,
    );
  }

  async onModuleDestroy() {
    await this.platformClient.$disconnect();
  }
}
