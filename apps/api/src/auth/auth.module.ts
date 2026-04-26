import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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
 * AuthGuard is registered as a GLOBAL guard — every endpoint
 * requires a valid JWT unless marked with @Public().
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
    // Register AuthGuard globally — all endpoints require auth by default
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  controllers: [AuthController],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
