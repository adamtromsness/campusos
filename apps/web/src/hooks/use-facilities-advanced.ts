import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CleaningCompletionDto,
  CleaningRouteDto,
  CompleteStocktakeResponseDto,
  RouteAssignmentDto,
  StocktakeDto,
  StopCompletionDto,
  SupplyTransactionDto,
  WorkOrderAttachmentDto,
  WorkOrderCostSummaryDto,
  WorkOrderPartDto,
  ZoneInspectionDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

/**
 * P2-18a Facilities Advanced React Query hooks.
 *
 * Wraps the ~24 endpoints on apps/api/src/facilities/facilities-advanced.controller.ts.
 */

// ── Cleaning Routes ──
export function useCleaningRoutes(includeInactive = false) {
  return useQuery({
    queryKey: ['facilities-advanced', 'cleaning-routes', { includeInactive }],
    queryFn: async (): Promise<CleaningRouteDto[]> =>
      apiFetch(
        PREFIX + '/facilities/cleaning-routes' + (includeInactive ? '?includeInactive=true' : ''),
      ),
  });
}

export function useCleaningRoute(id: string | null) {
  return useQuery({
    queryKey: ['facilities-advanced', 'cleaning-route', id],
    queryFn: async (): Promise<CleaningRouteDto> =>
      apiFetch(PREFIX + '/facilities/cleaning-routes/' + id),
    enabled: !!id,
  });
}

export function useCreateCleaningRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      shift: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'OVERNIGHT';
      zoneId?: string;
      estimatedDurationMinutes?: number;
    }): Promise<CleaningRouteDto> =>
      apiFetch(PREFIX + '/facilities/cleaning-routes', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'cleaning-routes'] });
    },
  });
}

export function useReplaceRouteStops(routeId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      stops: Array<{
        spaceId: string;
        stopOrder: number;
        estimatedMinutes?: number;
        cleaningTasks?: string[];
      }>,
    ): Promise<CleaningRouteDto> =>
      apiFetch(PREFIX + '/facilities/cleaning-routes/' + routeId + '/stops', {
        method: 'PATCH',
        body: JSON.stringify({ stops }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'cleaning-route', routeId] });
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'cleaning-routes'] });
    },
  });
}

export function useRouteAssignments(routeId: string | null) {
  return useQuery({
    queryKey: ['facilities-advanced', 'route-assignments', routeId],
    queryFn: async (): Promise<RouteAssignmentDto[]> =>
      apiFetch(PREFIX + '/facilities/cleaning-routes/' + routeId + '/assignments'),
    enabled: !!routeId,
  });
}

export function useCreateRouteAssignment(routeId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employeeId: string;
      assignmentDate?: string;
      isRecurring?: boolean;
      recurrenceDays?: number[];
      effectiveFrom?: string;
      effectiveTo?: string;
      notes?: string;
    }): Promise<RouteAssignmentDto> =>
      apiFetch(PREFIX + '/facilities/cleaning-routes/' + routeId + '/assignments', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['facilities-advanced', 'route-assignments', routeId],
      });
    },
  });
}

// ── Completions ──
export function useCleaningCompletions(args?: {
  fromDate?: string;
  toDate?: string;
  routeId?: string;
  employeeId?: string;
}) {
  const params = new URLSearchParams();
  if (args?.fromDate) params.set('fromDate', args.fromDate);
  if (args?.toDate) params.set('toDate', args.toDate);
  if (args?.routeId) params.set('routeId', args.routeId);
  if (args?.employeeId) params.set('employeeId', args.employeeId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['facilities-advanced', 'cleaning-completions', args ?? {}],
    queryFn: async (): Promise<CleaningCompletionDto[]> =>
      apiFetch(PREFIX + '/facilities/cleaning-completions' + (qs ? '?' + qs : '')),
  });
}

export function useStartCompletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      routeId: string;
      assignmentId: string;
      completionDate?: string;
    }): Promise<CleaningCompletionDto> =>
      apiFetch(PREFIX + '/facilities/cleaning-completions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'cleaning-completions'] });
    },
  });
}

export function usePatchStopCompletion(completionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      stopId: string;
      status?: 'PENDING' | 'COMPLETED' | 'SKIPPED';
      skipReason?: string;
      tasksCompleted?: string[];
      photoS3Keys?: string[];
      issuesNoted?: string;
    }): Promise<StopCompletionDto> => {
      const { stopId, ...rest } = input;
      return apiFetch(
        PREFIX + '/facilities/cleaning-completions/' + completionId + '/stops/' + stopId,
        { method: 'PATCH', body: JSON.stringify(rest) },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'cleaning-completions'] });
    },
  });
}

// ── Zone Inspections ──
export function useZoneInspections(args?: {
  zoneId?: string;
  rating?: 'PASS' | 'NEEDS_IMPROVEMENT' | 'FAIL';
  fromDate?: string;
  toDate?: string;
}) {
  const params = new URLSearchParams();
  if (args?.zoneId) params.set('zoneId', args.zoneId);
  if (args?.rating) params.set('rating', args.rating);
  if (args?.fromDate) params.set('fromDate', args.fromDate);
  if (args?.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: ['facilities-advanced', 'zone-inspections', args ?? {}],
    queryFn: async (): Promise<ZoneInspectionDto[]> =>
      apiFetch(PREFIX + '/facilities/zone-inspections' + (qs ? '?' + qs : '')),
  });
}

export function useCreateZoneInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      zoneId: string;
      inspectionDate: string;
      overallRating: 'PASS' | 'NEEDS_IMPROVEMENT' | 'FAIL';
      notes?: string;
      followUpRequired?: boolean;
    }): Promise<ZoneInspectionDto> =>
      apiFetch(PREFIX + '/facilities/zone-inspections', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'zone-inspections'] });
    },
  });
}

// ── Supply transactions + stocktakes ──
export function useSupplyTransactions(args?: {
  inventoryId?: string;
  buildingId?: string;
  transactionType?: string;
  fromDate?: string;
  toDate?: string;
}) {
  const params = new URLSearchParams();
  if (args?.inventoryId) params.set('inventoryId', args.inventoryId);
  if (args?.buildingId) params.set('buildingId', args.buildingId);
  if (args?.transactionType) params.set('transactionType', args.transactionType);
  if (args?.fromDate) params.set('fromDate', args.fromDate);
  if (args?.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: ['facilities-advanced', 'supply-transactions', args ?? {}],
    queryFn: async (): Promise<SupplyTransactionDto[]> =>
      apiFetch(PREFIX + '/facilities/supply-transactions' + (qs ? '?' + qs : '')),
  });
}

export function useCreateSupplyTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      buildingId: string;
      inventoryId: string;
      transactionType: 'RECEIPT' | 'USAGE' | 'ADJUSTMENT' | 'TRANSFER' | 'WRITE_OFF';
      quantityDelta: number;
      referenceId?: string;
      notes?: string;
    }): Promise<SupplyTransactionDto> =>
      apiFetch(PREFIX + '/facilities/supply-transactions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'supply-transactions'] });
    },
  });
}

export function useStocktakes(args?: {
  buildingId?: string;
  status?: 'IN_PROGRESS' | 'COMPLETED';
}) {
  const params = new URLSearchParams();
  if (args?.buildingId) params.set('buildingId', args.buildingId);
  if (args?.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['facilities-advanced', 'stocktakes', args ?? {}],
    queryFn: async (): Promise<StocktakeDto[]> =>
      apiFetch(PREFIX + '/facilities/stocktakes' + (qs ? '?' + qs : '')),
  });
}

export function useCreateStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      buildingId: string;
      stocktakeDate?: string;
      notes?: string;
    }): Promise<StocktakeDto> =>
      apiFetch(PREFIX + '/facilities/stocktakes', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'stocktakes'] });
    },
  });
}

export function useRecordStocktakeItem(stocktakeId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      inventoryId: string;
      expectedQuantity: number;
      actualQuantity: number;
      discrepancyNotes?: string;
    }) =>
      apiFetch(PREFIX + '/facilities/stocktakes/' + stocktakeId + '/items', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'stocktakes'] });
    },
  });
}

export function useCompleteStocktake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (stocktakeId: string): Promise<CompleteStocktakeResponseDto> =>
      apiFetch(PREFIX + '/facilities/stocktakes/' + stocktakeId + '/complete', {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'stocktakes'] });
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'supply-transactions'] });
    },
  });
}

// ── Work order depth ──
export function useWorkOrderAttachments(workOrderId: string | null) {
  return useQuery({
    queryKey: ['facilities-advanced', 'wo-attachments', workOrderId],
    queryFn: async (): Promise<WorkOrderAttachmentDto[]> =>
      apiFetch(PREFIX + '/facilities/work-orders/' + workOrderId + '/attachments'),
    enabled: !!workOrderId,
  });
}

export function useAddWorkOrderAttachment(workOrderId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      s3Key: string;
      filename: string;
      attachmentType?: 'PHOTO_BEFORE' | 'PHOTO_AFTER' | 'QUOTE' | 'INVOICE' | 'REPORT' | 'OTHER';
      fileSizeBytes?: number;
    }): Promise<WorkOrderAttachmentDto> =>
      apiFetch(PREFIX + '/facilities/work-orders/' + workOrderId + '/attachments', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['facilities-advanced', 'wo-attachments', workOrderId],
      });
    },
  });
}

export function useWorkOrderParts(workOrderId: string | null) {
  return useQuery({
    queryKey: ['facilities-advanced', 'wo-parts', workOrderId],
    queryFn: async (): Promise<WorkOrderPartDto[]> =>
      apiFetch(PREFIX + '/facilities/work-orders/' + workOrderId + '/parts'),
    enabled: !!workOrderId,
  });
}

export function useAddWorkOrderPart(workOrderId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      partName: string;
      quantity: number;
      unit?: string;
      unitCost?: number;
      totalCost?: number;
      supplier?: string;
      notes?: string;
    }): Promise<WorkOrderPartDto> =>
      apiFetch(PREFIX + '/facilities/work-orders/' + workOrderId + '/parts', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities-advanced', 'wo-parts', workOrderId] });
      void qc.invalidateQueries({
        queryKey: ['facilities-advanced', 'wo-cost-summary', workOrderId],
      });
    },
  });
}

export function useWorkOrderCostSummary(workOrderId: string | null) {
  return useQuery({
    queryKey: ['facilities-advanced', 'wo-cost-summary', workOrderId],
    queryFn: async (): Promise<WorkOrderCostSummaryDto> =>
      apiFetch(PREFIX + '/facilities/work-orders/' + workOrderId + '/cost-summary'),
    enabled: !!workOrderId,
  });
}
