import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { ConferenceService } from './conference.service';
import { MeetingService } from './meeting.service';
import { MeetingTypeService } from './meeting-type.service';
import { SlotService } from './slot.service';
import { MeetingNotesService } from './meeting-notes.service';
import { AgendaService } from './agenda.service';
import { ActionItemService } from './action-item.service';
import { RecordingService } from '../recordings/recording.service';
import { IepMeetingRecordService } from './iep-meeting-record.service';
import { ConferenceController } from './conference.controller';
import { MeetingController, ParticipantSlotController } from './meeting.controller';
import {
  ActionItemController,
  IepMeetingRecordController,
  MeetingTypeController,
  NotesAgendaController,
  RecordingController,
} from './meeting-content.controller';

/**
 * MeetingsModule — M41 Cycle 15.
 *
 * Wires the request-path services for conference events, meetings,
 * participant management, time-slot booking (the parent self-service
 * keystone), agenda items, meeting notes (the two-layer parent-
 * visibility gate), action items with cross-persona assignees,
 * recording metadata + consent tracking, and IEP meeting records
 * that resolve Cycle 11's svc_mtss_team_meetings.meeting_id soft FK
 * and link to Cycle 10 hlth_iep_plans.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    ConferenceService,
    MeetingTypeService,
    MeetingService,
    SlotService,
    MeetingNotesService,
    AgendaService,
    ActionItemService,
    RecordingService,
    IepMeetingRecordService,
  ],
  controllers: [
    ConferenceController,
    MeetingTypeController,
    MeetingController,
    ParticipantSlotController,
    NotesAgendaController,
    ActionItemController,
    RecordingController,
    IepMeetingRecordController,
  ],
  exports: [
    ConferenceService,
    MeetingService,
    SlotService,
    MeetingNotesService,
    AgendaService,
    ActionItemService,
    RecordingService,
    IepMeetingRecordService,
  ],
})
export class MeetingsModule {}
