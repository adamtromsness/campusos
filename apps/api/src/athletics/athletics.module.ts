import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { ProgrammeService } from './programme.service';
import { ProgrammeController } from './programme.controller';
import { SeasonService } from './season.service';
import { SeasonController } from './season.controller';
import { RosterService } from './roster.service';
import { RosterController } from './roster.controller';
import { GameService } from './game.service';
import { GameController } from './game.controller';
import { GameProposalService } from './game-proposal.service';
import { GameProposalController } from './game-proposal.controller';
import { ResultService } from './result.service';
import { ResultController } from './result.controller';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { CoachingService } from './coaching.service';
import { CoachingController } from './coaching.controller';
import { InjuryService } from './injury.service';
import { InjuryController } from './injury.controller';
import { ConcussionProtocolService } from './concussion-protocol.service';
import { ConcussionProtocolController } from './concussion-protocol.controller';
import { MedicalClearanceService } from './medical-clearance.service';
import { MedicalClearanceController } from './medical-clearance.controller';
import { EquipmentService } from './equipment.service';
import { EquipmentController } from './equipment.controller';
import { SafetyEquipmentService } from './safety-equipment.service';
import { SafetyEquipmentController } from './safety-equipment.controller';
import { ConferenceService } from './conference.service';
import { ConferenceController } from './conference.controller';
import { TeamMediaService } from './team-media.service';
import { TeamMediaController } from './team-media.controller';

/**
 * Athletics Module — Cycle 13 Steps 5 + 6 + 7.
 *
 * Wires the M66 Athletics tables (Steps 1, 2, 3 migrations) into a
 * request-path API surface under the /athletics URL prefix.
 *
 * Step 5 lands the programme + roster surface (3 services + 14
 * endpoints). Step 6 adds games + results + stats + cross-school
 * proposals (4 services + ~16 endpoints + ath.game.result.entered
 * Kafka emit). Step 7 adds coaching + injuries + the 6-step
 * concussion protocol + medical clearances (4 services + ~12
 * endpoints).
 *
 * Authorisation contract (per the Step 4 IAM seed):
 *   - ATH-001:read  — Teacher, Parent, Student, Staff, Admin
 *                     (programmes + rosters are visible to everyone)
 *   - ATH-001:write — Staff (AD) + Admin (everyFunction)
 *   - ATH-002:read  — Teacher, Parent, Student, Staff, Admin
 *                     (game schedule + results are public)
 *   - ATH-002:write — Staff (AD) + Admin (results + stats entry)
 *   - ATH-003:read  — Staff + Admin (coaching staff is staff-only)
 *   - ATH-003:write — Staff + Admin
 *   - ATH-004:read  — Teacher, Student, Staff, Admin (injury status —
 *                     parents view via the health record path)
 *   - ATH-004:write — Staff + Admin (log injuries, manage protocol)
 *   - ATH-005:read  — Staff + Admin (medical clearances)
 *   - ATH-005:write — Staff + Admin
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    ProgrammeService,
    SeasonService,
    RosterService,
    GameService,
    GameProposalService,
    ResultService,
    StatsService,
    CoachingService,
    InjuryService,
    ConcussionProtocolService,
    MedicalClearanceService,
    // P2-8a — Athletics Advanced (Equipment + Conferences + Media)
    EquipmentService,
    SafetyEquipmentService,
    ConferenceService,
    TeamMediaService,
  ],
  controllers: [
    ProgrammeController,
    SeasonController,
    RosterController,
    GameController,
    GameProposalController,
    ResultController,
    StatsController,
    CoachingController,
    InjuryController,
    ConcussionProtocolController,
    MedicalClearanceController,
    // P2-8a controllers
    EquipmentController,
    SafetyEquipmentController,
    ConferenceController,
    TeamMediaController,
  ],
  exports: [
    ProgrammeService,
    SeasonService,
    RosterService,
    GameService,
    GameProposalService,
    ResultService,
    StatsService,
    CoachingService,
    InjuryService,
    ConcussionProtocolService,
    MedicalClearanceService,
    EquipmentService,
    SafetyEquipmentService,
    ConferenceService,
    TeamMediaService,
  ],
})
export class AthleticsModule {}
