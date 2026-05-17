import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { IamModule } from './iam/iam.module';
import { TenantModule } from './tenant/tenant.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { RegionModule } from './region/region.module';
import { GovernanceModule } from './governance/governance.module';
import { ProfileModule } from './profile/profile.module';
import { HouseholdsModule } from './households/households.module';
import { CommunityModule } from './community/community.module';
import { CrmModule } from './crm/crm.module';
import { OpsModule } from './ops/ops.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { PlatformModule } from './platform/platform.module';

/**
 * M00 Platform — canonical aggregator for the core platform subsystem
 * (auth, IAM, tenant, configuration, region, governance, profile,
 * households, community exchange, CRM, ops, platform-admin, platform).
 */
@Module({
  imports: [
    AuthModule,
    IamModule,
    TenantModule,
    ConfigurationModule,
    RegionModule,
    GovernanceModule,
    ProfileModule,
    HouseholdsModule,
    CommunityModule,
    CrmModule,
    OpsModule,
    PlatformAdminModule,
    PlatformModule,
  ],
  exports: [
    AuthModule,
    IamModule,
    TenantModule,
    ConfigurationModule,
    RegionModule,
    GovernanceModule,
    ProfileModule,
    HouseholdsModule,
    CommunityModule,
    CrmModule,
    OpsModule,
    PlatformAdminModule,
    PlatformModule,
  ],
})
export class M00PlatformModule {}
