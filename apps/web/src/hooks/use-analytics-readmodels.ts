import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * Read-model hooks for the P2-15 analytics dashboard.
 *
 * 18 endpoints total (P2-15a operations + P2-15b engagement). All routes
 * are read-only and the underlying API services run through
 * TenantPrismaService.executeInTenantContext for replica routing.
 *
 * Each hook gates on an `enabled` prop so persona gating doesn't fire
 * 403 requests.
 */

const PREFIX = '/api/v1/analytics';

interface BaseRow {
  id: string;
  generatedAt: string;
}

// ---- P2-15a Operations ----

export interface ProcurementRow extends BaseRow {
  schoolId: string;
  period: string;
  department: string;
  vendorId: string;
  totalPos: number;
  totalSpend: number;
  avgLeadTimeDays: number | null;
}
export function useProcurementRollup(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'procurement'],
    queryFn: () => apiFetch<ProcurementRow[]>(`${PREFIX}/procurement`),
    enabled,
  });
}

export interface StoreSalesRow extends BaseRow {
  schoolId: string;
  period: string;
  productId: string;
  unitsSold: number;
  revenue: number;
  costOfGoods: number;
  profitMargin: number | null;
}
export function useStoreSales(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'store-sales'],
    queryFn: () => apiFetch<StoreSalesRow[]>(`${PREFIX}/store-sales`),
    enabled,
  });
}

export interface MealCountsRow extends BaseRow {
  schoolId: string;
  serviceDate: string;
  mealType: string;
  totalServed: number;
  freeCount: number;
  reducedCount: number;
  paidCount: number;
  wasteCount: number;
}
export function useMealCounts(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'meal-counts'],
    queryFn: () => apiFetch<MealCountsRow[]>(`${PREFIX}/meal-counts`),
    enabled,
  });
}

export interface NslpRow extends BaseRow {
  schoolId: string;
  monthYear: string;
  freeMeals: number;
  reducedMeals: number;
  paidMeals: number;
  totalReimbursementEstimate: number;
}
export function useNslp(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'nslp'],
    queryFn: () => apiFetch<NslpRow[]>(`${PREFIX}/nslp`),
    enabled,
  });
}

export interface RidershipRow extends BaseRow {
  schoolId: string;
  routeId: string;
  period: string;
  totalRuns: number;
  totalRiders: number;
  avgRidersPerRun: number | null;
  onTimeRate: number | null;
  avgDurationMinutes: number | null;
}
export function useRidership(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'ridership'],
    queryFn: () => apiFetch<RidershipRow[]>(`${PREFIX}/ridership`),
    enabled,
  });
}

export interface FacilitiesConditionRow extends BaseRow {
  schoolId: string;
  buildingId: string;
  spaceId: string;
  lastInspectionDate: string | null;
  conditionScore: number | null;
  openWorkOrders: number;
  overdueWorkOrders: number;
}
export function useFacilitiesCondition(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'facilities-condition'],
    queryFn: () => apiFetch<FacilitiesConditionRow[]>(`${PREFIX}/facilities-condition`),
    enabled,
  });
}

export interface FacilitiesKpiRow extends BaseRow {
  schoolId: string;
  period: string;
  totalWorkOrders: number;
  completedOnTime: number;
  avgResolutionDays: number | null;
  energyCost: number;
  costPerSqft: number | null;
}
export function useFacilitiesKpi(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'facilities-kpi'],
    queryFn: () => apiFetch<FacilitiesKpiRow[]>(`${PREFIX}/facilities-kpi`),
    enabled,
  });
}

export interface TechFleetRow extends BaseRow {
  schoolId: string;
  deviceType: string;
  totalDevices: number;
  active: number;
  inRepair: number;
  decommissioned: number;
  avgAgeMonths: number | null;
  incidentRate: number | null;
}
export function useTechFleet(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'tech-fleet'],
    queryFn: () => apiFetch<TechFleetRow[]>(`${PREFIX}/tech-fleet`),
    enabled,
  });
}

export interface LibraryCirculationRow extends BaseRow {
  schoolId: string;
  period: string;
  totalCheckouts: number;
  totalReturns: number;
  overdueCount: number;
  popularTitles: unknown;
  avgLoanDurationDays: number | null;
}
export function useLibraryCirculation(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'library-circulation'],
    queryFn: () => apiFetch<LibraryCirculationRow[]>(`${PREFIX}/library-circulation`),
    enabled,
  });
}

// ---- P2-15b Engagement & Performance ----

export interface EnrolmentFunnelRow extends BaseRow {
  schoolId: string;
  academicYear: string;
  applicationsReceived: number;
  toursBooked: number;
  offersMade: number;
  offersAccepted: number;
  enrolled: number;
  waitlisted: number;
  conversionRate: number | null;
}
export function useEnrolmentFunnel(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'enrolment-funnel'],
    queryFn: () => apiFetch<EnrolmentFunnelRow[]>(`${PREFIX}/enrolment-funnel`),
    enabled,
  });
}

export interface AthSeasonRow extends BaseRow {
  schoolId: string;
  seasonId: string;
  programmeId: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  totalRosterSize: number;
  injuryCount: number;
}
export function useAthleticsSeason(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'athletics-season'],
    queryFn: () => apiFetch<AthSeasonRow[]>(`${PREFIX}/athletics-season`),
    enabled,
  });
}

export interface OfficialsRow extends BaseRow {
  schoolId: string;
  period: string;
  totalAssignments: number;
  fillRate: number | null;
  avgCostPerGame: number | null;
  avgOfficialRating: number | null;
  avgSchoolRating: number | null;
}
export function useOfficials(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'officials'],
    queryFn: () => apiFetch<OfficialsRow[]>(`${PREFIX}/officials`),
    enabled,
  });
}

export interface GameResultRow extends BaseRow {
  schoolId: string;
  gameId: string;
  sport: string;
  homeScore: number;
  awayScore: number;
  result: string;
  seasonId: string;
  statisticalLeaders: unknown;
}
export function useGameResults(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'game-results'],
    queryFn: () => apiFetch<GameResultRow[]>(`${PREFIX}/game-results`),
    enabled,
  });
}

export interface GroupsEngagementRow extends BaseRow {
  schoolId: string;
  groupId: string;
  period: string;
  totalMembers: number;
  activeMembers: number;
  postsCount: number;
  commentsCount: number;
  engagementRate: number | null;
}
export function useGroupsEngagement(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'groups-engagement'],
    queryFn: () => apiFetch<GroupsEngagementRow[]>(`${PREFIX}/groups-engagement`),
    enabled,
  });
}

export interface PublicationsRow extends BaseRow {
  schoolId: string;
  period: string;
  publicationsCount: number;
  totalViews: number;
  totalDownloads: number;
  avgTimeToPublishDays: number | null;
}
export function usePublicationsDistribution(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'publications'],
    queryFn: () => apiFetch<PublicationsRow[]>(`${PREFIX}/publications`),
    enabled,
  });
}

export interface ClubsRow extends BaseRow {
  schoolId: string;
  academicYear: string;
  clubId: string;
  totalMembers: number;
  attendanceRate: number | null;
  eventsHeld: number;
  budgetSpent: number;
}
export function useClubsService(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'clubs'],
    queryFn: () => apiFetch<ClubsRow[]>(`${PREFIX}/clubs`),
    enabled,
  });
}

export interface CommsRow extends BaseRow {
  schoolId: string;
  period: string;
  messagesSent: number;
  broadcastsSent: number;
  deliveryRate: number | null;
  readRate: number | null;
  avgResponseTimeHours: number | null;
}
export function useCommunications(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'communications'],
    queryFn: () => apiFetch<CommsRow[]>(`${PREFIX}/communications`),
    enabled,
  });
}

export interface WellbeingDomainTrendRow extends BaseRow {
  schoolId: string;
  period: string;
  gradeLevel: string;
  domain: string;
  avgScore: number | null;
  responseCount: number;
  belowThresholdCount: number;
}
export function useWellbeingDomainTrends(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'wellbeing-domain-trends'],
    queryFn: () => apiFetch<WellbeingDomainTrendRow[]>(`${PREFIX}/wellbeing-trends`),
    enabled,
  });
}
