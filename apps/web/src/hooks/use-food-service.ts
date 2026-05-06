import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateFdsDailyMenuPayload,
  CreateFdsDietaryUpdateRequestPayload,
  CreateFdsEligibilityApplicationPayload,
  CreateFdsMenuItemPayload,
  CreateFdsTemperatureLogPayload,
  CreateFdsTransactionPayload,
  FdsAllergenAlertDto,
  FdsAllergenCheckDto,
  FdsDailyMenuDto,
  FdsDietaryProfileDto,
  FdsDietaryUpdateRequestDto,
  FdsDietaryUpdateStatus,
  FdsEligibilityApplicationDto,
  FdsEligibilityStatus,
  FdsMealType,
  FdsMenuCycleDto,
  FdsMenuItemCategory,
  FdsMenuItemDto,
  FdsPosDeviceDto,
  FdsReconciliationDto,
  FdsSessionDto,
  FdsTempCheckLocation,
  FdsTemperatureLogDto,
  FdsTransactionDto,
  FdsUsdaClaimDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

export function useFdsMenuCycles() {
  return useQuery({
    queryKey: ['fds', 'cycles'],
    queryFn: () => apiFetch<FdsMenuCycleDto[]>(`${PREFIX}/food-service/menu-cycles`),
    staleTime: 60_000,
  });
}

export function useFdsMenuItems(args?: {
  category?: FdsMenuItemCategory;
  includeInactive?: boolean;
}) {
  const params = new URLSearchParams();
  if (args?.category) params.set('category', args.category);
  if (args?.includeInactive) params.set('includeInactive', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: ['fds', 'items', { ...args }],
    queryFn: () =>
      apiFetch<FdsMenuItemDto[]>(`${PREFIX}/food-service/menu-items${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useFdsAllergenCheck(codes: string[]) {
  const enabled = codes.length > 0;
  const qs = enabled ? `?codes=${codes.join(',')}` : '';
  return useQuery({
    queryKey: ['fds', 'allergen-check', codes.sort().join(',')],
    queryFn: () =>
      apiFetch<FdsMenuItemDto[]>(`${PREFIX}/food-service/menu-items/allergen-check${qs}`),
    enabled,
  });
}

export function useFdsCreateMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFdsMenuItemPayload) =>
      apiFetch<FdsMenuItemDto>(`${PREFIX}/food-service/menu-items`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

export function useFdsDailyMenu(date: string | null, mealType: FdsMealType) {
  return useQuery({
    queryKey: ['fds', 'daily-menu', date, mealType],
    queryFn: () =>
      apiFetch<FdsDailyMenuDto | null>(`${PREFIX}/food-service/daily-menus/${date}/${mealType}`),
    enabled: !!date,
  });
}

export function useFdsDailyMenus(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ['fds', 'daily-menus', fromDate, toDate],
    queryFn: () =>
      apiFetch<FdsDailyMenuDto[]>(
        `${PREFIX}/food-service/daily-menus?fromDate=${fromDate}&toDate=${toDate}`,
      ),
    staleTime: 60_000,
  });
}

export function useFdsCreateDailyMenu() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFdsDailyMenuPayload) =>
      apiFetch<FdsDailyMenuDto>(`${PREFIX}/food-service/daily-menus`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

export function useFdsAddDailyMenuItem(dailyMenuId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { menuItemId: string; quantityPrepared?: number }) =>
      apiFetch(`${PREFIX}/food-service/daily-menus/${dailyMenuId}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

// ── POS ──
export function useFdsPosDevices() {
  return useQuery({
    queryKey: ['fds', 'pos-devices'],
    queryFn: () => apiFetch<FdsPosDeviceDto[]>(`${PREFIX}/food-service/pos-devices`),
    staleTime: 60_000,
  });
}

export function useFdsSessions(args?: { fromDate?: string; toDate?: string }) {
  const params = new URLSearchParams();
  if (args?.fromDate) params.set('fromDate', args.fromDate);
  if (args?.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: ['fds', 'sessions', { ...args }],
    queryFn: () =>
      apiFetch<FdsSessionDto[]>(`${PREFIX}/food-service/sessions${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useFdsOpenSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { serviceDate: string; mealType: FdsMealType }) =>
      apiFetch<FdsSessionDto>(`${PREFIX}/food-service/sessions/open`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

export function useFdsCloseSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<FdsSessionDto>(`${PREFIX}/food-service/sessions/${sessionId}/close`, {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

export function useFdsAllergenCheckPatron(patronId: string | null) {
  return useQuery({
    queryKey: ['fds', 'allergen-patron-check', patronId],
    queryFn: () =>
      apiFetch<FdsAllergenCheckDto>(`${PREFIX}/food-service/patron/${patronId}/check-allergens`),
    enabled: !!patronId,
  });
}

export function useFdsCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFdsTransactionPayload) =>
      apiFetch<FdsTransactionDto>(`${PREFIX}/food-service/transactions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

export function useFdsTransactions(args?: {
  sessionId?: string;
  patronId?: string;
  fromDate?: string;
  toDate?: string;
}) {
  const params = new URLSearchParams();
  if (args?.sessionId) params.set('sessionId', args.sessionId);
  if (args?.patronId) params.set('patronId', args.patronId);
  if (args?.fromDate) params.set('fromDate', args.fromDate);
  if (args?.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: ['fds', 'transactions', { ...args }],
    queryFn: () =>
      apiFetch<FdsTransactionDto[]>(`${PREFIX}/food-service/transactions${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

// ── Reconciliation ──
export function useFdsReconciliation(sessionId: string | null) {
  return useQuery({
    queryKey: ['fds', 'reconciliation', sessionId],
    queryFn: () =>
      apiFetch<FdsReconciliationDto[]>(`${PREFIX}/food-service/reconciliation/${sessionId}`),
    enabled: !!sessionId,
  });
}

export function useFdsUpdateReconciliation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { actualClosingBalance: number; notes?: string }) =>
      apiFetch<FdsReconciliationDto>(`${PREFIX}/food-service/reconciliation/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

// ── Dietary ──
export function useFdsDietaryProfile(studentId: string | null) {
  return useQuery({
    queryKey: ['fds', 'dietary-profile', studentId],
    queryFn: () =>
      apiFetch<FdsDietaryProfileDto>(`${PREFIX}/food-service/dietary-profiles/${studentId}`),
    enabled: !!studentId,
  });
}

export function useFdsDietaryUpdateRequests(args?: { status?: FdsDietaryUpdateStatus }) {
  const qs = args?.status ? `?status=${args.status}` : '';
  return useQuery({
    queryKey: ['fds', 'dietary-updates', { ...args }],
    queryFn: () =>
      apiFetch<FdsDietaryUpdateRequestDto[]>(`${PREFIX}/food-service/dietary-update-requests${qs}`),
    staleTime: 30_000,
  });
}

export function useFdsSubmitDietaryUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFdsDietaryUpdateRequestPayload) =>
      apiFetch<FdsDietaryUpdateRequestDto>(`${PREFIX}/food-service/dietary-update-requests`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

export function useFdsReviewDietaryUpdate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: 'APPROVED' | 'REJECTED'; reviewNotes?: string }) =>
      apiFetch<FdsDietaryUpdateRequestDto>(`${PREFIX}/food-service/dietary-update-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

// ── Allergen alerts ──
export function useFdsStudentAllergenAlerts(studentId: string | null) {
  return useQuery({
    queryKey: ['fds', 'allergen-alerts', studentId],
    queryFn: () =>
      apiFetch<FdsAllergenAlertDto[]>(`${PREFIX}/food-service/allergen-alerts/${studentId}`),
    enabled: !!studentId,
  });
}

export function useFdsAllergenAlerts() {
  return useQuery({
    queryKey: ['fds', 'allergen-alerts-all'],
    queryFn: () => apiFetch<FdsAllergenAlertDto[]>(`${PREFIX}/food-service/allergen-alerts`),
    staleTime: 60_000,
  });
}

// ── Eligibility ──
export function useFdsEligibilityApplications(args?: { status?: FdsEligibilityStatus }) {
  const qs = args?.status ? `?status=${args.status}` : '';
  return useQuery({
    queryKey: ['fds', 'eligibility', { ...args }],
    queryFn: () =>
      apiFetch<FdsEligibilityApplicationDto[]>(
        `${PREFIX}/food-service/eligibility-applications${qs}`,
      ),
    staleTime: 60_000,
  });
}

export function useFdsSubmitEligibility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFdsEligibilityApplicationPayload) =>
      apiFetch<FdsEligibilityApplicationDto>(`${PREFIX}/food-service/eligibility-applications`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

export function useFdsDetermineEligibility(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      eligibilityCategory: 'FREE' | 'REDUCED' | 'PAID' | 'DENIED';
      effectiveFrom: string;
      effectiveTo: string;
      notes?: string;
    }) =>
      apiFetch<FdsEligibilityApplicationDto>(
        `${PREFIX}/food-service/eligibility-applications/${id}/determine`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

// ── USDA claims ──
export function useFdsUsdaClaims() {
  return useQuery({
    queryKey: ['fds', 'usda-claims'],
    queryFn: () => apiFetch<FdsUsdaClaimDto[]>(`${PREFIX}/food-service/usda-claims`),
    staleTime: 60_000,
  });
}

export function useFdsGenerateUsdaClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { monthYear: string; academicYearId?: string }) =>
      apiFetch<FdsUsdaClaimDto>(`${PREFIX}/food-service/usda-claims`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}

// ── Temperature logs ──
export function useFdsTemperatureLogs(args?: {
  fromDate?: string;
  toDate?: string;
  location?: FdsTempCheckLocation;
}) {
  const params = new URLSearchParams();
  if (args?.fromDate) params.set('fromDate', args.fromDate);
  if (args?.toDate) params.set('toDate', args.toDate);
  if (args?.location) params.set('location', args.location);
  const qs = params.toString();
  return useQuery({
    queryKey: ['fds', 'temp-logs', { ...args }],
    queryFn: () =>
      apiFetch<FdsTemperatureLogDto[]>(
        `${PREFIX}/food-service/temperature-logs${qs ? `?${qs}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useFdsNonCompliantTempLogs() {
  return useQuery({
    queryKey: ['fds', 'temp-logs', 'non-compliant'],
    queryFn: () =>
      apiFetch<FdsTemperatureLogDto[]>(`${PREFIX}/food-service/temperature-logs/non-compliant`),
    staleTime: 30_000,
  });
}

export function useFdsCreateTemperatureLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFdsTemperatureLogPayload) =>
      apiFetch<FdsTemperatureLogDto>(`${PREFIX}/food-service/temperature-logs`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fds'] }),
  });
}
