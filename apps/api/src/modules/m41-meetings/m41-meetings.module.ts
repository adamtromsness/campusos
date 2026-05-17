import { Module } from '@nestjs/common';
import { MeetingsModule } from './meetings/meetings.module';
import { ClubsMeetingsAdvancedModule } from './meetings/clubs-meetings-advanced.module';

/**
 * M41 Meetings — canonical aggregator for meetings core and
 * clubs-meetings-advanced (recordings, templates, AI minutes).
 */
@Module({
  imports: [MeetingsModule, ClubsMeetingsAdvancedModule],
  exports: [MeetingsModule, ClubsMeetingsAdvancedModule],
})
export class M41MeetingsModule {}
