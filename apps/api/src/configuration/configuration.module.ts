import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { ConfigurationController } from './configuration.controller';
import { ConfigurationService } from './configuration.service';

/**
 * School Configuration Admin Module — Step 1.
 *
 * Mounts /api/v1/admin/configuration/* (gated on sys-001:admin).
 * Serves the Configuration Hub today; Steps 2-7 add the tree-view
 * + import + grade-bands endpoints in this same module.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [ConfigurationService],
  controllers: [ConfigurationController],
  exports: [ConfigurationService],
})
export class ConfigurationModule {}
