import { Module } from '@nestjs/common';
import { GroupsModule } from './groups/groups.module';
import { GroupsAdvancedModule } from './groups/groups-advanced.module';

/**
 * M103 Groups & Communities — canonical aggregator for groups core
 * and groups-advanced (polls, informal meetups, resource library,
 * invitations, monthly engagement analytics).
 */
@Module({
  imports: [GroupsModule, GroupsAdvancedModule],
  exports: [GroupsModule, GroupsAdvancedModule],
})
export class M103GroupsModule {}
