import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Cycle 31 Step 9 — Platform Admin Module.
 *
 * Mounts the cross-tenant operational dashboard under
 * /api/v1/admin/platform/*. Read-only. Gated on sys-001:admin.
 *
 * Sibling to DlqModule (which exposes /api/v1/admin/dlq/*).
 */
@Module({
  providers: [
    {
      provide: PrismaClient,
      useFactory: () =>
        new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        }),
    },
    PlatformAdminService,
  ],
  controllers: [PlatformAdminController],
  exports: [PlatformAdminService],
})
export class PlatformAdminModule {}
