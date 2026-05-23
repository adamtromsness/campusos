import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';
import { AuthGuard } from '@shared/auth';
import { AuthController } from './auth.controller';
import { IamModule } from '@modules/m00-platform/iam/iam.module';

/**
 * AuthModule
 *
 * Authentication subsystem. Delegates identity verification
 * to external IdP (Keycloak), then issues CampusOS JWT tokens.
 *
 * AuthGuard is exported so AppModule can register it as the FIRST global
 * guard. The guard order (Auth → Tenant → Permission) is fixed in
 * AppModule rather than scattered across modules so it's deterministic.
 *
 * IamModule is imported so AuthService.getMe can call
 * PersonaResolutionService + PermissionCheckService for the persona-aware
 * /auth/me response (personas[] + activePersona + scoped permissions).
 */
@Module({
  imports: [IamModule],
  providers: [
    {
      provide: PrismaClient,
      useFactory: function () {
        return new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        });
      },
    },
    AuthService,
    AuthGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
