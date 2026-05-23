// M00 Platform — canonical public API.
//
// Cross-module callers import from `@modules/m00-platform`. Within-module
// imports stay relative.

export { M00PlatformModule } from './m00-platform.module';

// IAM — by far the most-imported subsystem cross-module.
export { IamModule } from './iam/iam.module';
export { ActorContextService } from './iam/actor-context.service';
export type { ResolvedActor } from './iam/actor-context.service';
export { PermissionCheckService } from './iam/permission-check.service';
export { EffectiveAccessCacheService } from './iam/effective-access-cache.service';
export { RoleService } from './iam/role.service';
export { ScopeService } from './iam/scope.service';
export { AssignmentService } from './iam/assignment.service';
export { GuardianAuthorizationService } from './iam/guardian-authorization.service';
export { PersonaResolutionService } from './iam/persona-resolution.service';
export type { Persona } from './iam/persona-resolution.service';
export { assertPersonInTenant, assertAccountInTenant } from './iam/person-in-tenant';

// Tenant — TenantModule, TenantGuard. The Prisma + context helpers live
// under @shared/tenant.
export { TenantModule } from './tenant/tenant.module';
export { TenantGuard } from './tenant/tenant.guard';

// Auth — leaf module class.
export { AuthModule } from './auth/auth.module';

// Other platform-leaf modules occasionally referenced cross-module.
export { ConfigurationModule } from './configuration/configuration.module';
export { RegionModule } from './region/region.module';
export { GovernanceModule } from './governance/governance.module';
export { ProfileModule } from './profile/profile.module';
export { HouseholdsModule } from './households/households.module';
export { CommunityModule } from './community/community.module';
export { CrmModule } from './crm/crm.module';
export { OpsModule } from './ops/ops.module';
export { PlatformAdminModule } from './platform-admin/platform-admin.module';
export { PlatformModule } from './platform/platform.module';
