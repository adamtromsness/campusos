import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export type RjConferenceStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'AGREEMENT_REACHED'
  | 'RESOLVED_SUCCESSFULLY'
  | 'FAILED';

export type RjActionStatus = 'PENDING' | 'COMPLETED' | 'OVERDUE';

export type PeerMediationStatus = 'REFERRED' | 'SCHEDULED' | 'RESOLVED' | 'UNRESOLVED';

export type BehaviourTransactionType = 'AWARD' | 'REDEMPTION';

export type BehaviourRewardType = 'INDIVIDUAL' | 'CLASS' | 'DIGITAL' | 'PHYSICAL';

// ── Restorative Justice ──────────────────────────────────────────

export class CreateRjConferenceDto {
  @IsUUID()
  incidentId!: string;

  @IsUUID()
  offenderStudentId!: string;

  @IsArray()
  @IsUUID('all', { each: true })
  harmedPartyIds!: string[];

  @IsOptional()
  @IsDateString()
  conferenceDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  conferenceLocation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  conferenceNotes?: string;
}

export class UpdateRjConferenceDto {
  @IsOptional()
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'AGREEMENT_REACHED', 'FAILED'])
  status?: 'SCHEDULED' | 'IN_PROGRESS' | 'AGREEMENT_REACHED' | 'FAILED';

  @IsOptional()
  @IsDateString()
  conferenceDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  conferenceLocation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  conferenceNotes?: string;
}

export class CreateRjActionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  actionDescription!: string;

  @IsUUID()
  assignedToStudentId!: string;

  @IsDateString()
  dueDate!: string;
}

export class CompleteRjActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  evidenceNotes?: string;
}

export interface RjActionResponseDto {
  id: string;
  conferenceId: string;
  actionDescription: string;
  assignedToStudentId: string;
  assignedToStudentName: string | null;
  dueDate: string;
  status: RjActionStatus;
  completedAt: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  evidenceNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RjConferenceResponseDto {
  id: string;
  schoolId: string;
  incidentId: string;
  facilitatorId: string | null;
  facilitatorName: string | null;
  offenderStudentId: string;
  offenderStudentName: string | null;
  harmedPartyIds: string[];
  parentNotifiedAt: string | null;
  conferenceDate: string | null;
  conferenceLocation: string | null;
  conferenceNotes: string | null;
  status: RjConferenceStatus;
  resolutionDate: string | null;
  actions?: RjActionResponseDto[];
  createdAt: string;
  updatedAt: string;
}

// ── Peer Mediation ────────────────────────────────────────────────

export class CreatePeerMediationDto {
  @IsUUID()
  mediatorStudentId!: string;

  @IsUUID()
  partyAStudentId!: string;

  @IsUUID()
  partyBStudentId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  conflictDescription!: string;
}

export class UpdatePeerMediationDto {
  @IsOptional()
  @IsIn(['REFERRED', 'SCHEDULED', 'RESOLVED', 'UNRESOLVED'])
  status?: PeerMediationStatus;

  @IsOptional()
  @IsDateString()
  mediationDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outcome?: string;
}

export interface PeerMediationResponseDto {
  id: string;
  schoolId: string;
  mediatorStudentId: string;
  mediatorStudentName: string | null;
  partyAStudentId: string;
  partyAStudentName: string | null;
  partyBStudentId: string;
  partyBStudentName: string | null;
  referredBy: string | null;
  referredByName: string | null;
  conflictDescription: string;
  mediationDate: string | null;
  outcome: string | null;
  status: PeerMediationStatus;
  isMediatorTrained: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Positive Behaviour Points ─────────────────────────────────────

export class AwardPointsDto {
  @IsUUID()
  studentId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category!: string;

  @IsInt()
  @Min(1)
  points!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class CreateRewardDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  rewardName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsInt()
  @Min(1)
  pointsCost!: number;

  @IsIn(['INDIVIDUAL', 'CLASS', 'DIGITAL', 'PHYSICAL'])
  rewardType!: BehaviourRewardType;

  @IsOptional()
  @IsInt()
  @Min(0)
  quantityAvailable?: number;
}

export class UpdateRewardDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  pointsCost?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  quantityAvailable?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RedeemRewardDto {
  @IsUUID()
  studentId!: string;
}

export interface PointsTransactionResponseDto {
  id: string;
  studentId: string;
  studentName: string | null;
  awardedBy: string | null;
  awardedByName: string | null;
  transactionType: BehaviourTransactionType;
  category: string | null;
  points: number;
  reason: string;
  rewardId: string | null;
  rewardName: string | null;
  awardedAt: string;
}

export interface PointsBalanceResponseDto {
  studentId: string;
  awarded: number;
  redeemed: number;
  balance: number;
  history: PointsTransactionResponseDto[];
}

export interface BehaviourRewardResponseDto {
  id: string;
  schoolId: string;
  rewardName: string;
  description: string | null;
  pointsCost: number;
  rewardType: BehaviourRewardType;
  quantityAvailable: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RedemptionResponseDto {
  transactionId: string;
  rewardId: string;
  rewardName: string;
  pointsSpent: number;
  newBalance: number;
}

// ── Category configuration ────────────────────────────────────────

export interface PositiveCategoryConfig {
  name: string;
  description?: string;
  defaultPoints: number;
}

export class UpdatePositiveCategoriesDto {
  @IsArray()
  categories!: PositiveCategoryConfig[];
}
