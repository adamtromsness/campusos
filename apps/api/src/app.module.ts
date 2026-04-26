import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { PlatformModule } from './platform/platform.module';
import { IamModule } from './iam/iam.module';
import { TenantModule } from './tenant/tenant.module';

/**
 * CampusOS Root Application Module
 *
 * Guard chain on every protected request:
 * TenantResolverMiddleware → AuthGuard → TenantGuard → PermissionGuard
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Health check (no auth/tenant required)
    HealthModule,

    // Tenant isolation — middleware + guard + scoped Prisma
    TenantModule,

    // M0 Platform Core
    PlatformModule,

    // M0 IAM
    IamModule,
  ],
})
export class AppModule {}
