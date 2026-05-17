import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { assertCanManage, assertEmployeeInCurrentTenant } from './buildings.service';
import { deterministicRouteStopIssueNotedEventId } from './event-ids';
import {
  CleaningCompletionResponseDto,
  CleaningCompletionStatus,
  CleaningRouteResponseDto,
  CleaningRouteShift,
  CleaningRouteStopResponseDto,
  CleaningStopCompletionStatus,
  CreateCleaningRouteDto,
  CreateRouteAssignmentDto,
  RouteAssignmentResponseDto,
  StartRouteCompletionDto,
  StopCompletionResponseDto,
  UpdateCleaningRouteDto,
  UpdateRouteStopsDto,
  UpdateStopCompletionDto,
} from './dto/facilities.dto';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * CleaningRouteService — P2-18a Step 2 (REVIEW-P2C18 BLOCKING 1 update).
 *
 * CRUD for cleaning routes + ordered stops, assignment scheduling, and
 * the route-completion / stop-completion runtime. The keystone is the
 * issues_noted → fac.route_stop.issue_noted emit which downstream
 * triggers the CleaningIssueTicketConsumer to create a tkt_tickets row
 * for follow-up — fulfilling the plan's "Task Worker creates tkt_ticket"
 * contract via the standard "domain emits, consumer materialises"
 * pattern established in Cycles 9 + 10 + 11.
 *
 * REVIEW-P2C18 BLOCKING 1 — the issue_noted emit lives on the platform
 * outbox via OutboxService.enqueueInTx INSIDE the same tenant tx as the
 * stop_completion UPDATE. A broker outage no longer drops the
 * downstream ticket-materialisation step; the OutboxPublisherWorker
 * drains on recovery. Deterministic event_id keyed on the
 * stop_completion id so retries land the same envelope and the
 * consumer's claim-after-success idempotency catches redelivery cleanly.
 */
@Injectable()
export class CleaningRouteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ── Routes + Stops ──

  async listRoutes(includeInactive = false): Promise<CleaningRouteResponseDto[]> {
    const tenant = getCurrentTenant();
    const where = ['r.school_id = $1::uuid'];
    if (!includeInactive) where.push('r.is_active = true');
    const routes = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.school_id::text AS school_id, r.name, r.shift, ' +
          'r.zone_id::text AS zone_id, r.estimated_duration_minutes, r.is_active, ' +
          '(SELECT z.name FROM fac_zones z WHERE z.id = r.zone_id) AS zone_name ' +
          'FROM fac_cleaning_routes r WHERE ' +
          where.join(' AND ') +
          ' ORDER BY r.shift, r.name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      shift: string;
      zone_id: string | null;
      estimated_duration_minutes: number | null;
      is_active: boolean;
      zone_name: string | null;
    }>;
    const out: CleaningRouteResponseDto[] = [];
    for (const r of routes) {
      const stops = await this.listStops(r.id);
      out.push({
        id: r.id,
        schoolId: r.school_id,
        name: r.name,
        shift: r.shift as CleaningRouteShift,
        zoneId: r.zone_id,
        zoneName: r.zone_name,
        estimatedDurationMinutes: r.estimated_duration_minutes,
        isActive: r.is_active,
        stops,
      });
    }
    return out;
  }

  async getRouteById(id: string): Promise<CleaningRouteResponseDto> {
    // REVIEW-P2C18 BLOCKING 3 — school-scope the route fetch. A School A
    // actor with a School B route UUID now collapses to 404 don't-leak-
    // existence rather than reading the foreign-school row.
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.school_id::text AS school_id, r.name, r.shift, ' +
          'r.zone_id::text AS zone_id, r.estimated_duration_minutes, r.is_active, ' +
          '(SELECT z.name FROM fac_zones z WHERE z.id = r.zone_id) AS zone_name ' +
          'FROM fac_cleaning_routes r WHERE r.id = $1::uuid AND r.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      shift: string;
      zone_id: string | null;
      estimated_duration_minutes: number | null;
      is_active: boolean;
      zone_name: string | null;
    }>;
    if (rows.length === 0) throw new NotFoundException('Cleaning route not found');
    const r = rows[0]!;
    const stops = await this.listStops(r.id);
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      shift: r.shift as CleaningRouteShift,
      zoneId: r.zone_id,
      zoneName: r.zone_name,
      estimatedDurationMinutes: r.estimated_duration_minutes,
      isActive: r.is_active,
      stops,
    };
  }

  async createRoute(
    input: CreateCleaningRouteDto,
    actor: ResolvedActor,
  ): Promise<CleaningRouteResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_cleaning_routes (id, school_id, name, shift, zone_id, estimated_duration_minutes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)',
          id,
          tenant.schoolId,
          input.name,
          input.shift,
          input.zoneId ?? null,
          input.estimatedDurationMinutes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A cleaning route with this name already exists in this school',
        );
      }
      throw err;
    }
    return this.getRouteById(id);
  }

  async patchRoute(
    id: string,
    input: UpdateCleaningRouteDto,
    actor: ResolvedActor,
  ): Promise<CleaningRouteResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.shift !== undefined) {
      sets.push('shift = $' + (params.length + 1));
      params.push(input.shift);
    }
    if (input.zoneId !== undefined) {
      sets.push('zone_id = $' + (params.length + 1) + '::uuid');
      params.push(input.zoneId);
    }
    if (input.estimatedDurationMinutes !== undefined) {
      sets.push('estimated_duration_minutes = $' + (params.length + 1));
      params.push(input.estimatedDurationMinutes);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length === 0) return this.getRouteById(id);
    sets.push('updated_at = now()');
    // REVIEW-P2C18 BLOCKING 3 — school-scope the UPDATE. A School A
    // facilities admin with a School B route UUID no longer mutates the
    // foreign-school row. WHERE matches on (id, school_id) — zero-row
    // RETURNING is the 404 signal.
    const tenant = getCurrentTenant();
    params.push(id, tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        const result = (await client.$queryRawUnsafe(
          'UPDATE fac_cleaning_routes SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid RETURNING id',
          ...params,
        )) as Array<{ id: string }>;
        if (result.length === 0) throw new NotFoundException('Cleaning route not found');
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A cleaning route with this name already exists in this school',
        );
      }
      throw err;
    }
    return this.getRouteById(id);
  }

  async listStops(routeId: string): Promise<CleaningRouteStopResponseDto[]> {
    // REVIEW-P2C18 BLOCKING 3 — JOIN the parent route filtered on
    // school_id so a leaked routeId from another school returns []
    // (and the caller's getRouteById has already returned 404 by then).
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.route_id::text AS route_id, s.space_id::text AS space_id, ' +
          's.stop_order, s.estimated_minutes, s.cleaning_tasks, ' +
          '(SELECT sp.name FROM fac_spaces sp WHERE sp.id = s.space_id) AS space_name ' +
          'FROM fac_cleaning_route_stops s ' +
          'JOIN fac_cleaning_routes r ON r.id = s.route_id ' +
          'WHERE s.route_id = $1::uuid AND r.school_id = $2::uuid ORDER BY s.stop_order',
        routeId,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      route_id: string;
      space_id: string;
      stop_order: number;
      estimated_minutes: number | null;
      cleaning_tasks: string[];
      space_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      routeId: r.route_id,
      spaceId: r.space_id,
      spaceName: r.space_name,
      stopOrder: r.stop_order,
      estimatedMinutes: r.estimated_minutes,
      cleaningTasks: r.cleaning_tasks ?? [],
    }));
  }

  /**
   * Bulk-replace the route's stops in one tenant tx. Drag-reorder in the
   * UI sends the new ordered list and the service deletes existing rows
   * then inserts the new ones. Because both UNIQUE(route, stop_order)
   * and UNIQUE(route, space_id) are on the table, a naive UPDATE re-
   * ordering would temporarily collide; the DELETE + INSERT shape is
   * the simplest invariant-safe path. If any insert fails the whole tx
   * rolls back so the route's stop list stays consistent.
   */
  async replaceStops(
    routeId: string,
    input: UpdateRouteStopsDto,
    actor: ResolvedActor,
  ): Promise<CleaningRouteResponseDto> {
    await assertCanManage(actor, this.permCheck);
    // Validate stop_order values are unique within the input.
    const orders = new Set<number>();
    const spaces = new Set<string>();
    for (const s of input.stops) {
      if (orders.has(s.stopOrder)) {
        throw new BadRequestException('Duplicate stop_order in input: ' + s.stopOrder);
      }
      orders.add(s.stopOrder);
      if (spaces.has(s.spaceId)) {
        throw new BadRequestException('Duplicate space_id in input: ' + s.spaceId);
      }
      spaces.add(s.spaceId);
    }
    const tenantRs = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C18 BLOCKING 3 — school-scope the lock. Confirm the
      // parent route exists in THIS tenant before clobbering its stops.
      const route = (await tx.$queryRawUnsafe(
        'SELECT id FROM fac_cleaning_routes WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        routeId,
        tenantRs.schoolId,
      )) as Array<{ id: string }>;
      if (route.length === 0) throw new NotFoundException('Cleaning route not found');
      await tx.$executeRawUnsafe(
        'DELETE FROM fac_cleaning_route_stops WHERE route_id = $1::uuid',
        routeId,
      );
      for (const s of input.stops) {
        await tx.$executeRawUnsafe(
          'INSERT INTO fac_cleaning_route_stops (id, route_id, space_id, stop_order, estimated_minutes, cleaning_tasks) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[])',
          generateId(),
          routeId,
          s.spaceId,
          s.stopOrder,
          s.estimatedMinutes ?? null,
          s.cleaningTasks ?? [],
        );
      }
    });
    return this.getRouteById(routeId);
  }

  // ── Assignments ──

  async listAssignments(routeId: string): Promise<RouteAssignmentResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.route_id::text AS route_id, a.employee_id::text AS employee_id, ' +
          'a.assignment_date::text AS assignment_date, a.is_recurring, a.recurrence_days, ' +
          'a.effective_from::text AS effective_from, a.effective_to::text AS effective_to, ' +
          'a.assigned_by::text AS assigned_by, a.notes, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
          '  JOIN hr_employees e ON e.person_id = ip.id WHERE e.id = a.employee_id) AS employee_name ' +
          'FROM fac_cleaning_route_assignments a WHERE a.route_id = $1::uuid ' +
          'ORDER BY a.is_recurring, a.assignment_date DESC NULLS LAST, a.effective_from DESC NULLS LAST',
        routeId,
      );
    })) as Array<{
      id: string;
      route_id: string;
      employee_id: string;
      assignment_date: string | null;
      is_recurring: boolean;
      recurrence_days: number[] | null;
      effective_from: string | null;
      effective_to: string | null;
      assigned_by: string;
      notes: string | null;
      employee_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      routeId: r.route_id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      assignmentDate: r.assignment_date,
      isRecurring: r.is_recurring,
      recurrenceDays: r.recurrence_days,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      assignedBy: r.assigned_by,
      notes: r.notes,
    }));
  }

  async createAssignment(
    routeId: string,
    input: CreateRouteAssignmentDto,
    actor: ResolvedActor,
  ): Promise<RouteAssignmentResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Assignment creation requires an authenticated person');
    }
    await assertEmployeeInCurrentTenant(this.tenantPrisma, input.employeeId);

    const isRecurring = input.isRecurring === true;
    if (isRecurring) {
      if (!input.recurrenceDays || input.recurrenceDays.length === 0) {
        throw new BadRequestException(
          'Recurring assignments require a non-empty recurrenceDays array',
        );
      }
      if (!input.effectiveFrom) {
        throw new BadRequestException('Recurring assignments require effectiveFrom');
      }
      if (input.assignmentDate) {
        throw new BadRequestException(
          'Recurring assignments cannot carry assignmentDate (use effectiveFrom + effectiveTo)',
        );
      }
    } else {
      if (!input.assignmentDate) {
        throw new BadRequestException('One-off assignments require assignmentDate');
      }
      if (input.recurrenceDays || input.effectiveFrom || input.effectiveTo) {
        throw new BadRequestException(
          'One-off assignments cannot carry recurrenceDays / effectiveFrom / effectiveTo',
        );
      }
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_cleaning_route_assignments (id, route_id, employee_id, assignment_date, is_recurring, recurrence_days, effective_from, effective_to, assigned_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::smallint[], $7::date, $8::date, $9::uuid, $10)',
          id,
          routeId,
          input.employeeId,
          input.assignmentDate ?? null,
          isRecurring,
          input.recurrenceDays ?? null,
          input.effectiveFrom ?? null,
          input.effectiveTo ?? null,
          actor.personId,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A one-off assignment for this route on this date already exists',
        );
      }
      throw err;
    }

    const rows = await this.listAssignments(routeId);
    const found = rows.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Assignment not found after insert');
    return found;
  }

  // ── Completions ──

  async listCompletions(args: {
    fromDate?: string;
    toDate?: string;
    routeId?: string;
    employeeId?: string;
  }): Promise<CleaningCompletionResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = [
      'r.school_id = $1::uuid',
      'c.completion_date >= $2::date',
      'c.completion_date <= $3::date',
    ];
    const params: unknown[] = [
      tenant.schoolId,
      args.fromDate ?? todayIso(-30),
      args.toDate ?? todayIso(0),
    ];
    if (args.routeId) {
      where.push('c.route_id = $' + (params.length + 1) + '::uuid');
      params.push(args.routeId);
    }
    if (args.employeeId) {
      where.push('c.employee_id = $' + (params.length + 1) + '::uuid');
      params.push(args.employeeId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        COMPLETION_SELECT + ' WHERE ' + where.join(' AND ') + ' ORDER BY c.completion_date DESC',
        ...params,
      );
    })) as CompletionRow[];
    const out: CleaningCompletionResponseDto[] = [];
    for (const r of rows) {
      const stops = await this.listStopCompletions(r.id);
      out.push(completionRowToDto(r, stops));
    }
    return out;
  }

  async getCompletionById(id: string): Promise<CleaningCompletionResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(COMPLETION_SELECT + ' WHERE c.id = $1::uuid LIMIT 1', id);
    })) as CompletionRow[];
    if (rows.length === 0) throw new NotFoundException('Route completion not found');
    const stops = await this.listStopCompletions(id);
    return completionRowToDto(rows[0]!, stops);
  }

  /**
   * Start a route completion run. Creates the parent completion row in
   * IN_PROGRESS plus one stop_completion row per stop in PENDING — all
   * in one tenant tx so the run starts with the full checklist pre-
   * materialised. The custodian then walks the checklist via
   * patchStopCompletion.
   */
  async startCompletion(
    input: StartRouteCompletionDto,
    actor: ResolvedActor,
  ): Promise<CleaningCompletionResponseDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException('Route completion requires an employee record');
    }
    const completionId = generateId();
    const completionDate = input.completionDate ?? todayIso(0);
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // Validate route + assignment belong to this tenant + are linked.
        const route = (await tx.$queryRawUnsafe(
          'SELECT id FROM fac_cleaning_routes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          input.routeId,
          getCurrentTenant().schoolId,
        )) as Array<{ id: string }>;
        if (route.length === 0) {
          throw new BadRequestException('routeId does not match an active route in this school');
        }
        const assignment = (await tx.$queryRawUnsafe(
          'SELECT id FROM fac_cleaning_route_assignments WHERE id = $1::uuid AND route_id = $2::uuid LIMIT 1',
          input.assignmentId,
          input.routeId,
        )) as Array<{ id: string }>;
        if (assignment.length === 0) {
          throw new BadRequestException('assignmentId does not match an assignment on this route');
        }

        await tx.$executeRawUnsafe(
          'INSERT INTO fac_cleaning_route_completions ' +
            '(id, route_id, assignment_id, employee_id, completion_date, started_at, overall_status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, now(), 'IN_PROGRESS')",
          completionId,
          input.routeId,
          input.assignmentId,
          actor.employeeId,
          completionDate,
        );

        const stops = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM fac_cleaning_route_stops WHERE route_id = $1::uuid ORDER BY stop_order',
          input.routeId,
        )) as Array<{ id: string }>;
        for (const s of stops) {
          await tx.$executeRawUnsafe(
            "INSERT INTO fac_cleaning_route_stop_completions (id, completion_id, stop_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')",
            generateId(),
            completionId,
            s.id,
          );
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A completion for this (route, custodian, date) tuple already exists',
        );
      }
      throw err;
    }
    return this.getCompletionById(completionId);
  }

  /**
   * Mark a stop as COMPLETED or SKIPPED. THE KEYSTONE — when
   * issues_noted is non-empty, emits fac.route_stop.issue_noted so the
   * CleaningIssueTicketConsumer creates a tkt_tickets row for follow-up.
   * Also recomputes the parent completion's overall_status — COMPLETED
   * if every stop is now COMPLETED, PARTIAL if any are SKIPPED, else
   * IN_PROGRESS.
   */
  async patchStopCompletion(
    completionId: string,
    stopId: string,
    input: UpdateStopCompletionDto,
    actor: ResolvedActor,
  ): Promise<StopCompletionResponseDto> {
    if (!actor.personId) {
      throw new ForbiddenException('Stop completion requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    if (input.status === 'SKIPPED') {
      if (!input.skipReason || input.skipReason.trim().length === 0) {
        throw new BadRequestException('SKIPPED stops require a non-empty skipReason');
      }
    }

    let scIdRow: string | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock parent completion + verify it belongs to this tenant.
      const compl = (await tx.$queryRawUnsafe(
        'SELECT c.id::text AS id, c.route_id::text AS route_id, c.overall_status, c.employee_id::text AS employee_id ' +
          'FROM fac_cleaning_route_completions c ' +
          'JOIN fac_cleaning_routes r ON r.id = c.route_id ' +
          'WHERE c.id = $1::uuid AND r.school_id = $2::uuid FOR UPDATE OF c',
        completionId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        route_id: string;
        overall_status: string;
        employee_id: string;
      }>;
      if (compl.length === 0) throw new NotFoundException('Route completion not found');
      const parent = compl[0]!;

      // Lock + read the existing stop_completion row.
      const existing = (await tx.$queryRawUnsafe(
        'SELECT sc.id::text AS id, sc.status, sc.stop_id::text AS stop_id, ' +
          's.space_id::text AS space_id ' +
          'FROM fac_cleaning_route_stop_completions sc ' +
          'JOIN fac_cleaning_route_stops s ON s.id = sc.stop_id ' +
          'WHERE sc.completion_id = $1::uuid AND sc.stop_id = $2::uuid FOR UPDATE OF sc',
        completionId,
        stopId,
      )) as Array<{
        id: string;
        status: string;
        stop_id: string;
        space_id: string;
      }>;
      if (existing.length === 0) {
        throw new NotFoundException('Stop completion row not found for this stop');
      }
      const row = existing[0]!;
      scIdRow = row.id;

      const newStatus = input.status ?? row.status;
      const completedAt = newStatus === 'COMPLETED' || newStatus === 'SKIPPED' ? 'now()' : 'NULL';

      const sets: string[] = [];
      const params: unknown[] = [];
      sets.push('status = $' + (params.length + 1));
      params.push(newStatus);
      sets.push('completed_at = ' + completedAt);
      if (input.skipReason !== undefined) {
        sets.push('skip_reason = $' + (params.length + 1));
        params.push(input.skipReason);
      } else if (newStatus !== 'SKIPPED') {
        sets.push('skip_reason = NULL');
      }
      if (input.tasksCompleted !== undefined) {
        sets.push('tasks_completed = $' + (params.length + 1) + '::text[]');
        params.push(input.tasksCompleted);
      }
      if (input.photoS3Keys !== undefined) {
        sets.push('photo_s3_keys = $' + (params.length + 1) + '::text[]');
        params.push(input.photoS3Keys);
      }
      if (input.issuesNoted !== undefined) {
        sets.push('issues_noted = $' + (params.length + 1));
        params.push(input.issuesNoted);
      }
      sets.push('updated_at = now()');
      params.push(row.id);

      await tx.$executeRawUnsafe(
        'UPDATE fac_cleaning_route_stop_completions SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );

      // Recompute parent overall_status.
      const summary = (await tx.$queryRawUnsafe(
        "SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending, " +
          "COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped, " +
          'COUNT(*)::int AS total ' +
          'FROM fac_cleaning_route_stop_completions WHERE completion_id = $1::uuid',
        completionId,
      )) as Array<{ pending: number; skipped: number; total: number }>;
      const s = summary[0]!;
      let nextOverall: CleaningCompletionStatus;
      if (s.pending > 0) {
        nextOverall = 'IN_PROGRESS';
      } else if (s.skipped > 0) {
        nextOverall = 'PARTIAL';
      } else {
        nextOverall = 'COMPLETED';
      }
      if (nextOverall !== parent.overall_status) {
        const completedAtSql =
          nextOverall === 'COMPLETED' || nextOverall === 'PARTIAL' ? 'now()' : 'NULL';
        await tx.$executeRawUnsafe(
          'UPDATE fac_cleaning_route_completions SET overall_status = $1, completed_at = ' +
            completedAtSql +
            ', updated_at = now() WHERE id = $2::uuid',
          nextOverall,
          completionId,
        );
      }

      // REVIEW-P2C18 BLOCKING 1 — enqueue the durable issue_noted event
      // INSIDE the tenant tx via OutboxService.enqueueInTx. The outbox
      // row commits with the parent UPDATE so a broker outage no longer
      // drops the downstream ticket-materialisation. Deterministic
      // event_id keyed on the stop_completion id so the publisher's
      // claim-after-success idempotency catches redelivery cleanly.
      if (
        input.issuesNoted !== undefined &&
        input.issuesNoted !== null &&
        input.issuesNoted.trim().length > 0
      ) {
        await this.outbox.enqueueInTx(tx, {
          topic: 'fac.route_stop.issue_noted',
          key: row.id,
          sourceModule: 'facilities',
          eventId: deterministicRouteStopIssueNotedEventId(row.id),
          payload: {
            sourceRefId: row.id,
            stopCompletionId: row.id,
            completionId: completionId,
            routeId: parent.route_id,
            stopId: row.stop_id,
            spaceId: row.space_id,
            issuesNoted: input.issuesNoted,
            reportedByAccountId: actor.accountId,
            schoolId: tenant.schoolId,
          },
        });
      }
    });

    if (!scIdRow) throw new NotFoundException('Stop completion row not found');
    const stopCompletions = await this.listStopCompletions(completionId);
    const target = stopCompletions.find((s) => s.stopId === stopId);
    if (!target) throw new NotFoundException('Stop completion row not found after update');
    return target;
  }

  private async listStopCompletions(completionId: string): Promise<StopCompletionResponseDto[]> {
    // REVIEW-P2C18 BLOCKING 3 — JOIN through fac_cleaning_route_completions
    // and fac_cleaning_routes filtered on school_id so a leaked completionId
    // from another school returns [].
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT sc.id::text AS id, sc.completion_id::text AS completion_id, sc.stop_id::text AS stop_id, ' +
          'sc.status, sc.completed_at, sc.skip_reason, sc.tasks_completed, sc.photo_s3_keys, sc.issues_noted ' +
          'FROM fac_cleaning_route_stop_completions sc ' +
          'JOIN fac_cleaning_route_stops s ON s.id = sc.stop_id ' +
          'JOIN fac_cleaning_route_completions c ON c.id = sc.completion_id ' +
          'JOIN fac_cleaning_routes r ON r.id = c.route_id ' +
          'WHERE sc.completion_id = $1::uuid AND r.school_id = $2::uuid ORDER BY s.stop_order',
        completionId,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      completion_id: string;
      stop_id: string;
      status: string;
      completed_at: Date | null;
      skip_reason: string | null;
      tasks_completed: string[];
      photo_s3_keys: string[];
      issues_noted: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      completionId: r.completion_id,
      stopId: r.stop_id,
      status: r.status as CleaningStopCompletionStatus,
      completedAt: r.completed_at ? r.completed_at.toISOString() : null,
      skipReason: r.skip_reason,
      tasksCompleted: r.tasks_completed ?? [],
      photoS3Keys: r.photo_s3_keys ?? [],
      issuesNoted: r.issues_noted,
    }));
  }
}

const COMPLETION_SELECT =
  'SELECT c.id::text AS id, c.route_id::text AS route_id, ' +
  '(SELECT r.name FROM fac_cleaning_routes r WHERE r.id = c.route_id) AS route_name, ' +
  'c.assignment_id::text AS assignment_id, c.employee_id::text AS employee_id, ' +
  'c.completion_date::text AS completion_date, c.started_at, c.completed_at, c.overall_status, c.notes, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN hr_employees e ON e.person_id = ip.id WHERE e.id = c.employee_id) AS employee_name ' +
  'FROM fac_cleaning_route_completions c JOIN fac_cleaning_routes r ON r.id = c.route_id';

interface CompletionRow {
  id: string;
  route_id: string;
  route_name: string | null;
  assignment_id: string;
  employee_id: string;
  completion_date: string;
  started_at: Date | null;
  completed_at: Date | null;
  overall_status: string;
  notes: string | null;
  employee_name: string | null;
}

function completionRowToDto(
  r: CompletionRow,
  stops: StopCompletionResponseDto[],
): CleaningCompletionResponseDto {
  return {
    id: r.id,
    routeId: r.route_id,
    routeName: r.route_name,
    assignmentId: r.assignment_id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    completionDate: r.completion_date,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    overallStatus: r.overall_status as CleaningCompletionStatus,
    notes: r.notes,
    stopCompletions: stops,
  };
}

function todayIso(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
