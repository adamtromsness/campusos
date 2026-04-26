import { config } from "dotenv";
config({ path: ["../../.env.local", "../../.env", ".env"] });

import { PrismaClient } from '@prisma/client';

var platformClient: PrismaClient | null = null;

export function getPlatformClient(): PrismaClient {
  if (!platformClient) {
    platformClient = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL,
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['warn', 'error'],
    });
  }
  return platformClient;
}

export function createTenantClient(schemaName: string): PrismaClient {
  if (!/^tenant_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error('Invalid tenant schema name: ' + schemaName);
  }

  var client = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['warn', 'error'],
  });

  client.$use(async function(params, next) {
    await client.$executeRawUnsafe(
      'SET search_path TO "' + schemaName + '", platform, public'
    );
    return next(params);
  });

  return client;
}

export async function executePlatformSQL(sql: string): Promise<void> {
  var client = getPlatformClient();
  await client.$executeRawUnsafe(sql);
}

export async function disconnectAll(): Promise<void> {
  if (platformClient) {
    await platformClient.$disconnect();
    platformClient = null;
  }
}
