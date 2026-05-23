import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka';
import { RedisModule } from '@shared/cache';
import { HouseholdsService } from './households.service';
import { HouseholdsController } from './households.controller';
import { FamilyChildrenService } from './family-children.service';
import { FamilyChildrenController } from './family-children.controller';

/**
 * Households Module — Profile and Household Mini-Cycle Step 6 plus
 * the persona-registration Step 5/6 family-children CRUD + linking.
 *
 * Self-service household editing for parents (HEAD_OF_HOUSEHOLD or
 * SPOUSE) with admin override (usr-001:admin). All writes target the
 * platform schema (platform_families, platform_family_members,
 * platform_family_children, platform_invitations) and so use regular
 * Prisma transactions, NOT executeInTenantTransaction.
 *
 * Emits iam.household.member_changed on every member-side write
 * (add / update / remove). No consumer in this mini-cycle — the topic
 * is forward-compatible for a future M40 announcement worker that
 * notifies other household members on changes.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, RedisModule],
  providers: [
    {
      provide: PrismaClient,
      useFactory: function () {
        return new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        });
      },
    },
    HouseholdsService,
    FamilyChildrenService,
  ],
  controllers: [HouseholdsController, FamilyChildrenController],
  exports: [HouseholdsService, FamilyChildrenService],
})
export class HouseholdsModule {}
