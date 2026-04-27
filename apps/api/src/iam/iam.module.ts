import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionCheckService } from './permission-check.service';
import { EffectiveAccessCacheService } from './effective-access-cache.service';
import { RoleService } from './role.service';
import { AssignmentService } from './assignment.service';
import { ScopeService } from './scope.service';
import { ActorContextService } from './actor-context.service';

/**
 * IAM Module — Identity & Access Management
 *
 * The access control subsystem for the entire platform.
 * Every endpoint depends on this module for permission checks.
 *
 * Services:
 * - PermissionCheckService — hot-path permission lookup (@RequirePermission)
 * - EffectiveAccessCacheService — cache rebuild on assignment changes
 * - RoleService — role/permission CRUD
 * - AssignmentService — role assignment lifecycle
 * - ScopeService — scope hierarchy management
 */
@Module({
  providers: [
    {
      provide: PrismaClient,
      useFactory: () => {
        return new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        });
      },
    },
    PermissionCheckService,
    EffectiveAccessCacheService,
    RoleService,
    AssignmentService,
    ScopeService,
    ActorContextService,
  ],
  exports: [
    PermissionCheckService,
    EffectiveAccessCacheService,
    RoleService,
    AssignmentService,
    ScopeService,
    ActorContextService,
  ],
})
export class IamModule {}
