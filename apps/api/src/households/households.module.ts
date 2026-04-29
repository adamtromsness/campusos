import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { HouseholdsService } from './households.service';
import { HouseholdsController } from './households.controller';

/**
 * Households Module — Profile and Household Mini-Cycle Step 6.
 *
 * Self-service household editing for parents (HEAD_OF_HOUSEHOLD or
 * SPOUSE) with admin override (usr-001:admin). All writes target the
 * platform schema (platform_families, platform_family_members) and so
 * use regular Prisma transactions, NOT executeInTenantTransaction.
 *
 * Emits iam.household.member_changed on every member-side write
 * (add / update / remove). No consumer in this mini-cycle — the topic
 * is forward-compatible for a future M40 announcement worker that
 * notifies other household members on changes.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [HouseholdsService],
  controllers: [HouseholdsController],
  exports: [HouseholdsService],
})
export class HouseholdsModule {}
