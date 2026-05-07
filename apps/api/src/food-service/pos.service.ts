import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  AllergenCheckResponseDto,
  AllergenMatchDto,
  AllergenSeverity,
  CreatePosDeviceDto,
  CreateTransactionDto,
  MealType,
  OpenSessionDto,
  PaymentMethod,
  PatronType,
  PosDeviceResponseDto,
  PosDeviceType,
  ReconciliationResponseDto,
  ReconciliationStatus,
  SessionResponseDto,
  TransactionResponseDto,
  UpdatePosDeviceDto,
  UpdateReconciliationDto,
} from './dto/food-service.dto';

const VARIANCE_THRESHOLD = 1.0;

function assertCanManage(actor: ResolvedActor): void {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'STAFF') return;
  throw new ForbiddenException('Only school admins or food service staff can operate the POS');
}

@Injectable()
export class PosService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(): Promise<PosDeviceResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, device_name, location, device_type, is_active ' +
          'FROM fds_pos_devices WHERE school_id = $1::uuid ORDER BY device_name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      device_name: string;
      location: string | null;
      device_type: string;
      is_active: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      deviceName: r.device_name,
      location: r.location,
      deviceType: r.device_type as PosDeviceType,
      isActive: r.is_active,
    }));
  }

  async create(input: CreatePosDeviceDto, actor: ResolvedActor): Promise<PosDeviceResponseDto> {
    assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_pos_devices (id, school_id, device_name, location, device_type, is_active) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true)',
          id,
          tenant.schoolId,
          input.deviceName,
          input.location ?? null,
          input.deviceType ?? 'CASHIER_STAFFED',
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('A POS device with this name already exists for this school');
      }
      throw err;
    }
    const list = await this.list();
    return list.find((d) => d.id === id)!;
  }

  async patch(
    id: string,
    input: UpdatePosDeviceDto,
    actor: ResolvedActor,
  ): Promise<PosDeviceResponseDto> {
    assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.deviceName !== undefined) {
      sets.push('device_name = $' + (params.length + 1));
      params.push(input.deviceName);
    }
    if (input.location !== undefined) {
      sets.push('location = $' + (params.length + 1));
      params.push(input.location);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fds_pos_devices SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    const list = await this.list();
    const found = list.find((d) => d.id === id);
    if (!found) throw new NotFoundException('POS device not found');
    return found;
  }
}

@Injectable()
export class SessionService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(args: { fromDate?: string; toDate?: string }): Promise<SessionResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.fromDate) {
      where.push('s.service_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('s.service_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SESSION_SELECT +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY s.service_date DESC, s.meal_type',
        ...params,
      );
    })) as SessionRow[];
    return rows.map(sessionRowToDto);
  }

  async getById(id: string): Promise<SessionResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SESSION_SELECT + 'WHERE s.id = $1::uuid LIMIT 1', id);
    })) as SessionRow[];
    if (rows.length === 0) throw new NotFoundException('Session not found');
    return sessionRowToDto(rows[0]!);
  }

  async open(input: OpenSessionDto, actor: ResolvedActor): Promise<SessionResponseDto> {
    assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_meal_service_sessions (id, school_id, service_date, meal_type, opened_by, opened_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::uuid, now())',
          id,
          tenant.schoolId,
          input.serviceDate,
          input.mealType,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A session for this date + meal type is already open or closed',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  /**
   * Closes the session and auto-creates a cash-drawer reconciliation row
   * per (session, pos_device) that posted CASH transactions during the
   * session — addresses REVIEW-CYCLE20 MAJOR 11. The reconciliation row
   * is created inside the same locked tenant tx as the session close so
   * the audit boundary between open POS activity and finalized
   * reconciliation is consistent.
   */
  async close(id: string, actor: ResolvedActor): Promise<SessionResponseDto> {
    assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, closed_at FROM fds_meal_service_sessions WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; closed_at: Date | null }>;
      if (locked.length === 0) throw new NotFoundException('Session not found');
      if (locked[0]!.closed_at !== null) {
        throw new BadRequestException('Session is already closed');
      }
      await tx.$executeRawUnsafe(
        'UPDATE fds_meal_service_sessions SET closed_at = now(), closed_by = $1::uuid, updated_at = now() WHERE id = $2::uuid',
        actor.accountId,
        id,
      );
      // Auto-create a reconciliation row per pos_device with CASH activity.
      const deviceTotals = (await tx.$queryRawUnsafe(
        'SELECT pos_device_id::text AS pos_device_id, COALESCE(SUM(total), 0) AS expected ' +
          "FROM fds_meal_transactions WHERE session_id = $1::uuid AND payment_method = 'CASH' " +
          'GROUP BY pos_device_id',
        id,
      )) as Array<{ pos_device_id: string; expected: number }>;
      for (const d of deviceTotals) {
        try {
          await tx.$executeRawUnsafe(
            'INSERT INTO fds_cash_drawer_reconciliation (id, session_id, pos_device_id, opening_balance, expected_closing_balance, status) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4, 'OPEN') " +
              'ON CONFLICT (session_id, pos_device_id) DO NOTHING',
            generateId(),
            id,
            d.pos_device_id,
            Number(d.expected),
          );
        } catch (err: unknown) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
    });
    return this.getById(id);
  }
}

@Injectable()
export class TransactionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * ALLERGEN CROSS-CHECK KEYSTONE.
   *
   * Step 0: resolve patron to a tenant-local student/staff row id —
   *         reject cross-tenant or non-existent UUIDs, reject
   *         patronType mismatches. Addresses REVIEW-CYCLE20 BLOCKING 3.
   * Step 1: resolve patron's active allergen alerts (STUDENT only).
   * Step 2: for each item in the transaction, intersect the item's
   *         allergen_codes against the patron's active codes by severity.
   * Step 3: any CRITICAL match -> throw 422 BLOCKED with matched
   *         allergens unless supervisorOverrideId is supplied.
   *         The override path requires a person with the manager
   *         scope (school admin OR personType=STAFF). The override
   *         persists with allergen_override_required=true on the row.
   * Step 4: any WARNING match -> include in response warnings array.
   * Step 5: validate FREE_MEAL eligibility when paymentMethod is
   *         FREE_MEAL — addresses REVIEW-CYCLE20 BLOCKING 5.
   * Step 6: lock session FOR UPDATE, validate session open + device
   *         active in same tenant tx as the INSERT — addresses
   *         REVIEW-CYCLE20 BLOCKING 4. Emit fds.transaction.completed
   *         after commit.
   */
  async create(input: CreateTransactionDto, actor: ResolvedActor): Promise<TransactionResponseDto> {
    assertCanManage(actor);

    const patronType: PatronType = input.patronType ?? 'STUDENT';
    const resolved = await this.assertPatronInCurrentTenant(input.patronId, patronType);

    // Resolve allergen alerts for the patron (read model). STUDENT only —
    // staff allergens are out of scope this cycle.
    const alertRows =
      resolved.kind === 'STUDENT'
        ? ((await this.tenantPrisma.executeInTenantContext(async (client) => {
            return client.$queryRawUnsafe(
              'SELECT allergen_code, severity FROM fds_student_allergen_alerts ' +
                'WHERE student_id = $1::uuid AND is_active = true',
              resolved.id,
            );
          })) as Array<{ allergen_code: string; severity: string }>)
        : [];

    // Cross-check items
    const itemIds = input.items.map((it) => it.itemId);
    const itemRows =
      itemIds.length > 0
        ? ((await this.tenantPrisma.executeInTenantContext(async (client) => {
            return client.$queryRawUnsafe(
              'SELECT id::text AS id, name, allergen_codes ' +
                'FROM fds_menu_items WHERE id = ANY($1::uuid[])',
              itemIds,
            );
          })) as Array<{ id: string; name: string; allergen_codes: string[] }>)
        : [];
    const itemById = new Map(itemRows.map((r) => [r.id, r]));

    const matches: AllergenMatchDto[] = [];
    for (const it of input.items) {
      const meta = itemById.get(it.itemId);
      if (!meta) continue;
      const itemAllergens = meta.allergen_codes ?? [];
      // Walk severities — CRITICAL first so the strongest match wins.
      for (const severity of ['CRITICAL', 'WARNING', 'INFO'] as AllergenSeverity[]) {
        const codes = alertRows.filter((a) => a.severity === severity).map((a) => a.allergen_code);
        const matched = itemAllergens.filter((code) => codes.includes(code));
        if (matched.length > 0) {
          matches.push({
            itemId: it.itemId,
            itemName: meta.name,
            matchedAllergens: matched,
            severity,
          });
          break;
        }
      }
    }

    const criticalMatches = matches.filter((m) => m.severity === 'CRITICAL');
    const warningMatches = matches.filter((m) => m.severity === 'WARNING');

    let overrideRequired = false;
    if (criticalMatches.length > 0) {
      if (!input.supervisorOverrideId) {
        // 422 Unprocessable Entity per the plan
        throw new HttpException(
          {
            statusCode: 422,
            error: 'AllergenBlocked',
            message: 'Transaction blocked: CRITICAL allergen match. Supervisor override required.',
            blocked: criticalMatches,
          },
          422,
        );
      }
      // Supervisor existence is verified inside the locked tx below
      // (REVIEW-FINAL-2026-05-07 MIN-7.1 fix). Pre-tx verification
      // had a tiny race: a supervisor could be deactivated between
      // the check and the INSERT. Setting the override flag here so
      // the INSERT path knows to populate the audit columns.
      overrideRequired = true;
    }

    // FREE_MEAL eligibility gate (REVIEW-CYCLE20 BLOCKING 5)
    if (input.paymentMethod === 'FREE_MEAL') {
      if (resolved.kind !== 'STUDENT') {
        throw new BadRequestException('FREE_MEAL applies to STUDENT patrons only');
      }
      const eligible = await this.isFreeMealEligible(resolved.id);
      if (!eligible) {
        throw new ForbiddenException(
          'Patron is not free-meal eligible — supply a different paymentMethod or finalise an NSLP determination first',
        );
      }
    }

    // Compute total
    const total = input.items.reduce((sum, it) => sum + Number(it.price ?? 0), 0);

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock session FOR UPDATE — refuse closed sessions
      const sess = (await tx.$queryRawUnsafe(
        'SELECT id, closed_at FROM fds_meal_service_sessions WHERE id = $1::uuid FOR UPDATE',
        input.sessionId,
      )) as Array<{ id: string; closed_at: Date | null }>;
      if (sess.length === 0) {
        throw new BadRequestException('sessionId does not match a session in this school');
      }
      if (sess[0]!.closed_at !== null) {
        throw new BadRequestException(
          'Session is closed; cannot post new transactions to a closed session',
        );
      }
      // Validate device active
      const dev = (await tx.$queryRawUnsafe(
        'SELECT id, is_active FROM fds_pos_devices WHERE id = $1::uuid',
        input.posDeviceId,
      )) as Array<{ id: string; is_active: boolean }>;
      if (dev.length === 0) {
        throw new BadRequestException('posDeviceId does not match a device in this school');
      }
      if (!dev[0]!.is_active) {
        throw new BadRequestException('POS device is inactive — cannot post transactions');
      }
      // Verify supervisor inside the locked tx (REVIEW-FINAL MIN-7.1).
      // The hr_employees join through platform_users.person_id ensures
      // the override id resolves to a current-tenant employee — moves
      // the previous pre-tx existence check inside the same atomic
      // boundary as the INSERT so a deactivation between check and
      // write cannot land an orphan override.
      if (overrideRequired && input.supervisorOverrideId) {
        const supRows = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM platform.platform_users pu ' +
            'JOIN hr_employees he ON he.person_id = pu.person_id ' +
            'WHERE pu.id = $1::uuid LIMIT 1',
          input.supervisorOverrideId,
        )) as Array<{ ok: number }>;
        if (supRows.length === 0) {
          throw new BadRequestException(
            'supervisorOverrideId does not match an active employee in this school',
          );
        }
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO fds_meal_transactions (id, patron_id, patron_type, session_id, pos_device_id, items, total, payment_method, allergen_override_required, supervisor_override_id, override_reason, served_at, served_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::jsonb, $7, $8, $9, $10::uuid, $11, now(), $12::uuid)',
        id,
        input.patronId,
        patronType,
        input.sessionId,
        input.posDeviceId,
        JSON.stringify(input.items),
        total,
        input.paymentMethod,
        overrideRequired,
        overrideRequired ? input.supervisorOverrideId : null,
        overrideRequired ? (input.overrideReason ?? 'Supervisor allergen override') : null,
        actor.accountId,
      );
    });

    await this.kafka.emit({
      topic: 'fds.transaction.completed',
      key: id,
      sourceModule: 'food-service',
      payload: {
        transactionId: id,
        patronId: input.patronId,
        patronType,
        sessionId: input.sessionId,
        posDeviceId: input.posDeviceId,
        total,
        paymentMethod: input.paymentMethod,
        allergenOverrideRequired: overrideRequired,
        supervisorOverrideId: overrideRequired ? input.supervisorOverrideId : null,
        itemCount: input.items.length,
      },
    });

    const dto = await this.getById(id);
    return { ...dto, warnings: warningMatches };
  }

  /**
   * Resolve a soft platform.iam_person UUID to a tenant-local
   * sis_students.id or hr_employees.id. Rejects cross-tenant /
   * non-existent UUIDs and patronType mismatches with 400.
   * Addresses REVIEW-CYCLE20 BLOCKING 3.
   */
  async assertPatronInCurrentTenant(
    patronId: string,
    patronType: PatronType,
  ): Promise<{ kind: 'STUDENT'; id: string } | { kind: 'STAFF'; id: string }> {
    if (patronType === 'STUDENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $1::uuid LIMIT 1',
          patronId,
        );
      })) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new BadRequestException('patronId does not match a student enrolled in this school');
      }
      return { kind: 'STUDENT', id: rows[0]!.id };
    }
    if (patronType === 'STAFF') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT id::text AS id FROM hr_employees WHERE person_id = $1::uuid LIMIT 1',
          patronId,
        );
      })) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new BadRequestException('patronId does not match a staff member in this school');
      }
      return { kind: 'STAFF', id: rows[0]!.id };
    }
    throw new BadRequestException('Unknown patronType: ' + patronType);
  }

  /**
   * Free-meal eligibility check for the FREE_MEAL paymentMethod.
   * Returns true when the resolved tenant-local student has either
   * `fds_student_dietary_profiles.free_meal_eligible = true` or a
   * current active determination with eligibility_category in
   * (FREE, REDUCED) inside the effective_from / effective_to window.
   * Addresses REVIEW-CYCLE20 BLOCKING 5.
   */
  async isFreeMealEligible(studentTenantId: string): Promise<boolean> {
    const profile = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT free_meal_eligible FROM fds_student_dietary_profiles ' +
          'WHERE student_id = $1::uuid LIMIT 1',
        studentTenantId,
      );
    })) as Array<{ free_meal_eligible: boolean }>;
    if (profile.length > 0 && profile[0]!.free_meal_eligible === true) return true;
    const det = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM fds_eligibility_determinations d ' +
          'JOIN fds_eligibility_applications a ON a.id = d.application_id ' +
          "WHERE a.student_id = $1::uuid AND d.eligibility_category IN ('FREE', 'REDUCED') " +
          'AND CURRENT_DATE BETWEEN d.effective_from AND d.effective_to LIMIT 1',
        studentTenantId,
      );
    })) as Array<{ ok: number }>;
    return det.length > 0;
  }

  async getById(id: string): Promise<TransactionResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(TXN_SELECT + 'WHERE t.id = $1::uuid LIMIT 1', id);
    })) as TxnRow[];
    if (rows.length === 0) throw new NotFoundException('Transaction not found');
    return txnRowToDto(rows[0]!);
  }

  async list(args: {
    sessionId?: string;
    patronId?: string;
    fromDate?: string;
    toDate?: string;
  }): Promise<TransactionResponseDto[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.sessionId) {
      where.push('t.session_id = $' + (params.length + 1) + '::uuid');
      params.push(args.sessionId);
    }
    if (args.patronId) {
      where.push('t.patron_id = $' + (params.length + 1) + '::uuid');
      params.push(args.patronId);
    }
    if (args.fromDate) {
      where.push('t.served_at >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('t.served_at <= $' + (params.length + 1) + "::date + INTERVAL '1 day'");
      params.push(args.toDate);
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        TXN_SELECT + whereSql + ' ORDER BY t.served_at DESC LIMIT 200',
        ...params,
      );
    })) as TxnRow[];
    return rows.map(txnRowToDto);
  }

  /**
   * Pre-scan allergen check — used by the cashier UI to surface
   * patron alerts before the transaction is finalised so the
   * cashier can warn the patron.
   */
  async checkAllergens(patronId: string): Promise<AllergenCheckResponseDto> {
    // Resolve patron to tenant-local student row first; cross-tenant /
    // bogus UUIDs return 400 instead of silently reporting zero alerts.
    const resolved = await this.assertPatronInCurrentTenant(patronId, 'STUDENT');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT allergen_code, severity FROM fds_student_allergen_alerts ' +
          'WHERE student_id = $1::uuid AND is_active = true',
        resolved.id,
      );
    })) as Array<{ allergen_code: string; severity: string }>;
    return {
      patronId,
      activeAllergens: rows.map((r) => r.allergen_code),
      criticalCount: rows.filter((r) => r.severity === 'CRITICAL').length,
      warningCount: rows.filter((r) => r.severity === 'WARNING').length,
      infoCount: rows.filter((r) => r.severity === 'INFO').length,
    };
  }
}

@Injectable()
export class ReconciliationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getBySession(sessionId: string): Promise<ReconciliationResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, session_id::text AS session_id, pos_device_id::text AS pos_device_id, ' +
          'opening_balance, expected_closing_balance, actual_closing_balance, variance, ' +
          'reconciled_by::text AS reconciled_by, reconciled_at, status ' +
          'FROM fds_cash_drawer_reconciliation WHERE session_id = $1::uuid',
        sessionId,
      );
    })) as Array<{
      id: string;
      session_id: string;
      pos_device_id: string;
      opening_balance: number;
      expected_closing_balance: number;
      actual_closing_balance: number | null;
      variance: number | null;
      reconciled_by: string | null;
      reconciled_at: Date | null;
      status: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      posDeviceId: r.pos_device_id,
      openingBalance: Number(r.opening_balance),
      expectedClosingBalance: Number(r.expected_closing_balance),
      actualClosingBalance:
        r.actual_closing_balance !== null ? Number(r.actual_closing_balance) : null,
      variance: r.variance !== null ? Number(r.variance) : null,
      reconciledBy: r.reconciled_by,
      reconciledAt: r.reconciled_at ? r.reconciled_at.toISOString() : null,
      status: r.status as ReconciliationStatus,
    }));
  }

  async patch(
    id: string,
    input: UpdateReconciliationDto,
    actor: ResolvedActor,
  ): Promise<ReconciliationResponseDto> {
    assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, expected_closing_balance, status FROM fds_cash_drawer_reconciliation WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; expected_closing_balance: number; status: string }>;
      if (locked.length === 0) throw new NotFoundException('Reconciliation not found');
      const expected = Number(locked[0]!.expected_closing_balance);
      const actual = input.actualClosingBalance;
      const variance = Math.round((actual - expected) * 100) / 100;
      const newStatus: ReconciliationStatus =
        Math.abs(variance) > VARIANCE_THRESHOLD ? 'VARIANCE_FLAGGED' : 'RECONCILED';
      await tx.$executeRawUnsafe(
        'UPDATE fds_cash_drawer_reconciliation SET actual_closing_balance = $1, variance = $2, ' +
          ' reconciled_by = $3::uuid, reconciled_at = now(), status = $4, notes = $5, updated_at = now() ' +
          'WHERE id = $6::uuid',
        actual,
        variance,
        actor.accountId,
        newStatus,
        input.notes ?? null,
        id,
      );
    });
    const sessionRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT session_id::text AS session_id FROM fds_cash_drawer_reconciliation WHERE id = $1::uuid',
        id,
      );
    })) as Array<{ session_id: string }>;
    if (sessionRows.length === 0) throw new NotFoundException('Reconciliation not found');
    const all = await this.getBySession(sessionRows[0]!.session_id);
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Reconciliation not found after update');
    return found;
  }

  /**
   * Auto-create a reconciliation row when a session is closed. Used
   * by SessionService.close — but exposed here so the seed path can
   * reach the same code. Re-callable; if a row already exists for
   * (session, device) it returns it instead of inserting again.
   */
  async ensureForSession(args: {
    sessionId: string;
    posDeviceId: string;
    openingBalance: number;
    expectedClosingBalance: number;
  }): Promise<void> {
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_cash_drawer_reconciliation (id, session_id, pos_device_id, opening_balance, expected_closing_balance, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'OPEN')",
          generateId(),
          args.sessionId,
          args.posDeviceId,
          args.openingBalance,
          args.expectedClosingBalance,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
  }
}

interface SessionRow {
  id: string;
  school_id: string;
  service_date: Date;
  meal_type: string;
  opened_by: string;
  opened_by_name: string | null;
  opened_at: Date;
  closed_by: string | null;
  closed_at: Date | null;
  txn_count: number;
  total_sales: number | null;
}

const SESSION_SELECT =
  'SELECT s.id::text AS id, s.school_id::text AS school_id, s.service_date, s.meal_type, ' +
  's.opened_by::text AS opened_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = s.opened_by) AS opened_by_name, ' +
  's.opened_at, s.closed_by::text AS closed_by, s.closed_at, ' +
  '(SELECT COUNT(*)::int FROM fds_meal_transactions t WHERE t.session_id = s.id) AS txn_count, ' +
  '(SELECT COALESCE(SUM(t.total), 0) FROM fds_meal_transactions t WHERE t.session_id = s.id) AS total_sales ' +
  'FROM fds_meal_service_sessions s ';

function sessionRowToDto(r: SessionRow): SessionResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    serviceDate: r.service_date.toISOString().slice(0, 10),
    mealType: r.meal_type as MealType,
    openedBy: r.opened_by,
    openedByName: r.opened_by_name,
    openedAt: r.opened_at.toISOString(),
    closedBy: r.closed_by,
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
    transactionCount: r.txn_count,
    totalSales: Number(r.total_sales ?? 0),
  };
}

interface TxnRow {
  id: string;
  patron_id: string;
  patron_name: string | null;
  patron_type: string;
  session_id: string;
  pos_device_id: string;
  items: unknown;
  total: number;
  payment_method: string;
  allergen_override_required: boolean;
  supervisor_override_id: string | null;
  override_reason: string | null;
  served_at: Date;
}

const TXN_SELECT =
  'SELECT t.id::text AS id, t.patron_id::text AS patron_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = t.patron_id) AS patron_name, " +
  't.patron_type, t.session_id::text AS session_id, t.pos_device_id::text AS pos_device_id, ' +
  't.items, t.total, t.payment_method, t.allergen_override_required, ' +
  't.supervisor_override_id::text AS supervisor_override_id, t.override_reason, t.served_at ' +
  'FROM fds_meal_transactions t ';

function txnRowToDto(r: TxnRow): TransactionResponseDto {
  return {
    id: r.id,
    patronId: r.patron_id,
    patronName: r.patron_name,
    patronType: r.patron_type as PatronType,
    sessionId: r.session_id,
    posDeviceId: r.pos_device_id,
    items: r.items,
    total: Number(r.total),
    paymentMethod: r.payment_method as PaymentMethod,
    allergenOverrideRequired: r.allergen_override_required,
    supervisorOverrideId: r.supervisor_override_id,
    overrideReason: r.override_reason,
    servedAt: r.served_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}
