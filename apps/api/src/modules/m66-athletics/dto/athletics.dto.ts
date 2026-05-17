import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  Matches,
} from 'class-validator';

// ── Enums (Cycle 13) ────────────────────────────────────────────

export const PROGRAMME_SEASONS = ['FALL', 'WINTER', 'SPRING', 'YEAR_ROUND'] as const;
export type ProgrammeSeason = (typeof PROGRAMME_SEASONS)[number];

export const ROSTER_LEVELS = ['VARSITY', 'JV', 'FRESHMAN', 'CLUB'] as const;
export type RosterLevel = (typeof ROSTER_LEVELS)[number];

export const SEASON_STATUSES = ['UPCOMING', 'ACTIVE', 'POSTSEASON', 'COMPLETED'] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export const ELIGIBILITY_STATUSES = [
  'ELIGIBLE',
  'INELIGIBLE',
  'PENDING_PHYSICAL',
  'PENDING_CONSENT',
  'PENDING_TRANSFER_WAIVER',
  'INJURED_NOT_CLEARED',
] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const GAME_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'POSTPONED',
  'CANCELLED',
] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const GAME_LOCATIONS = ['HOME', 'AWAY', 'NEUTRAL'] as const;
export type GameLocation = (typeof GAME_LOCATIONS)[number];

export const GAME_OUTCOMES = ['WIN', 'LOSS', 'DRAW', 'FORFEIT'] as const;
export type GameOutcome = (typeof GAME_OUTCOMES)[number];

export const PROPOSAL_STATUSES = [
  'PROPOSED',
  'ACCEPTED',
  'COUNTER_PROPOSED',
  'DECLINED',
  'CONFIRMED',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_LOCATIONS = ['HOME_PROPOSING', 'HOME_RECEIVING', 'NEUTRAL'] as const;
export type ProposalLocation = (typeof PROPOSAL_LOCATIONS)[number];

export const RECORD_TYPES = ['SINGLE_GAME', 'SEASON', 'CAREER'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const COACHING_ROLES = [
  'HEAD_COACH',
  'ASSISTANT_COACH',
  'VOLUNTEER_COACH',
  'SPECIALIST',
] as const;
export type CoachingRole = (typeof COACHING_ROLES)[number];

export const INJURY_SEVERITIES = ['MINOR', 'MODERATE', 'SEVERE', 'EMERGENCY'] as const;
export type InjurySeverity = (typeof INJURY_SEVERITIES)[number];

export const RETURN_TO_PLAY_STATUSES = [
  'ACTIVE',
  'SIDELINED',
  'CONCUSSION_PROTOCOL',
  'CLEARED',
] as const;
export type ReturnToPlayStatus = (typeof RETURN_TO_PLAY_STATUSES)[number];

export const CLEARANCE_REVIEW_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'NOT_SUBMITTED',
  'EXPIRED',
] as const;
export type ClearanceReviewStatus = (typeof CLEARANCE_REVIEW_STATUSES)[number];

// ── Programme DTOs ──────────────────────────────────────────────

export class CreateProgrammeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sportName!: string;

  @ApiProperty({ enum: PROGRAMME_SEASONS })
  @IsIn(PROGRAMME_SEASONS as unknown as string[])
  season!: ProgrammeSeason;

  @ApiProperty({ type: [String], enum: ROSTER_LEVELS })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(ROSTER_LEVELS as unknown as string[], { each: true })
  levelsOffered!: RosterLevel[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  maxRosterSizePerLevel?: Record<string, number>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(4)
  minGpa?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProgrammeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) sportName?: string;
  @ApiPropertyOptional({ enum: PROGRAMME_SEASONS })
  @IsOptional()
  @IsIn(PROGRAMME_SEASONS as unknown as string[])
  season?: ProgrammeSeason;
  @ApiPropertyOptional({ type: [String], enum: ROSTER_LEVELS })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(ROSTER_LEVELS as unknown as string[], { each: true })
  levelsOffered?: RosterLevel[];
  @ApiPropertyOptional() @IsOptional() @IsObject() maxRosterSizePerLevel?: Record<string, number>;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(4)
  minGpa?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ProgrammeResponseDto {
  id!: string;
  schoolId!: string;
  sportName!: string;
  season!: ProgrammeSeason;
  levelsOffered!: RosterLevel[];
  maxRosterSizePerLevel!: Record<string, number> | null;
  minGpa!: number | null;
  isActive!: boolean;
  createdAt!: string;
  updatedAt!: string;
}

// ── Season DTOs ─────────────────────────────────────────────────

export class CreateSeasonDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  academicYear!: string;

  @ApiPropertyOptional() @IsOptional() @IsDateString() firstPracticeDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() firstGameDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() lastGameDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() playoffCutoffDate?: string;

  @ApiPropertyOptional({ enum: SEASON_STATUSES })
  @IsOptional()
  @IsIn(SEASON_STATUSES as unknown as string[])
  status?: SeasonStatus;
}

export class UpdateSeasonDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) academicYear?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() firstPracticeDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() firstGameDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() lastGameDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() playoffCutoffDate?: string;
  @ApiPropertyOptional({ enum: SEASON_STATUSES })
  @IsOptional()
  @IsIn(SEASON_STATUSES as unknown as string[])
  status?: SeasonStatus;
}

export class SeasonResponseDto {
  id!: string;
  programmeId!: string;
  programmeName?: string;
  academicYear!: string;
  firstPracticeDate!: string | null;
  firstGameDate!: string | null;
  lastGameDate!: string | null;
  playoffCutoffDate!: string | null;
  status!: SeasonStatus;
  createdAt!: string;
  updatedAt!: string;
}

// ── Roster DTOs ─────────────────────────────────────────────────

export class CreateRosterDto {
  @ApiProperty({ enum: ROSTER_LEVELS })
  @IsIn(ROSTER_LEVELS as unknown as string[])
  level!: RosterLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  headCoachId?: string;
}

export class UpdateRosterDto {
  @ApiPropertyOptional({ enum: ROSTER_LEVELS })
  @IsOptional()
  @IsIn(ROSTER_LEVELS as unknown as string[])
  level?: RosterLevel;
  @ApiPropertyOptional() @IsOptional() @IsUUID() headCoachId?: string | null;
}

export class CertifyRosterDto {
  // No body — POST /rosters/:id/certify is action-only.
}

export class RosterResponseDto {
  id!: string;
  seasonId!: string;
  level!: RosterLevel;
  headCoachId!: string | null;
  headCoachName!: string | null;
  isCertified!: boolean;
  certifiedAt!: string | null;
  certifiedBy!: string | null;
  certifiedByName!: string | null;
  memberCount?: number;
  eligibleCount?: number;
  createdAt!: string;
  updatedAt!: string;
}

// ── Roster member DTOs ──────────────────────────────────────────

export class AddRosterMemberDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) jerseyNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) position?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) eligibilityNotes?: string;
}

export class UpdateRosterMemberDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) jerseyNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) position?: string;
  @ApiPropertyOptional({ enum: ELIGIBILITY_STATUSES })
  @IsOptional()
  @IsIn(ELIGIBILITY_STATUSES as unknown as string[])
  eligibilityStatus?: EligibilityStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) eligibilityNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() removedAt?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) removalReason?: string;
}

export class RosterMemberResponseDto {
  id!: string;
  rosterId!: string;
  studentId!: string;
  studentName!: string;
  studentGradeLevel!: string | null;
  jerseyNumber!: string | null;
  position!: string | null;
  eligibilityStatus!: EligibilityStatus;
  eligibilityNotes!: string | null;
  liveGpa!: number | null;
  programmeMinGpa!: number | null;
  joinedAt!: string;
  removedAt!: string | null;
  removalReason!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Game DTOs ───────────────────────────────────────────────────

export class CreateGameDto {
  @ApiProperty() @IsUUID() rosterId!: string;
  @ApiProperty() @IsDateString() gameDate!: string;
  @ApiProperty()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'gameTime must be HH:MM (24h)',
  })
  gameTime!: string;
  @ApiProperty() @IsString() @MaxLength(200) opponentName!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() opponentSchoolId?: string;
  @ApiProperty({ enum: GAME_LOCATIONS })
  @IsIn(GAME_LOCATIONS as unknown as string[])
  location!: GameLocation;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isConferenceGame?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isTicketed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateGameDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() gameDate?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
  gameTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) opponentName?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() opponentSchoolId?: string | null;
  @ApiPropertyOptional({ enum: GAME_LOCATIONS })
  @IsOptional()
  @IsIn(GAME_LOCATIONS as unknown as string[])
  location?: GameLocation;
  @ApiPropertyOptional({ enum: GAME_STATUSES })
  @IsOptional()
  @IsIn(GAME_STATUSES as unknown as string[])
  status?: GameStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isConferenceGame?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isTicketed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class GameResponseDto {
  id!: string;
  seasonId!: string;
  rosterId!: string;
  rosterLevel!: RosterLevel | null;
  programmeName!: string | null;
  gameDate!: string;
  gameTime!: string;
  opponentName!: string;
  opponentSchoolId!: string | null;
  location!: GameLocation;
  status!: GameStatus;
  isConferenceGame!: boolean;
  isTicketed!: boolean;
  notes!: string | null;
  result!: GameResultResponseDto | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Game proposal DTOs ──────────────────────────────────────────

export class CreateGameProposalDto {
  @ApiProperty() @IsUUID() receivingSchoolId!: string;
  @ApiProperty() @IsString() @MaxLength(80) sport!: string;
  @ApiProperty({ enum: ROSTER_LEVELS })
  @IsIn(ROSTER_LEVELS as unknown as string[])
  level!: RosterLevel;
  @ApiProperty() @IsDateString() proposedDate!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
  proposedTime?: string;
  @ApiProperty({ enum: PROPOSAL_LOCATIONS })
  @IsIn(PROPOSAL_LOCATIONS as unknown as string[])
  proposedLocation!: ProposalLocation;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() proposingRosterId?: string;
}

export class RespondGameProposalDto {
  @ApiPropertyOptional() @IsOptional() @IsObject() counterProposalData?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class GameProposalResponseDto {
  id!: string;
  proposingSchoolId!: string;
  receivingSchoolId!: string;
  proposingRosterId!: string | null;
  sport!: string;
  level!: RosterLevel;
  proposedDate!: string;
  proposedTime!: string | null;
  proposedLocation!: ProposalLocation;
  notes!: string | null;
  status!: ProposalStatus;
  counterProposalData!: Record<string, unknown> | null;
  confirmedGameId!: string | null;
  proposedBy!: string | null;
  respondedBy!: string | null;
  respondedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Game result + stats DTOs ────────────────────────────────────

export class EnterGameResultDto {
  @ApiProperty() @IsInt() @Min(0) homeScore!: number;
  @ApiProperty() @IsInt() @Min(0) awayScore!: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() scoreByPeriod?: Record<string, unknown>;
  @ApiProperty({ enum: GAME_OUTCOMES })
  @IsIn(GAME_OUTCOMES as unknown as string[])
  outcome!: GameOutcome;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class GameResultResponseDto {
  id!: string;
  gameId!: string;
  homeScore!: number;
  awayScore!: number;
  scoreByPeriod!: Record<string, unknown> | null;
  outcome!: GameOutcome;
  notes!: string | null;
  enteredBy!: string;
  enteredByName!: string | null;
  enteredAt!: string;
}

export class PlayerStatLineDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiProperty() @IsString() @MaxLength(40) statCategory!: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  statValue!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class EnterPlayerStatsDto {
  @ApiProperty({ type: [PlayerStatLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @Type(() => PlayerStatLineDto)
  stats!: PlayerStatLineDto[];
}

export class PlayerGameStatResponseDto {
  id!: string;
  gameId!: string;
  studentId!: string;
  studentName!: string;
  statCategory!: string;
  statValue!: number;
  notes!: string | null;
  enteredBy!: string;
  enteredAt!: string;
}

export class SeasonRecordResponseDto {
  rosterId!: string;
  wins!: number;
  losses!: number;
  draws!: number;
  conferenceWins!: number;
  conferenceLosses!: number;
  conferenceDraws!: number;
  lastUpdatedAt!: string;
}

// ── All-time records ────────────────────────────────────────────

export class CreateAllTimeRecordDto {
  @ApiProperty() @IsString() @MaxLength(80) sport!: string;
  @ApiProperty({ enum: RECORD_TYPES })
  @IsIn(RECORD_TYPES as unknown as string[])
  recordType!: RecordType;
  @ApiProperty() @IsString() @MaxLength(40) statCategory!: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  recordValue!: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() holderStudentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) holderNameSnapshot?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() setDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() setSeasonId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class AllTimeRecordResponseDto {
  id!: string;
  schoolId!: string;
  sport!: string;
  recordType!: RecordType;
  statCategory!: string;
  recordValue!: number;
  holderStudentId!: string | null;
  holderNameSnapshot!: string | null;
  setDate!: string | null;
  setSeasonId!: string | null;
  notes!: string | null;
  createdAt!: string;
}

// ── Coaching DTOs ───────────────────────────────────────────────

export class CreateCoachingAssignmentDto {
  @ApiProperty() @IsUUID() coachPersonId!: string;
  @ApiProperty({ enum: COACHING_ROLES })
  @IsIn(COACHING_ROLES as unknown as string[])
  role!: CoachingRole;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  stipendAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateCoachingAssignmentDto {
  @ApiPropertyOptional({ enum: COACHING_ROLES })
  @IsOptional()
  @IsIn(COACHING_ROLES as unknown as string[])
  role?: CoachingRole;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  stipendAmount?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CoachingAssignmentResponseDto {
  id!: string;
  rosterId!: string;
  coachPersonId!: string;
  coachName!: string | null;
  role!: CoachingRole;
  stipendAmount!: number | null;
  startDate!: string | null;
  endDate!: string | null;
  isActive!: boolean;
  notes!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Injury DTOs ─────────────────────────────────────────────────

export class CreateInjuryDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() gameId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() practiceDate?: string;
  @ApiProperty() @IsDateString() injuryDate!: string;
  @ApiProperty() @IsString() @MaxLength(120) bodyPart!: string;
  @ApiProperty() @IsString() @MaxLength(4000) injuryDescription!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) initialAssessment?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) actionTaken?: string;
  @ApiProperty({ enum: INJURY_SEVERITIES })
  @IsIn(INJURY_SEVERITIES as unknown as string[])
  severity!: InjurySeverity;
  @ApiProperty({ enum: RETURN_TO_PLAY_STATUSES })
  @IsIn(RETURN_TO_PLAY_STATUSES as unknown as string[])
  returnToPlayStatus!: ReturnToPlayStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() healthRecordId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() incidentReportId?: string;
}

export class UpdateInjuryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) initialAssessment?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) actionTaken?: string;
  @ApiPropertyOptional({ enum: INJURY_SEVERITIES })
  @IsOptional()
  @IsIn(INJURY_SEVERITIES as unknown as string[])
  severity?: InjurySeverity;
  @ApiPropertyOptional({ enum: RETURN_TO_PLAY_STATUSES })
  @IsOptional()
  @IsIn(RETURN_TO_PLAY_STATUSES as unknown as string[])
  returnToPlayStatus?: ReturnToPlayStatus;
}

export class InjuryResponseDto {
  id!: string;
  studentId!: string;
  studentName!: string;
  gameId!: string | null;
  practiceDate!: string | null;
  injuryDate!: string;
  bodyPart!: string;
  injuryDescription!: string;
  initialAssessment!: string | null;
  actionTaken!: string | null;
  severity!: InjurySeverity;
  returnToPlayStatus!: ReturnToPlayStatus;
  healthRecordId!: string | null;
  incidentReportId!: string | null;
  loggedBy!: string;
  loggedByName!: string | null;
  loggedAt!: string;
  clearedAt!: string | null;
  protocolSteps?: ConcussionProtocolStepDto[];
  clearances?: MedicalClearanceResponseDto[];
}

// ── Concussion protocol DTOs ────────────────────────────────────

export class StartProtocolStepDto {
  @ApiProperty() @IsInt() @Min(1) @Max(6) stepNumber!: number;
  @ApiProperty() @IsString() @MaxLength(120) stepName!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) minimumDurationHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CompleteProtocolStepDto {
  @ApiProperty() @IsBoolean() symptomFree!: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class ConcussionProtocolStepDto {
  id!: string;
  injuryId!: string;
  stepNumber!: number;
  stepName!: string;
  startedAt!: string;
  minimumDurationHours!: number;
  completedAt!: string | null;
  symptomFree!: boolean;
  clearedBy!: string | null;
  clearedByName!: string | null;
  notes!: string | null;
  canStartNext!: boolean;
}

// ── Medical clearance DTOs ──────────────────────────────────────

export class UploadClearanceDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) documentS3Key!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) physicianName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) physicianPhone?: string;
  @ApiProperty() @IsDateString() clearanceDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expiresAt?: string;
}

export class ReviewClearanceDto {
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'] })
  @IsIn(['ACCEPTED', 'REJECTED'])
  decision!: 'ACCEPTED' | 'REJECTED';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) reviewNotes?: string;
}

export class MedicalClearanceResponseDto {
  id!: string;
  injuryId!: string;
  documentS3Key!: string;
  physicianName!: string | null;
  physicianPhone!: string | null;
  clearanceDate!: string;
  uploadedBy!: string;
  uploadedByName!: string | null;
  uploadedAt!: string;
  reviewStatus!: ClearanceReviewStatus;
  reviewedBy!: string | null;
  reviewedByName!: string | null;
  reviewedAt!: string | null;
  reviewNotes!: string | null;
  expiresAt!: string | null;
}
