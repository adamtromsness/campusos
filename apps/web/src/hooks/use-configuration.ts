'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1/admin/configuration';

/**
 * School Configuration Admin — Step 1 + 2 hook surface.
 *
 * Backed by /api/v1/admin/configuration/* (gated on sys-001:admin).
 * Steps 3-7 will land academic-tree / position-tree /
 * connections-summary / imports / grade-bands hooks in this same
 * file.
 */

// ─── Step 1: Setup status ─────────────────────────────────────────

export type SetupStatus = 'DONE' | 'PARTIAL' | 'NOT_STARTED';

export type SetupStatusKey =
  | 'buildings'
  | 'rooms'
  | 'academic_year'
  | 'classes'
  | 'positions'
  | 'staff_assigned'
  | 'classes_in_rooms';

export interface SetupStatusItem {
  key: SetupStatusKey;
  label: string;
  status: SetupStatus;
  count: number;
  doneThreshold: number;
}

export interface SetupStatusResponseDto {
  items: SetupStatusItem[];
  completedCount: number;
  totalCount: number;
}

export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: ['configuration', 'setup-status'],
    queryFn: () => apiFetch<SetupStatusResponseDto>(`${PREFIX}/setup-status`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// ─── Step 2: Facility tree + delete + import ─────────────────────

export interface FacilityTreeSpaceDto {
  id: string;
  name: string;
  spaceType: string;
  isActive: boolean;
  areaSqft: number | null;
  schRoomId: string | null;
  schRoomName: string | null;
  scheduledClassCount: number;
}

export interface FacilityTreeFloorDto {
  floor: string | null;
  spaces: FacilityTreeSpaceDto[];
}

export interface FacilityTreeBuildingDto {
  id: string;
  name: string;
  code: string | null;
  yearBuilt: number | null;
  totalFloors: number | null;
  isActive: boolean;
  spaceCount: number;
  floors: FacilityTreeFloorDto[];
}

export interface FacilityTreeResponseDto {
  schoolName: string;
  schoolId: string;
  buildings: FacilityTreeBuildingDto[];
}

export function useFacilityTree(enabled = true) {
  return useQuery({
    queryKey: ['configuration', 'facility-tree'],
    queryFn: () => apiFetch<FacilityTreeResponseDto>(`${PREFIX}/facility-tree`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useDeleteBuilding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`${PREFIX}/buildings/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['configuration', 'facility-tree'] });
      qc.invalidateQueries({ queryKey: ['configuration', 'setup-status'] });
      qc.invalidateQueries({ queryKey: ['facilities', 'buildings'] });
    },
  });
}

export function useDeleteSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`${PREFIX}/spaces/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['configuration', 'facility-tree'] });
      qc.invalidateQueries({ queryKey: ['configuration', 'setup-status'] });
      qc.invalidateQueries({ queryKey: ['facilities', 'spaces'] });
    },
  });
}

export interface ImportRoomRow {
  buildingName: string;
  roomName: string;
  floor?: string | null;
  spaceType: string;
  areaSqft?: number | null;
}

export interface ImportRoomsResponseDto {
  created: number;
  skipped: number;
  errors: string[];
}

export function useImportRooms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: ImportRoomRow[]) =>
      apiFetch<ImportRoomsResponseDto>(`${PREFIX}/import/rooms`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['configuration', 'facility-tree'] });
      qc.invalidateQueries({ queryKey: ['configuration', 'setup-status'] });
      qc.invalidateQueries({ queryKey: ['facilities'] });
    },
  });
}

// ─── Step 3: Academic tree + grade bands ─────────────────────────

export interface AcademicTreeYearNode {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export interface AcademicTreeTermNode {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  termType: string;
}

export interface AcademicTreeClassNode {
  id: string;
  sectionCode: string;
  courseId: string;
  courseName: string;
  courseCode: string;
  termName: string | null;
  teacherNames: string[];
  studentCount: number;
  roomText: string | null;
}

export interface AcademicTreeGradeNode {
  gradeLevel: string;
  classes: AcademicTreeClassNode[];
}

export interface AcademicTreeBandNode {
  bandKey: string;
  bandLabel: string;
  grades: AcademicTreeGradeNode[];
}

export interface GradeBandDefinitionEntry {
  key: string;
  label: string;
  grades: string[];
}

export interface GradeBandDefinitions {
  bands: GradeBandDefinitionEntry[];
}

export interface AcademicTreeResponseDto {
  selectedYear: AcademicTreeYearNode | null;
  availableYears: AcademicTreeYearNode[];
  terms: AcademicTreeTermNode[];
  gradeBands: AcademicTreeBandNode[];
  ungroupedGrades: AcademicTreeGradeNode[];
  gradeBandDefinitions: GradeBandDefinitions;
}

export function useAcademicTree(academicYearId?: string, enabled = true) {
  const suffix = academicYearId ? `?academicYearId=${academicYearId}` : '';
  return useQuery({
    queryKey: ['configuration', 'academic-tree', academicYearId ?? 'default'],
    queryFn: () => apiFetch<AcademicTreeResponseDto>(`${PREFIX}/academic-tree${suffix}`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useUpdateGradeBands() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GradeBandDefinitions) =>
      apiFetch<GradeBandDefinitions>(`${PREFIX}/grade-bands`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['configuration', 'academic-tree'] });
    },
  });
}

// ─── Step 4: Position tree ───────────────────────────────────────

export interface PositionTreeNode {
  id: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  reportsToId: string | null;
  isTeachingRole: boolean;
  isActive: boolean;
  filledByEmployeeId: string | null;
  filledByName: string | null;
  filledByAccountId: string | null;
  children: PositionTreeNode[];
}

export interface PositionTreeResponseDto {
  totalPositions: number;
  filledCount: number;
  vacantCount: number;
  roots: PositionTreeNode[];
  vacantPositions: PositionTreeNode[];
  flatList: PositionTreeNode[];
}

export function usePositionTree(enabled = true) {
  return useQuery({
    queryKey: ['configuration', 'position-tree'],
    queryFn: () => apiFetch<PositionTreeResponseDto>(`${PREFIX}/position-tree`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// ─── Step 5: Connections summary ─────────────────────────────────

export interface BuildingSchoolLink {
  buildingId: string;
  buildingName: string;
  schoolId: string;
  schoolName: string;
  spaceCount: number;
}

export interface PositionSchoolLink {
  positionId: string;
  positionTitle: string;
  departmentName: string | null;
  schoolId: string;
  schoolName: string;
  filledByName: string | null;
}

export interface PersonPositionLink {
  positionId: string;
  positionTitle: string;
  departmentName: string | null;
  employeeId: string | null;
  personName: string | null;
  startDate: string | null;
  isVacant: boolean;
}

export interface ClassRoomLink {
  classId: string;
  className: string;
  courseName: string;
  gradeLevel: string | null;
  teacherNames: string[];
  roomText: string | null;
  scheduledRoomName: string | null;
  scheduledBuildingName: string | null;
  isUnassigned: boolean;
}

export interface ConnectionsSummaryResponseDto {
  buildingSchool: BuildingSchoolLink[];
  positionSchool: PositionSchoolLink[];
  personPosition: PersonPositionLink[];
  classRoom: ClassRoomLink[];
  totals: {
    buildings: number;
    positions: number;
    filledPositions: number;
    vacantPositions: number;
    classes: number;
    classesWithRoom: number;
    classesWithoutRoom: number;
  };
}

export function useConnectionsSummary(enabled = true) {
  return useQuery({
    queryKey: ['configuration', 'connections-summary'],
    queryFn: () => apiFetch<ConnectionsSummaryResponseDto>(`${PREFIX}/connections-summary`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// ─── Step 6: Setup wizard progress ───────────────────────────────

export interface SetupWizardProgressResponseDto {
  currentStep: number;
  completedSteps: number[];
  updatedAt: string;
  setupStatus: SetupStatusResponseDto;
}

export function useWizardProgress(enabled = true) {
  return useQuery({
    queryKey: ['configuration', 'wizard-progress'],
    queryFn: () => apiFetch<SetupWizardProgressResponseDto>(`${PREFIX}/wizard-progress`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

export function usePatchWizardProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { currentStep?: number; markStepComplete?: number }) =>
      apiFetch<SetupWizardProgressResponseDto>(`${PREFIX}/wizard-progress`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['configuration', 'wizard-progress'] });
      qc.invalidateQueries({ queryKey: ['configuration', 'setup-status'] });
    },
  });
}

// ─── Step 7: Bulk imports for staff + students ───────────────────

export interface ImportStaffRow {
  firstName: string;
  lastName: string;
  email: string;
  positionTitle?: string | null;
  departmentName?: string | null;
}

export interface ImportStudentRow {
  firstName: string;
  lastName: string;
  studentNumber: string;
  gradeLevel?: string | null;
  guardianFirstName?: string | null;
  guardianLastName?: string | null;
  guardianEmail?: string | null;
}

export interface BulkImportResponseDto {
  created: number;
  skipped: number;
  errors: string[];
}

export function useImportStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: ImportStaffRow[]) =>
      apiFetch<BulkImportResponseDto>(`${PREFIX}/import/staff`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['configuration'] });
    },
  });
}

export function useImportStudents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: ImportStudentRow[]) =>
      apiFetch<BulkImportResponseDto>(`${PREFIX}/import/students`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['configuration'] });
    },
  });
}
