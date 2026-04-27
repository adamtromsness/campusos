import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantResolverMiddleware } from './tenant-resolver.middleware';
import { TenantGuard } from './tenant.guard';
import { TenantPrismaService } from './tenant-prisma.service';

/**
 * TenantModule
 *
 * Provides multi-tenant isolation for the entire application:
 * - TenantResolverMiddleware: resolves tenant on every request
 * - TenantGuard: validates tenant context, enforces freeze gate
 * - TenantPrismaService: tenant-scoped database access
 * - TenantContext: AsyncLocalStorage for request-scoped tenant info
 */
@Module({
  providers: [
    {
      provide: PrismaClient,
      useFactory: function () {
        return new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        });
      },
    },
    TenantResolverMiddleware,
    TenantGuard,
    TenantPrismaService,
  ],
  exports: [TenantGuard, TenantPrismaService, PrismaClient],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantResolverMiddleware).forRoutes('*');
  }
}
