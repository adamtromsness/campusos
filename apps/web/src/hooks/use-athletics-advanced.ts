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
