/**
 * CampusOS Database Package
 *
 * Exports the Prisma client, tenant provisioning utilities,
 * UUID generation, and schema management helpers.
 */

// Prisma client
export { PrismaClient } from '@prisma/client';

// Client factory (platform + tenant)
export { getPlatformClient, createTenantClient, executePlatformSQL, disconnectAll } from './client';

// UUIDv7 generation (ADR-002)
export { generateId, extractTimestamp } from './uuid';

// Tenant provisioning
export { provisionTenant, listTenantSchemas, dropTenantSchema } from './provision-tenant';
