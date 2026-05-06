import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { GroupService } from './group.service';
import { MembershipService } from './membership.service';
import { OwnershipTransferService } from './ownership-transfer.service';
import { GroupAnnouncementService } from './group-announcement.service';
import { GroupEventService } from './group-event.service';
import { GroupsController } from './groups.controller';

/**
 * Groups Module — M103 Groups and Communities (Cycle 18).
 *
 * 5 services + 1 controller + ~30 endpoints + 2 Kafka emit topics
 * (grp.announcement.posted, grp.event.created).
 *
 * Three structural keystones:
 *   1. Two-party ownership transfer handshake. Atomic role swap
 *      inside one tenant tx. Partial UNIQUE(group_id) WHERE status =
 *      PENDING caps pending transfers at one per group.
 *   2. Scope-aware bindings. CLASS / YEAR_GROUP / ACTIVITY scope
 *      types resolve scope_id at the application layer; SCHOOL /
 *      CUSTOM force scope_id NULL via multi-column scope_pair_chk.
 *   3. Re-join semantics. Partial UNIQUE(group_id, person_id)
 *      WHERE status <> 'LEFT' allows leaving and re-joining without
 *      stomping the prior membership row's audit.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    GroupService,
    MembershipService,
    OwnershipTransferService,
    GroupAnnouncementService,
    GroupEventService,
  ],
  controllers: [GroupsController],
  exports: [
    GroupService,
    MembershipService,
    OwnershipTransferService,
    GroupAnnouncementService,
    GroupEventService,
  ],
})
export class GroupsModule {}
