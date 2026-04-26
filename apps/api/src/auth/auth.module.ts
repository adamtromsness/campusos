import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';

/**
 * AuthModule
 *
 * Authentication subsystem. Delegates identity verification
 * to external IdP (Keycloak), then issues CampusOS JWT tokens.
 *
 * AuthGuard is exported so AppModule can register it as the FIRST global
 * guard. The guard order (Auth → Tenant → Permission) is fixed in
 * AppModule rather than scattered across modules so it's deterministic.
 */
@Module({
  providers: [
    {
      provide: PrismaClient,
      useFactory: function() {
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
