import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { HealthModule } from './health/health.module';
import { TenantModule } from './tenant/tenant.module';
import { PlatformModule } from './platform/platform.module';
import { IamModule } from './iam/iam.module';
import { AuthModule } from './auth/auth.module';
import { TenantGuard } from './tenant/tenant.guard';
import { PermissionGuard } from './auth/permission.guard';
import { GuardTestController } from './guard-test.controller';

/**
 * CampusOS Root Application Module
 *
 * Guard chain on every protected request:
 * TenantResolverMiddleware -> AuthGuard (global) -> TenantGuard (global) -> PermissionGuard (global)
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    HealthModule,
    TenantModule,
    AuthModule,
    PlatformModule,
    IamModule,
  ],
  controllers: [GuardTestController],
  providers: [
    // Global guards execute in registration order
    // AuthGuard is registered in AuthModule
    // TenantGuard runs after AuthGuard
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    // PermissionGuard runs last — checks @RequirePermission
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
})
export class AppModule {}
