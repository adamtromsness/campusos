import { Module } from '@nestjs/common';

/**
 * IAM Module — Identity & Access Management
 *
 * The access control subsystem for the entire platform.
 * Every endpoint in every module depends on this module
 * for permission checks via @RequirePermission.
 *
 * Tables prefixed: iam_ (plus roles, permissions, role_permissions)
 * Schema: platform (shared across all tenants)
 *
 * Services added in Step 6:
 * - IamService — person CRUD, account linking, identity merge
 * - RoleService — roles, permissions, role-permission mappings
 * - AssignmentService — role assignments, Kafka events, cache trigger
 * - ScopeService — scope hierarchy management
 * - EffectiveAccessCacheService — cache rebuild, invalidation
 * - PermissionCheckService — hot-path permission lookup
 *
 * Guards added in Steps 8–9:
 * - AuthGuard — JWT validation
 * - TenantGuard — tenant context verification
 * - PermissionGuard — @RequirePermission enforcement
 */
@Module({
  controllers: [],
  providers: [],
  exports: [],
})
export class IamModule {}
