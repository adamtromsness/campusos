'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1';

// ── DTO mirrors of the P2-8a athletics-advanced types ──────────

export type EquipmentItemType =
  | 'UNIFORM'
  | 'PROTECTIVE_GEAR'
  | 'TRAINING_EQUIPMENT'
  | 'GAME_EQUIPMENT'
  | 'MEDICAL_EQUIPMENT'
  | 'OTHER';

export type EquipmentCondition = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'RETIRED';
export type ReturnCondition = 'GOOD' | 'DAMAGED' | 'LOST';
export type SafetyEquipmentType =
  | 'HELMET'
  | 'PADS'
  | 'MOUTHGUARD'
  | 'SHIN_GUARDS'
  | 'GOGGLES'
  | 'OTHER';
export type PhotoType = 'TEAM_PHOTO' | 'ACTION_SHOT' | 'INDIVIDUAL';
export type MediaAssetType = 'PHOTO' | 'VIDEO' | 'DOCUMENT' | 'LOGO';
export type MaintenanceType = 'CLEANING' | 'REPAIR' | 'INSPECTION' | 'RECONDITIONING';

export interface EquipmentDto {
  id: string;
  schoolId: string;
  programmeId: string;
  programmeName: string | null;
  itemType: EquipmentItemType;
  itemName: string;
  quantity: number;
  condition: EquipmentCondition;
  purchaseDate: string | null;
  unitCost: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EquipmentCheckoutDto {
  id: string;
  equipmentId: string;
  equipmentName: string | null;
  assignedToPersonId: string;
  assignedToName: string | null;
  itemIdentifier: string | null;
  checkedOutAt: string;
  expectedReturnDate: string | null;
  returnedAt: string | null;
  conditionAtReturn: ReturnCondition | null;
  damageNotes: string | null;
  replacementCharge: number | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SafetyEquipmentDto {
  id: string;
  rosterMemberId: string;
  studentName: string | null;
  equipmentType: SafetyEquipmentType;
  issued: boolean;
  meetsSafetyStandard: boolean;
  certificationDate: string | null;
  certificationExpiry: string | null;
  recallStatus: boolean;
  notes: string | null;
  complianceState: 'GREEN' | 'AMBER' | 'ROSE' | 'NEUTRAL';
  createdAt: string;
  updatedAt: string;
}

export interface ConferenceDto {
  id: string;
  name: string;
  sport: string;
  region: string | null;
  governingBody: string | null;
  isActive: boolean;
  membershipCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConferenceMembershipDto {
  id: string;
  conferenceId: string;
  schoolId: string;
  programmeId: string;
  programmeName: string | null;
  joinedDate: string;
  level: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConferenceScheduleDto {
  id: string;
  conferenceId: string;
  seasonId: string | null;
  homeSchoolId: string;
  awaySchoolId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  linkedGameId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamPhotoDto {
  id: string;
  rosterId: string;
  photoType: PhotoType;
  s3Key: string;
  caption: string | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MediaAssetDto {
  id: string;
  schoolId: string;
  programmeId: string | null;
  programmeName: string | null;
  assetType: MediaAssetType;
  s3Key: string;
  title: string | null;
  description: string | null;
  seasonId: string | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceDto {
  id: string;
  equipmentId: string;
  maintenanceType: MaintenanceType;
  performedAt: string;
  performedBy: string | null;
  cost: number | null;
  notes: string | null;
  nextMaintenanceDate: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Equipment hooks ────────────────────────────────────────────

export function useEquipment(filters?: {
  programmeId?: string;
  itemType?: EquipmentItemType;
  condition?: EquipmentCondition;
}) {
  const qs = new URLSearchParams();
  if (filters?.programmeId) qs.set('programmeId', filters.programmeId);
  if (filters?.itemType) qs.set('itemType', filters.itemType);
  if (filters?.condition) qs.set('condition', filters.condition);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['athletics-advanced', 'equipment', filters],
    queryFn: () => apiFetch<EquipmentDto[]>(`${PREFIX}/athletics/equipment${suffix}`),
    staleTime: 30_000,
  });
}

export function useEquipmentItem(id: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'equipment', id],
    queryFn: () => apiFetch<EquipmentDto>(`${PREFIX}/athletics/equipment/${id!}`),
    enabled: !!id,
  });
}

export function useOverdueCheckouts() {
  return useQuery({
    queryKey: ['athletics-advanced', 'equipment', 'overdue'],
    queryFn: () => apiFetch<EquipmentCheckoutDto[]>(`${PREFIX}/athletics/equipment/overdue`),
    staleTime: 60_000,
  });
}

export function useEquipmentCheckouts(filters?: {
  equipmentId?: string;
  assignedToPersonId?: string;
  activeOnly?: boolean;
}) {
  const qs = new URLSearchParams();
  if (filters?.equipmentId) qs.set('equipmentId', filters.equipmentId);
  if (filters?.assignedToPersonId) qs.set('assignedToPersonId', filters.assignedToPersonId);
  if (filters?.activeOnly) qs.set('activeOnly', 'true');
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['athletics-advanced', 'equipment-checkouts', filters],
    queryFn: () =>
      apiFetch<EquipmentCheckoutDto[]>(`${PREFIX}/athletics/equipment-checkouts${suffix}`),
    staleTime: 30_000,
  });
}

export function useCreateEquipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      programmeId: string;
      itemType: EquipmentItemType;
      itemName: string;
      quantity?: number;
      condition?: EquipmentCondition;
      purchaseDate?: string;
      unitCost?: number;
    }) =>
      apiFetch<EquipmentDto>(`${PREFIX}/athletics/equipment`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'equipment'] });
    },
  });
}

export function useCheckoutEquipment(equipmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      assignedToPersonId: string;
      itemIdentifier?: string;
      checkedOutAt?: string;
      expectedReturnDate?: string;
    }) =>
      apiFetch<EquipmentCheckoutDto>(`${PREFIX}/athletics/equipment/${equipmentId}/checkout`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'equipment-checkouts'] });
    },
  });
}

export function useReturnCheckout(checkoutId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      conditionAtReturn: ReturnCondition;
      damageNotes?: string;
      replacementCharge?: number;
    }) =>
      apiFetch<EquipmentCheckoutDto>(
        `${PREFIX}/athletics/equipment-checkouts/${checkoutId}/return`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'equipment-checkouts'] });
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'equipment'] });
    },
  });
}

export function useEquipmentMaintenance(equipmentId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'equipment-maintenance', equipmentId],
    queryFn: () =>
      apiFetch<MaintenanceDto[]>(`${PREFIX}/athletics/equipment/${equipmentId!}/maintenance`),
    enabled: !!equipmentId,
  });
}

export function useAddMaintenance(equipmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      maintenanceType: MaintenanceType;
      performedAt?: string;
      performedBy?: string;
      cost?: number;
      notes?: string;
      nextMaintenanceDate?: string;
    }) =>
      apiFetch<MaintenanceDto>(`${PREFIX}/athletics/equipment/${equipmentId}/maintenance`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ['athletics-advanced', 'equipment-maintenance', equipmentId],
      });
    },
  });
}

// ── Safety Equipment ──────────────────────────────────────────

export function useRosterSafety(rosterId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'safety-equipment', 'roster', rosterId],
    queryFn: () =>
      apiFetch<SafetyEquipmentDto[]>(`${PREFIX}/athletics/rosters/${rosterId!}/safety`),
    enabled: !!rosterId,
  });
}

export function useExpiredSafety() {
  return useQuery({
    queryKey: ['athletics-advanced', 'safety-equipment', 'expired'],
    queryFn: () => apiFetch<SafetyEquipmentDto[]>(`${PREFIX}/athletics/safety-equipment/expired`),
    staleTime: 60_000,
  });
}

export function useCreateSafetyEquipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      rosterMemberId: string;
      equipmentType: SafetyEquipmentType;
      issued?: boolean;
      meetsSafetyStandard?: boolean;
      certificationDate?: string;
      certificationExpiry?: string;
      recallStatus?: boolean;
      notes?: string;
    }) =>
      apiFetch<SafetyEquipmentDto>(`${PREFIX}/athletics/safety-equipment`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'safety-equipment'] });
    },
  });
}

export function useUpdateSafetyEquipment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      issued?: boolean;
      meetsSafetyStandard?: boolean;
      certificationDate?: string;
      certificationExpiry?: string;
      recallStatus?: boolean;
      notes?: string;
    }) =>
      apiFetch<SafetyEquipmentDto>(`${PREFIX}/athletics/safety-equipment/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'safety-equipment'] });
    },
  });
}

// ── Conferences ──────────────────────────────────────────────

export function useConferences(filters?: { sport?: string; includeInactive?: boolean }) {
  const qs = new URLSearchParams();
  if (filters?.sport) qs.set('sport', filters.sport);
  if (filters?.includeInactive) qs.set('includeInactive', 'true');
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['athletics-advanced', 'conferences', filters],
    queryFn: () => apiFetch<ConferenceDto[]>(`${PREFIX}/athletics/conferences${suffix}`),
    staleTime: 60_000,
  });
}

export function useConference(id: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'conferences', id],
    queryFn: () => apiFetch<ConferenceDto>(`${PREFIX}/athletics/conferences/${id!}`),
    enabled: !!id,
  });
}

export function useConferenceMemberships(id: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'conferences', id, 'memberships'],
    queryFn: () =>
      apiFetch<ConferenceMembershipDto[]>(`${PREFIX}/athletics/conferences/${id!}/memberships`),
    enabled: !!id,
  });
}

export function useConferenceSchedule(id: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'conferences', id, 'schedule'],
    queryFn: () =>
      apiFetch<ConferenceScheduleDto[]>(`${PREFIX}/athletics/conferences/${id!}/schedule`),
    enabled: !!id,
  });
}

export function useCreateConference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      name: string;
      sport: string;
      region?: string;
      governingBody?: string;
    }) =>
      apiFetch<ConferenceDto>(`${PREFIX}/athletics/conferences`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'conferences'] });
    },
  });
}

export function useAddConferenceMembership(conferenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { programmeId: string; level?: string; joinedDate?: string }) =>
      apiFetch<ConferenceMembershipDto>(
        `${PREFIX}/athletics/conferences/${conferenceId}/memberships`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ['athletics-advanced', 'conferences', conferenceId, 'memberships'],
      });
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'conferences'] });
    },
  });
}

export function useAddConferenceSchedule(conferenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      seasonId?: string;
      homeSchoolId: string;
      awaySchoolId: string;
      scheduledDate: string;
      scheduledTime?: string;
      notes?: string;
    }) =>
      apiFetch<ConferenceScheduleDto>(`${PREFIX}/athletics/conferences/${conferenceId}/schedule`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ['athletics-advanced', 'conferences', conferenceId, 'schedule'],
      });
    },
  });
}

// ── Team photos + Media assets ───────────────────────────────

export function useRosterPhotos(rosterId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'team-photos', 'roster', rosterId],
    queryFn: () => apiFetch<TeamPhotoDto[]>(`${PREFIX}/athletics/rosters/${rosterId!}/photos`),
    enabled: !!rosterId,
  });
}

export function useProgrammeMedia(programmeId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'media-assets', 'programme', programmeId],
    queryFn: () =>
      apiFetch<MediaAssetDto[]>(`${PREFIX}/athletics/programmes/${programmeId!}/media`),
    enabled: !!programmeId,
  });
}

export function useMediaAssets(filters?: {
  programmeId?: string;
  assetType?: MediaAssetType;
  seasonId?: string;
}) {
  const qs = new URLSearchParams();
  if (filters?.programmeId) qs.set('programmeId', filters.programmeId);
  if (filters?.assetType) qs.set('assetType', filters.assetType);
  if (filters?.seasonId) qs.set('seasonId', filters.seasonId);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['athletics-advanced', 'media-assets', filters],
    queryFn: () => apiFetch<MediaAssetDto[]>(`${PREFIX}/athletics/media-assets${suffix}`),
    staleTime: 60_000,
  });
}

export function useCreateTeamPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      rosterId: string;
      photoType: PhotoType;
      s3Key: string;
      caption?: string;
    }) =>
      apiFetch<TeamPhotoDto>(`${PREFIX}/athletics/team-photos`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'team-photos'] });
    },
  });
}

export function useCreateMediaAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      programmeId?: string;
      assetType: MediaAssetType;
      s3Key: string;
      title?: string;
      description?: string;
      seasonId?: string;
    }) =>
      apiFetch<MediaAssetDto>(`${PREFIX}/athletics/media-assets`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'media-assets'] });
    },
  });
}

// ════════════════════════════════════════════════════════════════
// P2-8b — Streaming + Officials + Recruiting
// ════════════════════════════════════════════════════════════════

export type StreamStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'FAILED';
export type StreamAccessLevel = 'PUBLIC' | 'SCHOOL_ONLY' | 'BOTH_SCHOOLS' | 'COACHES_ONLY';
export type HighlightConsentStatus = 'PENDING' | 'CONSENTED' | 'DECLINED';
export type RecordingType = 'FULL_GAME' | 'HIGHLIGHT_REEL' | 'COACHES_FILM';
export type OfficialRole =
  | 'HEAD_REFEREE'
  | 'ASSISTANT_REFEREE'
  | 'UMPIRE'
  | 'LINE_JUDGE'
  | 'SCORER'
  | 'TIMER'
  | 'OTHER';
export type OfficialAssignmentStatus =
  | 'POSTED'
  | 'ACCEPTED'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';
export type OfficialPaymentStatus = 'PENDING' | 'PROCESSED' | 'PAID';
export type RaterType = 'SCHOOL_RATES_OFFICIAL' | 'OFFICIAL_RATES_SCHOOL';
export type RecruitingInterestLevel = 'EXPLORING' | 'INTERESTED' | 'APPLIED' | 'COMMITTED';

export interface GameStreamDto {
  id: string;
  gameId: string;
  streamUrl: string | null;
  streamStatus: StreamStatus;
  accessLevel: StreamAccessLevel;
  recordingS3Key: string | null;
  recordingDurationSeconds: number | null;
  configuredBy: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HighlightClipDto {
  id: string;
  streamId: string;
  studentId: string;
  studentName: string | null;
  startTimeSeconds: number;
  endTimeSeconds: number;
  title: string | null;
  description: string | null;
  s3Key: string;
  addedToPortfolio: boolean;
  portfolioItemId: string | null;
  consentStatus: HighlightConsentStatus;
  consentRecordedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GameRecordingDto {
  id: string;
  gameId: string;
  recordingType: RecordingType;
  s3Key: string;
  durationSeconds: number | null;
  title: string | null;
  description: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialProfileDto {
  id: string;
  personId: string;
  personName: string | null;
  sports: string[];
  certificationLevel: string | null;
  certificationBody: string | null;
  certificationExpiry: string | null;
  yearsExperience: number | null;
  maxTravelMiles: number | null;
  baseFee: number | null;
  isAvailable: boolean;
  bio: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  averageOverallRating: number | null;
  ratingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialAvailabilityDto {
  id: string;
  officialProfileId: string;
  availableDate: string;
  startTime: string | null;
  endTime: string | null;
  isAvailable: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialAssignmentDto {
  id: string;
  gameId: string;
  officialProfileId: string;
  officialName: string | null;
  role: OfficialRole;
  fee: number;
  status: OfficialAssignmentStatus;
  paymentStatus: OfficialPaymentStatus;
  acceptedAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  notes: string | null;
  assignedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialRatingDto {
  id: string;
  assignmentId: string;
  raterType: RaterType;
  professionalism: number | null;
  knowledge: number | null;
  communication: number | null;
  punctuality: number | null;
  overall: number;
  comments: string | null;
  ratedBy: string | null;
  ratedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecruitingProfileDto {
  id: string;
  studentId: string;
  studentName: string | null;
  sport: string;
  graduationYear: number;
  position: string | null;
  heightInches: number | null;
  weightLbs: number | null;
  gpa: number | null;
  gpaSnapshotAt: string | null;
  highlightReelS3Key: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  coachRecommendation: string | null;
  achievements: string | null;
  contactEmail: string | null;
  interestCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecruitingInterestDto {
  id: string;
  recruitingProfileId: string;
  collegeName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  interestLevel: RecruitingInterestLevel;
  lastContactDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Streams ─────────────────────────────────────────────────────

export function useLiveStreams() {
  return useQuery({
    queryKey: ['athletics-advanced', 'streams', 'live'],
    queryFn: () => apiFetch<GameStreamDto[]>(`${PREFIX}/athletics/streams/live`),
    staleTime: 15_000,
  });
}

export function useGameStream(gameId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'games', gameId, 'stream'],
    queryFn: () => apiFetch<GameStreamDto | null>(`${PREFIX}/athletics/games/${gameId}/stream`),
    enabled: !!gameId,
  });
}

export function useConfigureStream(gameId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { streamUrl?: string; accessLevel?: StreamAccessLevel }) =>
      apiFetch<GameStreamDto>(`${PREFIX}/athletics/games/${gameId}/stream`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'games', gameId] });
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'streams'] });
    },
  });
}

export function usePatchStream(streamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      streamStatus?: StreamStatus;
      streamUrl?: string;
      accessLevel?: StreamAccessLevel;
      recordingS3Key?: string;
      recordingDurationSeconds?: number;
    }) =>
      apiFetch<GameStreamDto>(`${PREFIX}/athletics/streams/${streamId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'streams'] });
    },
  });
}

export function useStreamClips(streamId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'streams', streamId, 'clips'],
    queryFn: () => apiFetch<HighlightClipDto[]>(`${PREFIX}/athletics/streams/${streamId}/clips`),
    enabled: !!streamId,
  });
}

export function useStudentClips(studentId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'students', studentId, 'clips'],
    queryFn: () =>
      apiFetch<HighlightClipDto[]>(`${PREFIX}/athletics/students/${studentId}/highlight-clips`),
    enabled: !!studentId,
  });
}

export function useCreateClip(streamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      studentId: string;
      startTimeSeconds: number;
      endTimeSeconds: number;
      title?: string;
      description?: string;
      s3Key: string;
    }) =>
      apiFetch<HighlightClipDto>(`${PREFIX}/athletics/streams/${streamId}/clips`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'streams', streamId, 'clips'] });
    },
  });
}

export function useRecordClipConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      clipId,
      consentStatus,
    }: {
      clipId: string;
      consentStatus: 'CONSENTED' | 'DECLINED';
    }) =>
      apiFetch<HighlightClipDto>(`${PREFIX}/athletics/highlight-clips/${clipId}/consent`, {
        method: 'POST',
        body: JSON.stringify({ consentStatus }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced'] });
    },
  });
}

export function useAddClipToPortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clipId: string) =>
      apiFetch<HighlightClipDto>(`${PREFIX}/athletics/highlight-clips/${clipId}/add-to-portfolio`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced'] });
    },
  });
}

export function useGameRecordings(gameId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'games', gameId, 'recordings'],
    queryFn: () => apiFetch<GameRecordingDto[]>(`${PREFIX}/athletics/games/${gameId}/recordings`),
    enabled: !!gameId,
  });
}

// ── Officials ───────────────────────────────────────────────────

export function useOfficials(filters?: {
  sport?: string;
  isAvailable?: boolean;
  availableDate?: string;
  search?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.sport) params.set('sport', filters.sport);
  if (filters?.isAvailable !== undefined) params.set('isAvailable', String(filters.isAvailable));
  if (filters?.availableDate) params.set('availableDate', filters.availableDate);
  if (filters?.search) params.set('search', filters.search);
  const qs = params.toString();
  return useQuery({
    queryKey: ['athletics-advanced', 'officials', filters],
    queryFn: () =>
      apiFetch<OfficialProfileDto[]>(`${PREFIX}/athletics/officials${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useOfficial(id: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'officials', id],
    queryFn: () => apiFetch<OfficialProfileDto>(`${PREFIX}/athletics/officials/${id}`),
    enabled: !!id,
  });
}

export function useCreateOfficialProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      personId: string;
      sports: string[];
      certificationLevel?: string;
      certificationBody?: string;
      certificationExpiry?: string;
      yearsExperience?: number;
      maxTravelMiles?: number;
      baseFee?: number;
      isAvailable?: boolean;
      bio?: string;
      contactEmail?: string;
      contactPhone?: string;
    }) =>
      apiFetch<OfficialProfileDto>(`${PREFIX}/athletics/officials/profile`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'officials'] });
    },
  });
}

export function useOfficialAvailability(officialProfileId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'officials', officialProfileId, 'availability'],
    queryFn: () =>
      apiFetch<OfficialAvailabilityDto[]>(
        `${PREFIX}/athletics/officials/${officialProfileId}/availability`,
      ),
    enabled: !!officialProfileId,
  });
}

export function useCreateAvailability(officialProfileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      availableDate: string;
      startTime?: string;
      endTime?: string;
      isAvailable?: boolean;
      notes?: string;
    }) =>
      apiFetch<OfficialAvailabilityDto>(
        `${PREFIX}/athletics/officials/${officialProfileId}/availability`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ['athletics-advanced', 'officials', officialProfileId, 'availability'],
      });
    },
  });
}

export function useGameAssignments(gameId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'games', gameId, 'officials'],
    queryFn: () =>
      apiFetch<OfficialAssignmentDto[]>(`${PREFIX}/athletics/games/${gameId}/officials`),
    enabled: !!gameId,
  });
}

export function useCreateAssignment(gameId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      officialProfileId: string;
      role: OfficialRole;
      fee: number;
      notes?: string;
    }) =>
      apiFetch<OfficialAssignmentDto>(`${PREFIX}/athletics/games/${gameId}/officials`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'games', gameId] });
    },
  });
}

export function useTransitionAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      assignmentId,
      ...payload
    }: {
      assignmentId: string;
      status: 'ACCEPTED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
      cancellationReason?: string;
      notes?: string;
    }) =>
      apiFetch<OfficialAssignmentDto>(`${PREFIX}/athletics/official-assignments/${assignmentId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced'] });
    },
  });
}

export function useAssignmentRatings(assignmentId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'assignments', assignmentId, 'ratings'],
    queryFn: () =>
      apiFetch<OfficialRatingDto[]>(
        `${PREFIX}/athletics/official-assignments/${assignmentId}/ratings`,
      ),
    enabled: !!assignmentId,
  });
}

export function useCreateRating() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      assignmentId,
      ...payload
    }: {
      assignmentId: string;
      raterType: RaterType;
      professionalism?: number;
      knowledge?: number;
      communication?: number;
      punctuality?: number;
      overall: number;
      comments?: string;
    }) =>
      apiFetch<OfficialRatingDto>(`${PREFIX}/athletics/official-assignments/${assignmentId}/rate`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'assignments'] });
    },
  });
}

// ── Recruiting ──────────────────────────────────────────────────

export function useRecruitingProfiles(filters?: {
  graduationYear?: number;
  sport?: string;
  isPublished?: boolean;
}) {
  const params = new URLSearchParams();
  if (filters?.graduationYear) params.set('graduationYear', String(filters.graduationYear));
  if (filters?.sport) params.set('sport', filters.sport);
  if (filters?.isPublished !== undefined) params.set('isPublished', String(filters.isPublished));
  const qs = params.toString();
  return useQuery({
    queryKey: ['athletics-advanced', 'recruiting', filters],
    queryFn: () =>
      apiFetch<RecruitingProfileDto[]>(`${PREFIX}/athletics/recruiting${qs ? `?${qs}` : ''}`),
  });
}

export function useRecruitingProfile(id: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'recruiting', id],
    queryFn: () => apiFetch<RecruitingProfileDto>(`${PREFIX}/athletics/recruiting/${id}`),
    enabled: !!id,
  });
}

export function useStudentRecruitingProfile(studentId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'students', studentId, 'recruiting'],
    queryFn: () =>
      apiFetch<RecruitingProfileDto | null>(`${PREFIX}/athletics/students/${studentId}/recruiting`),
    enabled: !!studentId,
  });
}

export function useCreateRecruitingProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      studentId: string;
      sport: string;
      graduationYear: number;
      position?: string;
      heightInches?: number;
      weightLbs?: number;
      highlightReelS3Key?: string;
      achievements?: string;
      contactEmail?: string;
    }) =>
      apiFetch<RecruitingProfileDto>(`${PREFIX}/athletics/recruiting`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'recruiting'] });
    },
  });
}

export function useUpdateRecruitingProfile(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      sport?: string;
      graduationYear?: number;
      position?: string;
      heightInches?: number;
      weightLbs?: number;
      highlightReelS3Key?: string;
      isPublished?: boolean;
      coachRecommendation?: string;
      achievements?: string;
      contactEmail?: string;
    }) =>
      apiFetch<RecruitingProfileDto>(`${PREFIX}/athletics/recruiting/${profileId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics-advanced', 'recruiting'] });
    },
  });
}

export function useRecruitingInterests(profileId: string | null) {
  return useQuery({
    queryKey: ['athletics-advanced', 'recruiting', profileId, 'interests'],
    queryFn: () =>
      apiFetch<RecruitingInterestDto[]>(`${PREFIX}/athletics/recruiting/${profileId}/interests`),
    enabled: !!profileId,
  });
}

export function useCreateInterest(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      collegeName: string;
      contactName?: string;
      contactEmail?: string;
      contactPhone?: string;
      interestLevel?: RecruitingInterestLevel;
      lastContactDate?: string;
      notes?: string;
    }) =>
      apiFetch<RecruitingInterestDto>(`${PREFIX}/athletics/recruiting/${profileId}/interests`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ['athletics-advanced', 'recruiting', profileId, 'interests'],
      });
    },
  });
}
