import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionCheckService } from './permission-check.service';
import { EffectiveAccessCacheService } from './effective-access-cache.service';
import { RoleService } from './role.service';
import { AssignmentService } from './assignment.service';
import { ScopeService } from './scope.service';
import { ActorContextService } from './actor-context.service';
import { GuardianAuthorizationService } from './guardian-authorization.service';
import { PersonaResolutionService } from './persona-resolution.service';
import { InvitationService } from './invitation.service';
import { InvitationController } from './invitation.controller';
import { PeopleSearchService } from './people-search.service';
import { PeopleSearchController } from './people-search.controller';
import { RelationshipService } from './relationship.service';
import { RelationshipController } from './relationship.controller';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { RedisModule } from '@shared/cache';
import { ObservabilityModule } from '@shared/observability/observability.module';

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
  // RedisModule provides RedisService for the IAM access cache;
  // ObservabilityModule provides MetricsService for hit/miss instrumentation.
  // Both are @Optional() in PermissionCheckService so this works in test
  // contexts without Redis / Prometheus too.
  imports: [TenantModule, RedisModule, ObservabilityModule],
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
    GuardianAuthorizationService,
    PersonaResolutionService,
    InvitationService,
    PeopleSearchService,
    RelationshipService,
  ],
  controllers: [InvitationController, PeopleSearchController, RelationshipController],
  exports: [
    PermissionCheckService,
    EffectiveAccessCacheService,
    RoleService,
    AssignmentService,
    ScopeService,
    ActorContextService,
    GuardianAuthorizationService,
    PersonaResolutionService,
    InvitationService,
    PeopleSearchService,
    RelationshipService,
  ],
})
export class IamModule {}
