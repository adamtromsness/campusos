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
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CancelPreorderDto,
  CreatePreorderDto,
  CreatePreorderWindowDto,
  GenerateProductionReportDto,
  PreorderItemResponseDto,
  PreorderResponseDto,
  PreorderStatus,
  PreorderWindowResponseDto,
  ProductionReportDietaryRowDto,
  ProductionReportItemRowDto,
  ProductionReportResponseDto,
  UpdatePreorderWindowDto,
} from './dto/food-service-advanced.dto';
import { isUniqueViolation } from './food-service.errors';

/**
 * PreorderService — Phase 2 Cycle 10 sub-cycle b (P2-10b).
 *
 * Three load-bearing responsibilities:
 *
 *   1. Pre-order window catalogue. Admins (school admin OR FSM staff)
 *      create per-(date, meal_type) windows that gate when students
 *      and parents may submit orders. The window_chk schema invariant
 *      enforces closes_at > opens_at; PreorderService.isWindowOpen()
 *      enforces opens_at <= now() <= closes_at at submit time.
 *
 *   2. Pre-order with allergen cross-check KEYSTONE.
 *      POST /preorders runs the cross-check pipeline BEFORE the order
 *      is persisted:
 *        a) Resolve fds_student_allergen_alerts WHERE student_id and
 *           is_active=true (the POS read model from Cycle 20, now
 *           live-synced via the AllergyAlertConsumer Kafka listener
 *           per REVIEW-FINAL-2026-05-07 MAJ-5.1).
 *        b) For each menu_item, intersect menu_item.allergen_codes
 *           against the active alerts.
 *        c) CRITICAL severity matches BLOCK with a 422 ConflictException
 *           carrying the offending allergen code(s). The order is NOT
 *           persisted.
 *        d) WARNING severity matches FLAG the order — allergen_check_passed
 *           lands true (the order is allowed) but warning_allergens
 *           captures the codes for parent visibility.
 *        e) INFO severity matches are recorded but do not influence
 *           the flag.
 *      Mirrors Cycle 20 POS allergen cross-check (TransactionService)
 *      but applied at the upstream pre-order layer so parents get
 *      pre-flight feedback.
 *
 *   3. Production report aggregation. POST /preorders/production-report
 *      aggregates every CONFIRMED preorder for a given
 *      (school, service_date, meal_type) slot into:
 *        - itemBreakdown: per-menu-item totals (quantity + order count)
 *        - dietaryBreakdown: per-allergen affected-order counts
 *      The aggregate is UPSERTed via UNIQUE(school, date, meal_type)
 *      so regeneration replaces the previous report.
 *
 * Row scope (visibility): admins / FSM staff see every preorder in
 * tenant; STUDENT sees own preorders via platform_students.person_id;
 * GUARDIAN sees own children's preorders via sis_student_guardians.
 */
@Injectable()
export class PreorderService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ─── Window management ──────────────────────────────────────────────

  /**
   * REVIEW-P2C10 ROUND 2 BLOCKING 3 — every FSM admin operation
   * in PreorderService (window CRUD, confirm, generate production
   * report, list-all visibility, window-gate bypass, cancel admin
   * override, on-behalf ordering) now gates on FDS-006:write
   * instead of the broad `personType === 'STAFF'` shortcut. Matches
   * the P2-10a fix that the same review surfaced for recipe /
   * inventory / transfer / staff-meal.
   *
   * Returns true when the actor holds FSM admin authority OR is the
   * school admin. Cached per request via the IAM cache so the cost
   * of this check on the hot pre-order path is a single in-memory
   * lookup, not a fresh DB read.
   */
  private async isFsmAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'fds-006:write',
    ]);
  }

  private async assertCanManageWindows(actor: ResolvedActor): Promise<void> {
    if (await this.isFsmAdmin(actor)) return;
    throw new ForbiddenException(
      'Only school admins or Food Service administrators (FDS-006:write) can manage preorder windows',
    );
  }

  async listWindows(args: { onlyOpen?: boolean }): Promise<PreorderWindowResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.onlyOpen) {
      where.push('opens_at <= now() AND closes_at >= now()');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, service_date, meal_type, opens_at, closes_at, notes, created_by::text AS created_by, created_at ' +
          'FROM fds_preorder_windows WHERE ' +
          where.join(' AND ') +
          ' ORDER BY service_date, meal_type',
        ...params,
      );
    })) as PreorderWindowRow[];
    return rows.map(windowRowToDto);
  }

  async getWindowById(id: string): Promise<PreorderWindowResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, service_date, meal_type, opens_at, closes_at, notes, created_by::text AS created_by, created_at ' +
          'FROM fds_preorder_windows WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as PreorderWindowRow[];
    if (rows.length === 0) throw new NotFoundException('Preorder window not found');
    return windowRowToDto(rows[0]!);
  }

  async createWindow(
    input: CreatePreorderWindowDto,
    actor: ResolvedActor,
  ): Promise<PreorderWindowResponseDto> {
    await this.assertCanManageWindows(actor);
    const opens = new Date(input.opensAt);
    const closes = new Date(input.closesAt);
    if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) {
      throw new BadRequestException('opensAt and closesAt must be valid ISO timestamps');
    }
    if (closes.getTime() <= opens.getTime()) {
      throw new BadRequestException('closesAt must be strictly after opensAt');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_preorder_windows (id, school_id, service_date, meal_type, opens_at, closes_at, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::timestamptz, $6::timestamptz, $7, $8::uuid)',
          id,
          tenant.schoolId,
          input.serviceDate,
          input.mealType,
          input.opensAt,
          input.closesAt,
          input.notes ?? null,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A preorder window already exists for this school + service date + meal type',
        );
      }
      throw err;
    }
    return this.getWindowById(id);
  }

  async patchWindow(
    id: string,
    input: UpdatePreorderWindowDto,
    actor: ResolvedActor,
  ): Promise<PreorderWindowResponseDto> {
    await this.assertCanManageWindows(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.opensAt !== undefined) {
      sets.push('opens_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.opensAt);
    }
    if (input.closesAt !== undefined) {
      sets.push('closes_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.closesAt);
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + (params.length + 1));
      params.push(input.notes);
    }
    if (sets.length === 0) return this.getWindowById(id);
    sets.push('updated_at = now()');
    params.push(id);
    const tenant = getCurrentTenant();
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE fds_preorder_windows SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          (params.length - 1) +
          '::uuid AND school_id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Preorder window not found');
    });
    return this.getWindowById(id);
  }

  // ─── Pre-order CRUD with allergen cross-check ──────────────────────

  /**
   * Visibility row-scope. FSM admin (school admin OR FDS-006:write)
   * sees all; STUDENT sees own preorders; GUARDIAN sees own
   * children's preorders. Mirrors AllergenAlertService.
   *
   * REVIEW-P2C10 ROUND 2 BLOCKING 1 — STUDENT branch JOIN adds
   * `s.school_id = $tenant.schoolId`. GUARDIAN branch sub-query JOIN
   * adds `JOIN sis_students s ON s.id = sg.student_id AND
   * s.school_id = $tenant.schoolId`. A guardian linked to children
   * across multiple schools (Cycle 6.1 / parent polish path) cannot
   * see another school's preorders here even though the linkage row
   * exists in the platform schema.
   *
   * REVIEW-P2C10 ROUND 2 BLOCKING 3 — admin-all bypass routes through
   * `isFsmAdmin` instead of accepting any STAFF persona.
   */
  private async buildVisibilityFilter(
    actor: ResolvedActor,
  ): Promise<{ where: string; params: unknown[] }> {
    if (await this.isFsmAdmin(actor)) {
      return { where: '', params: [] };
    }
    const tenant = getCurrentTenant();
    if (actor.personType === 'STUDENT') {
      // Resolve the actor's own sis_students.id WITHIN this tenant
      // and bind to it. The s.school_id predicate prevents a
      // cross-school identity sharing the same iam_person from
      // resolving to a foreign-school student row.
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.school_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
          tenant.schoolId,
          actor.personId,
        );
      })) as Array<{ id: string }>;
      if (rows.length === 0) return { where: 'AND false', params: [] };
      return { where: 'AND p.student_id = $::uuid', params: [rows[0]!.id] };
    }
    if (actor.personType === 'GUARDIAN') {
      return {
        where:
          'AND p.student_id IN (SELECT sg.student_id FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'JOIN sis_students s ON s.id = sg.student_id AND s.school_id = $::uuid ' +
          'WHERE g.person_id = $::uuid)',
        params: [tenant.schoolId, actor.personId],
      };
    }
    return { where: 'AND false', params: [] };
  }

  /**
   * Build a parameterised WHERE clause from a visibility filter, threading
   * parameters into the supplied builder so the caller can append further
   * conditions on top.
   */
  private materialiseVisibility(
    filter: { where: string; params: unknown[] },
    nextParamIndex: number,
  ): { sql: string; appendedParams: unknown[] } {
    if (filter.where === '') return { sql: '', appendedParams: [] };
    let sql = filter.where;
    let idx = nextParamIndex;
    for (let i = 0; i < filter.params.length; i++) {
      sql = sql.replace('$::uuid', '$' + idx + '::uuid');
      idx += 1;
    }
    return { sql, appendedParams: filter.params };
  }

  async listPreorders(
    args: { windowId?: string; status?: PreorderStatus },
    actor: ResolvedActor,
  ): Promise<PreorderResponseDto[]> {
    const tenant = getCurrentTenant();
    const filter = await this.buildVisibilityFilter(actor);
    const where: string[] = ['p.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.windowId) {
      where.push('p.preorder_window_id = $' + (params.length + 1) + '::uuid');
      params.push(args.windowId);
    }
    if (args.status) {
      where.push('p.status = $' + (params.length + 1));
      params.push(args.status);
    }
    const vis = this.materialiseVisibility(filter, params.length + 1);
    if (vis.sql) {
      where.push(vis.sql.replace(/^AND\s*/, ''));
      params.push(...vis.appendedParams);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PREORDER_BASE + 'WHERE ' + where.join(' AND ') + ORDER_BY_PREORDER,
        ...params,
      );
    })) as PreorderHeaderRow[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const items = await this.loadItems(ids);
    return rows.map((r) => assemblePreorder(r, items.get(r.id) ?? []));
  }

  async getPreorderById(id: string, actor: ResolvedActor): Promise<PreorderResponseDto> {
    const tenant = getCurrentTenant();
    const filter = await this.buildVisibilityFilter(actor);
    const params: unknown[] = [id, tenant.schoolId];
    let where = 'p.id = $1::uuid AND p.school_id = $2::uuid';
    const vis = this.materialiseVisibility(filter, params.length + 1);
    if (vis.sql) {
      where += ' ' + vis.sql;
      params.push(...vis.appendedParams);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PREORDER_BASE + 'WHERE ' + where + ' LIMIT 1',
        ...params,
      );
    })) as PreorderHeaderRow[];
    if (rows.length === 0) throw new NotFoundException('Preorder not found');
    const items = await this.loadItems([id]);
    return assemblePreorder(rows[0]!, items.get(id) ?? []);
  }

  /**
   * Submit a new pre-order. THE ALLERGEN CROSS-CHECK KEYSTONE.
   *
   * Pipeline:
   *  - Validate window is OPEN at submit time.
   *  - Resolve actor row-scope (parent of supplied student, or student
   *    submitting for own studentId, or admin override).
   *  - Resolve every menu_item_id against fds_menu_items and refuse
   *    cross-school references.
   *  - Run the cross-check: for each item, intersect allergen_codes
   *    against active fds_student_allergen_alerts WHERE student_id and
   *    is_active=true. CRITICAL matches BLOCK (422); WARNING matches
   *    surface in the response but the order persists with
   *    allergen_check_passed=true.
   *  - INSERT preorder + preorder_items inside one tenant tx and stamp
   *    status=PENDING. Confirmation is a separate admin action OR
   *    auto-confirm when the parent decision flow is satisfied.
   */
  async createPreorder(
    input: CreatePreorderDto,
    actor: ResolvedActor,
  ): Promise<PreorderResponseDto> {
    if (!input.items || input.items.length === 0) {
      throw new BadRequestException('At least one menu item is required');
    }
    const tenant = getCurrentTenant();

    // Window lookup + open check
    const windowRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, service_date, meal_type, opens_at, closes_at ' +
          'FROM fds_preorder_windows WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.preorderWindowId,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      service_date: Date;
      meal_type: string;
      opens_at: Date;
      closes_at: Date;
    }>;
    if (windowRows.length === 0) throw new NotFoundException('Preorder window not found');
    const win = windowRows[0]!;
    const now = Date.now();
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — window-gate bypass now routes
    // through isFsmAdmin so a generic STAFF actor without FDS-006
    // cannot submit preorders against a closed window.
    const isFsmAdmin = await this.isFsmAdmin(actor);
    if (!isFsmAdmin && (now < win.opens_at.getTime() || now > win.closes_at.getTime())) {
      throw new BadRequestException(
        'Preorder window is not currently open. opensAt=' +
          win.opens_at.toISOString() +
          ' closesAt=' +
          win.closes_at.toISOString(),
      );
    }

    // Student row-scope: STUDENT can only order for self; GUARDIAN
    // can only order for own children; FSM admin can order on
    // behalf of any current-tenant student. REVIEW-P2C10 ROUND 2
    // BLOCKING 2 — even the admin/FSM on-behalf path validates
    // that the studentId resolves to a CURRENT-TENANT sis_students
    // row before the insert.
    await this.assertCanOrderForStudent(input.studentId, actor);

    // Resolve menu items + allergens
    const menuItemIds = input.items.map((it) => it.menuItemId);
    const menuRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, name, allergen_codes, is_active, is_preorderable ' +
          'FROM fds_menu_items WHERE school_id = $1::uuid AND id = ANY($2::uuid[])',
        tenant.schoolId,
        menuItemIds,
      );
    })) as Array<{
      id: string;
      name: string;
      allergen_codes: string[];
      is_active: boolean;
      is_preorderable: boolean;
    }>;
    const menuById = new Map(menuRows.map((r) => [r.id, r]));
    for (const it of input.items) {
      const m = menuById.get(it.menuItemId);
      if (!m) {
        throw new BadRequestException(
          'menuItemId ' + it.menuItemId + ' does not match a menu item in this school',
        );
      }
      if (!m.is_active) {
        throw new BadRequestException(
          'menuItemId ' + it.menuItemId + ' (' + m.name + ') is not active',
        );
      }
      if (!m.is_preorderable) {
        throw new BadRequestException(
          'menuItemId ' + it.menuItemId + ' (' + m.name + ') is not preorderable',
        );
      }
    }

    // Allergen cross-check (THE KEYSTONE)
    const alertRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT allergen_code, severity FROM fds_student_allergen_alerts ' +
          'WHERE student_id = $1::uuid AND school_id = $2::uuid AND is_active = true',
        input.studentId,
        tenant.schoolId,
      );
    })) as Array<{ allergen_code: string; severity: string }>;
    const blockingMatches = new Set<string>();
    const warningMatches = new Set<string>();
    for (const it of input.items) {
      const m = menuById.get(it.menuItemId)!;
      for (const code of m.allergen_codes ?? []) {
        const alert = alertRows.find((a) => a.allergen_code === code);
        if (!alert) continue;
        if (alert.severity === 'CRITICAL') blockingMatches.add(code);
        else if (alert.severity === 'WARNING') warningMatches.add(code);
      }
    }

    if (blockingMatches.size > 0) {
      const codes = Array.from(blockingMatches).sort().join(', ');
      throw new ConflictException(
        'BLOCKED: this order contains items with a CRITICAL allergen alert for the student (' +
          codes +
          '). The order was not submitted.',
      );
    }

    // Persist inside one tx
    const preorderId = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO fds_meal_preorders (id, school_id, student_id, preorder_window_id, ordered_by, status, allergen_check_passed, blocking_allergens, warning_allergens, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PENDING', true, ARRAY[]::TEXT[], $6::text[], $7)",
          preorderId,
          tenant.schoolId,
          input.studentId,
          input.preorderWindowId,
          actor.accountId,
          Array.from(warningMatches).sort(),
          input.notes ?? null,
        );
        for (const it of input.items) {
          await tx.$executeRawUnsafe(
            'INSERT INTO fds_meal_preorder_items (id, preorder_id, menu_item_id, quantity, notes) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
            generateId(),
            preorderId,
            it.menuItemId,
            it.quantity ?? 1,
            it.notes ?? null,
          );
        }
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'Student already has a preorder for this window. Cancel the existing one first.',
        );
      }
      throw err;
    }
    return this.getPreorderById(preorderId, actor);
  }

  /**
   * Confirm a PENDING preorder. Admin path; the row's
   * allergen_check_passed must already be true (the createPreorder
   * keystone guarantees that — any CRITICAL match would have thrown
   * before the row landed). Stamps confirmed_at + flips status to
   * CONFIRMED inside a locked tx.
   */
  async confirmPreorder(id: string, actor: ResolvedActor): Promise<PreorderResponseDto> {
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — FSM admin gate via FDS-006.
    if (!(await this.isFsmAdmin(actor))) {
      throw new ForbiddenException(
        'Only school admins or Food Service administrators (FDS-006:write) can confirm preorders',
      );
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT status, allergen_check_passed FROM fds_meal_preorders WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ status: string; allergen_check_passed: boolean }>;
      if (rows.length === 0) throw new NotFoundException('Preorder not found');
      const row = rows[0]!;
      if (row.status === 'CONFIRMED') return;
      if (row.status === 'CANCELLED') {
        throw new BadRequestException('Cannot confirm a CANCELLED preorder');
      }
      if (!row.allergen_check_passed) {
        throw new BadRequestException(
          'Preorder cannot be confirmed because allergen_check_passed is false. Cancel and resubmit without the blocking items.',
        );
      }
      // REVIEW-P2C10 ROUND 3 PASS closeout — defence-in-depth: the
      // FOR UPDATE lock above already pins the row by (id, school_id)
      // and the entire flow runs inside one tenant tx, so this UPDATE
      // can only touch that row. We still carry the school predicate
      // through the UPDATE itself to match the Phase 2 style guide
      // and keep a single grep pattern for "every tenant write
      // includes school_id".
      await tx.$executeRawUnsafe(
        "UPDATE fds_meal_preorders SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid",
        id,
        tenant.schoolId,
      );
    });
    return this.getPreorderById(id, actor);
  }

  /**
   * Cancel a preorder. Owner-or-admin row-scope. Stamps cancelled_at +
   * cancellation_reason in same locked tx as the status flip.
   */
  async cancelPreorder(
    id: string,
    input: CancelPreorderDto,
    actor: ResolvedActor,
  ): Promise<PreorderResponseDto> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT status, ordered_by::text AS ordered_by, student_id::text AS student_id FROM fds_meal_preorders ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ status: string; ordered_by: string; student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Preorder not found');
      const row = rows[0]!;
      // REVIEW-P2C10 ROUND 2 BLOCKING 3 — admin override path uses
      // FDS-006 FSM admin scope, not blanket STAFF persona.
      const isFsmAdmin = await this.isFsmAdmin(actor);
      if (!isFsmAdmin && row.ordered_by !== actor.accountId) {
        // Allow guardians/students who can see the order to cancel
        // their own. Re-use the visibility check (which also
        // school-scopes the student lookup post Round 2 BLOCKING 1).
        await this.assertCanOrderForStudent(row.student_id, actor);
      }
      if (row.status === 'CANCELLED') return;
      // REVIEW-P2C10 ROUND 3 PASS closeout — same defence-in-depth as
      // confirmPreorder. The FOR UPDATE lock above pins the row by
      // (id, school_id); the UPDATE carries the school predicate too
      // so the Phase 2 "every tenant write includes school_id" style
      // holds across the codebase.
      await tx.$executeRawUnsafe(
        "UPDATE fds_meal_preorders SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = $1, " +
          'confirmed_at = CASE WHEN status = ' +
          "'CONFIRMED'" +
          ' THEN confirmed_at ELSE NULL END, ' +
          'updated_at = now() WHERE id = $2::uuid AND school_id = $3::uuid',
        input.reason ?? null,
        id,
        tenant.schoolId,
      );
    });
    return this.getPreorderById(id, actor);
  }

  // ─── Production reports ─────────────────────────────────────────────

  /**
   * Generate (or regenerate) the production planning report for a
   * (school, service_date, meal_type) slot. Aggregates every CONFIRMED
   * preorder for that slot into per-menu-item totals and per-allergen
   * affected-order counts. UNIQUE(school, date, meal_type) means
   * regeneration UPDATEs the existing row in place.
   */
  async generateProductionReport(
    input: GenerateProductionReportDto,
    actor: ResolvedActor,
  ): Promise<ProductionReportResponseDto> {
    // REVIEW-P2C10 ROUND 2 BLOCKING 3 — FSM admin gate via FDS-006.
    if (!(await this.isFsmAdmin(actor))) {
      throw new ForbiddenException(
        'Only school admins or Food Service administrators (FDS-006:write) can generate production reports',
      );
    }
    const tenant = getCurrentTenant();
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const itemRows = (await client.$queryRawUnsafe(
        'SELECT mi.id::text AS menu_item_id, mi.name AS menu_item_name, ' +
          'SUM(i.quantity)::int AS total_quantity, COUNT(DISTINCT p.id)::int AS order_count ' +
          'FROM fds_meal_preorders p ' +
          'JOIN fds_preorder_windows w ON w.id = p.preorder_window_id ' +
          'JOIN fds_meal_preorder_items i ON i.preorder_id = p.id ' +
          'JOIN fds_menu_items mi ON mi.id = i.menu_item_id ' +
          "WHERE p.school_id = $1::uuid AND p.status = 'CONFIRMED' " +
          'AND w.service_date = $2::date AND w.meal_type = $3 ' +
          'GROUP BY mi.id, mi.name ORDER BY mi.name',
        tenant.schoolId,
        input.serviceDate,
        input.mealType,
      )) as Array<{
        menu_item_id: string;
        menu_item_name: string;
        total_quantity: number;
        order_count: number;
      }>;
      const dietRows = (await client.$queryRawUnsafe(
        'SELECT UNNEST(mi.allergen_codes) AS allergen, COUNT(DISTINCT p.id)::int AS affected_orders ' +
          'FROM fds_meal_preorders p ' +
          'JOIN fds_preorder_windows w ON w.id = p.preorder_window_id ' +
          'JOIN fds_meal_preorder_items i ON i.preorder_id = p.id ' +
          'JOIN fds_menu_items mi ON mi.id = i.menu_item_id ' +
          "WHERE p.school_id = $1::uuid AND p.status = 'CONFIRMED' " +
          'AND w.service_date = $2::date AND w.meal_type = $3 ' +
          'GROUP BY allergen HAVING COUNT(DISTINCT p.id) > 0 ORDER BY allergen',
        tenant.schoolId,
        input.serviceDate,
        input.mealType,
      )) as Array<{ allergen: string; affected_orders: number }>;
      const orderCount = (await client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM fds_meal_preorders p ' +
          'JOIN fds_preorder_windows w ON w.id = p.preorder_window_id ' +
          "WHERE p.school_id = $1::uuid AND p.status = 'CONFIRMED' " +
          'AND w.service_date = $2::date AND w.meal_type = $3',
        tenant.schoolId,
        input.serviceDate,
        input.mealType,
      )) as Array<{ n: number }>;
      return {
        items: itemRows,
        diet: dietRows,
        totalOrders: orderCount[0]?.n ?? 0,
      };
    });

    const totalItems = result.items.reduce((sum, r) => sum + Number(r.total_quantity), 0);
    const reportData = {
      itemBreakdown: result.items.map((r) => ({
        menuItemId: r.menu_item_id,
        menuItemName: r.menu_item_name,
        totalQuantity: Number(r.total_quantity),
        orderCount: Number(r.order_count),
      })),
      dietaryBreakdown: result.diet.map((d) => ({
        allergen: d.allergen,
        affectedOrders: Number(d.affected_orders),
      })),
    };

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fds_preorder_production_reports (id, school_id, service_date, meal_type, total_orders, total_items, report_data, generated_by, generated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::jsonb, $8::uuid, now()) ' +
          'ON CONFLICT (school_id, service_date, meal_type) DO UPDATE SET ' +
          'total_orders = EXCLUDED.total_orders, ' +
          'total_items = EXCLUDED.total_items, ' +
          'report_data = EXCLUDED.report_data, ' +
          'generated_by = EXCLUDED.generated_by, ' +
          'generated_at = now(), updated_at = now()',
        id,
        tenant.schoolId,
        input.serviceDate,
        input.mealType,
        result.totalOrders,
        totalItems,
        JSON.stringify(reportData),
        actor.accountId,
      );
    });
    return this.getProductionReport(input.serviceDate, input.mealType);
  }

  async getProductionReport(
    serviceDate: string,
    mealType: string,
  ): Promise<ProductionReportResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, service_date, meal_type, total_orders, total_items, report_data, generated_by::text AS generated_by, generated_at ' +
          'FROM fds_preorder_production_reports WHERE school_id = $1::uuid AND service_date = $2::date AND meal_type = $3 LIMIT 1',
        tenant.schoolId,
        serviceDate,
        mealType,
      );
    })) as Array<{
      id: string;
      school_id: string;
      service_date: Date;
      meal_type: string;
      total_orders: number;
      total_items: number;
      report_data: {
        itemBreakdown?: ProductionReportItemRowDto[];
        dietaryBreakdown?: ProductionReportDietaryRowDto[];
      };
      generated_by: string;
      generated_at: Date;
    }>;
    if (rows.length === 0) {
      throw new NotFoundException(
        'No production report exists for service_date=' + serviceDate + ' meal_type=' + mealType,
      );
    }
    const r = rows[0]!;
    const data = r.report_data ?? {};
    return {
      id: r.id,
      schoolId: r.school_id,
      serviceDate: r.service_date.toISOString().slice(0, 10),
      mealType: r.meal_type as 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK',
      totalOrders: r.total_orders,
      totalItems: r.total_items,
      itemBreakdown: data.itemBreakdown ?? [],
      dietaryBreakdown: data.dietaryBreakdown ?? [],
      generatedBy: r.generated_by,
      generatedAt: r.generated_at.toISOString(),
    };
  }

  async listProductionReports(): Promise<ProductionReportResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, service_date, meal_type, total_orders, total_items, report_data, generated_by::text AS generated_by, generated_at ' +
          'FROM fds_preorder_production_reports WHERE school_id = $1::uuid ORDER BY service_date DESC, meal_type',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      service_date: Date;
      meal_type: string;
      total_orders: number;
      total_items: number;
      report_data: {
        itemBreakdown?: ProductionReportItemRowDto[];
        dietaryBreakdown?: ProductionReportDietaryRowDto[];
      };
      generated_by: string;
      generated_at: Date;
    }>;
    return rows.map((r) => {
      const data = r.report_data ?? {};
      return {
        id: r.id,
        schoolId: r.school_id,
        serviceDate: r.service_date.toISOString().slice(0, 10),
        mealType: r.meal_type as 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK',
        totalOrders: r.total_orders,
        totalItems: r.total_items,
        itemBreakdown: data.itemBreakdown ?? [],
        dietaryBreakdown: data.dietaryBreakdown ?? [],
        generatedBy: r.generated_by,
        generatedAt: r.generated_at.toISOString(),
      };
    });
  }

  // ─── internal helpers ───────────────────────────────────────────────

  /**
   * Verify the actor may order a meal on behalf of the given student.
   *
   * REVIEW-P2C10 ROUND 2 BLOCKING 1 — STUDENT branch JOIN adds
   * `s.school_id = $tenant.schoolId` so a STUDENT whose iam_person
   * is also enrolled at another school cannot order a meal under
   * THIS tenant's window against a foreign-school student row.
   * GUARDIAN branch adds `JOIN sis_students s ON s.id = sg.student_id
   * AND s.school_id = $tenant.schoolId` so a guardian linked to
   * children across multiple schools cannot order for a foreign-
   * school child through this tenant's API.
   *
   * REVIEW-P2C10 ROUND 2 BLOCKING 2 — FSM admin path no longer
   * blanket-bypasses; it validates that the supplied `studentId`
   * resolves to a current-tenant `sis_students` row before the
   * INSERT lands. A foreign-school student UUID returns 400 from
   * the admin path so the preorder cannot land with
   * `school_id = $A` + `student_id = $B`.
   *
   * Refusals are 403 (or 400 on the admin path) to make the
   * contract explicit. Row-scope reads collapse to 404
   * elsewhere — this is the write contract.
   */
  private async assertCanOrderForStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    const tenant = getCurrentTenant();
    if (await this.isFsmAdmin(actor)) {
      // FSM admin on-behalf path. Validate the student belongs to
      // the current school so the INSERT below cannot mis-stamp
      // school_id against a foreign-school student.
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
          tenant.schoolId,
          studentId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }
      return;
    }
    if (actor.personType === 'STUDENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.school_id = $1::uuid AND s.id = $2::uuid AND ps.person_id = $3::uuid LIMIT 1',
          tenant.schoolId,
          studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new ForbiddenException('Students can only submit preorders for themselves');
      }
      return;
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = sg.student_id AND s.school_id = $1::uuid ' +
            'WHERE sg.student_id = $2::uuid AND g.person_id = $3::uuid LIMIT 1',
          tenant.schoolId,
          studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new ForbiddenException('Guardians can only submit preorders for their own children');
      }
      return;
    }
    throw new ForbiddenException('Only admins, staff, guardians, or students can submit preorders');
  }

  private async loadItems(preorderIds: string[]): Promise<Map<string, PreorderItemResponseDto[]>> {
    if (preorderIds.length === 0) return new Map();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT i.id::text AS id, i.preorder_id::text AS preorder_id, i.menu_item_id::text AS menu_item_id, i.quantity, i.notes, ' +
          'mi.name AS menu_item_name, mi.allergen_codes AS menu_item_allergens ' +
          'FROM fds_meal_preorder_items i ' +
          'LEFT JOIN fds_menu_items mi ON mi.id = i.menu_item_id ' +
          'WHERE i.preorder_id = ANY($1::uuid[]) ' +
          'ORDER BY mi.name',
        preorderIds,
      );
    })) as Array<{
      id: string;
      preorder_id: string;
      menu_item_id: string;
      quantity: number;
      notes: string | null;
      menu_item_name: string | null;
      menu_item_allergens: string[] | null;
    }>;
    const map = new Map<string, PreorderItemResponseDto[]>();
    for (const r of rows) {
      const list = map.get(r.preorder_id) ?? [];
      list.push({
        id: r.id,
        preorderId: r.preorder_id,
        menuItemId: r.menu_item_id,
        menuItemName: r.menu_item_name,
        menuItemAllergens: r.menu_item_allergens ?? null,
        quantity: r.quantity,
        notes: r.notes,
      });
      map.set(r.preorder_id, list);
    }
    return map;
  }
}

// ─── SQL constants + row→DTO helpers ─────────────────────────────────

const SELECT_PREORDER_BASE =
  'SELECT p.id::text AS id, p.school_id::text AS school_id, p.student_id::text AS student_id, ' +
  'p.preorder_window_id::text AS preorder_window_id, p.ordered_by::text AS ordered_by, ' +
  'p.status, p.allergen_check_passed, p.blocking_allergens, p.warning_allergens, ' +
  'p.confirmed_at, p.cancelled_at, p.cancellation_reason, p.notes, p.created_at, ' +
  'w.service_date AS window_service_date, w.meal_type AS window_meal_type, ' +
  "COALESCE((ip_first.first_name || ' ' || ip_first.last_name), NULL) AS student_name " +
  'FROM fds_meal_preorders p ' +
  'JOIN fds_preorder_windows w ON w.id = p.preorder_window_id ' +
  'LEFT JOIN sis_students s ON s.id = p.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_first ON ip_first.id = ps.person_id ';

const ORDER_BY_PREORDER = ' ORDER BY w.service_date DESC, w.meal_type, p.created_at DESC';

interface PreorderWindowRow {
  id: string;
  school_id: string;
  service_date: Date;
  meal_type: string;
  opens_at: Date;
  closes_at: Date;
  notes: string | null;
  created_by: string;
  created_at: Date;
}

interface PreorderHeaderRow {
  id: string;
  school_id: string;
  student_id: string;
  preorder_window_id: string;
  ordered_by: string;
  status: string;
  allergen_check_passed: boolean;
  blocking_allergens: string[];
  warning_allergens: string[];
  confirmed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  notes: string | null;
  created_at: Date;
  window_service_date: Date;
  window_meal_type: string;
  student_name: string | null;
}

function windowRowToDto(r: PreorderWindowRow): PreorderWindowResponseDto {
  const now = Date.now();
  return {
    id: r.id,
    schoolId: r.school_id,
    serviceDate: r.service_date.toISOString().slice(0, 10),
    mealType: r.meal_type as 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK',
    opensAt: r.opens_at.toISOString(),
    closesAt: r.closes_at.toISOString(),
    isOpen: now >= r.opens_at.getTime() && now <= r.closes_at.getTime(),
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

function assemblePreorder(
  r: PreorderHeaderRow,
  items: PreorderItemResponseDto[],
): PreorderResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentName: r.student_name,
    preorderWindowId: r.preorder_window_id,
    serviceDate: r.window_service_date.toISOString().slice(0, 10),
    mealType: r.window_meal_type as 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK',
    orderedBy: r.ordered_by,
    status: r.status as PreorderStatus,
    allergenCheckPassed: r.allergen_check_passed,
    blockingAllergens: r.blocking_allergens ?? [],
    warningAllergens: r.warning_allergens ?? [],
    confirmedAt: r.confirmed_at ? r.confirmed_at.toISOString() : null,
    cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
    cancellationReason: r.cancellation_reason,
    notes: r.notes,
    items,
    createdAt: r.created_at.toISOString(),
  };
}
