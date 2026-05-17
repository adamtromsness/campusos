import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import { TrainingEventService } from './event.service';
import { RecordCompletionDto, TrainingCompletionDto } from './dto/training.dto';

interface CompletionRow {
  id: string;
  event_id: string;
  event_title: string | null;
  programme_id: string | null;
  programme_name: string | null;
  employee_id: string;
  employee_first: string | null;
  employee_last: string | null;
  school_id: string;
  completed_at: string;
  score: string | null;
  passed: boolean;
  notes: string | null;
  created_at: string;
}

const SELECT_COMPLETION_BASE =
  'SELECT c.id::text AS id, c.event_id::text AS event_id, e.title AS event_title, ' +
  '       e.programme_id::text AS programme_id, p.name AS programme_name, ' +
  '       c.employee_id::text AS employee_id, ip.first_name AS employee_first, ' +
  '       ip.last_name AS employee_last, c.school_id::text AS school_id, ' +
  '       c.completed_at::text AS completed_at, c.score::text AS score, c.passed, ' +
  '       c.notes, c.created_at::text AS created_at ' +
  'FROM hr_training_completions c ' +
  'JOIN hr_training_events e ON e.id = c.event_id ' +
  'JOIN hr_training_programmes p ON p.id = e.programme_id ' +
  'JOIN hr_employees emp ON emp.id = c.employee_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = emp.person_id ';

/**
 * Training completion service — the P2-4c training keystone.
 *
 * `record()` runs a single tenant tx that:
 *   1. Validates event + employee belong to the calling school.
 *   2. INSERTs hr_training_completions (UNIQUE(event_id, employee_id)
 *      catches the duplicate path; service translates to 400).
 *   3. AUTO-ISSUE keystone — if the parent programme has
 *      `is_mandatory = true` AND `renewal_months IS NOT NULL` AND a
 *      matching `hr_certification_types` row exists for the
 *      programme name, the service INSERTs an
 *      hr_employee_certifications row stamping issued_at = today and
 *      expires_at = today + renewal_months months. This bridges
 *      training programme completion to the certification register.
 *      Service is service-side idempotent — re-running on a
 *      pre-existing ACTIVE cert UPDATEs the issued_at + expires_at
 *      (re-certification path).
 *   4. Enqueues `hr.training.completed` via OutboxService.enqueueInTx
 *      with payload {completionId, eventId, programmeId, employeeId,
 *      schoolId, score, passed, completedAt}.
 */
@Injectable()
export class CompletionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
    private readonly events: TrainingEventService,
  ) {}

  /**
   * REVIEW-P2-4c BLOCKING 2 — listForEvent now actor-aware. The
   * full event roster (every employee's pass/fail score) is HR
   * data and must NOT be exposed to a generic Teacher / Staff
   * holder of hr-004:read. Admins (school admin OR hr-004:write/admin)
   * see the full roster; non-admin actors see only their own
   * completion row for the event (so an employee can confirm
   * their own attendance was recorded). Anyone without an
   * employee row gets an empty list.
   */
  async listForEvent(eventId: string, actor: ResolvedActor): Promise<TrainingCompletionDto[]> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const params: unknown[] = [tenant.schoolId, eventId];
      let where = 'WHERE c.school_id = $1::uuid AND c.event_id = $2::uuid';
      if (!isAdmin) {
        if (!actor.employeeId) return [];
        params.push(actor.employeeId);
        where += ` AND c.employee_id = $${params.length}::uuid`;
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_COMPLETION_BASE + where + ' ORDER BY c.completed_at DESC',
        ...params,
      )) as CompletionRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async listForEmployee(
    employeeId: string,
    actor: ResolvedActor,
  ): Promise<TrainingCompletionDto[]> {
    // Self-service path: actor.employeeId === employeeId is allowed
    // even without admin scope. Anyone else requires admin scope.
    if (actor.employeeId !== employeeId && !(await this.isAdmin(actor))) {
      throw new ForbiddenException(
        'You can only view your own training history. Admin scope required for other employees.',
      );
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_COMPLETION_BASE +
          'WHERE c.school_id = $1::uuid AND c.employee_id = $2::uuid ' +
          'ORDER BY c.completed_at DESC',
        tenant.schoolId,
        employeeId,
      )) as CompletionRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async record(
    eventId: string,
    input: RecordCompletionDto,
    actor: ResolvedActor,
  ): Promise<TrainingCompletionDto> {
    await this.assertAdmin(actor);
    const event = await this.events.loadInternalWithProgramme(eventId);
    if (!event) throw new NotFoundException('Training event not found');
    const tenant = getCurrentTenant();

    // Validate the employee is in this school.
    const employeeOk = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.employeeId,
      )) as Array<{ id: string }>;
      return rows.length > 0;
    });
    if (!employeeOk) {
      throw new BadRequestException('employeeId does not match an employee in this school.');
    }

    const id = generateId();
    const completedAt = input.completedAt ?? new Date().toISOString();
    const passed = input.passed !== undefined ? input.passed : true;

    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_training_completions ' +
            '(id, event_id, employee_id, school_id, completed_at, score, passed, notes, recorded_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6, $7, $8, $9::uuid)',
          id,
          eventId,
          input.employeeId,
          tenant.schoolId,
          completedAt,
          input.score ?? null,
          passed,
          input.notes ?? null,
          actor.employeeId ?? null,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            'This employee has already been recorded as completing this event.',
          );
        }
        throw e;
      }

      // AUTO-ISSUE keystone — for mandatory programmes with renewal,
      // auto-issue or refresh the matching certification.
      let autoIssuedCertId: string | null = null;
      if (passed && event.isMandatory && event.renewalMonths) {
        // Look up a matching cert type for the parent programme name.
        const typeRows = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM hr_certification_types ' +
            'WHERE school_id = $1::uuid AND LOWER(name) = LOWER($2) AND is_active = true LIMIT 1',
          tenant.schoolId,
          // load programme name via event context
          await this.programmeNameForEvent(tx, event.programmeId),
        )) as Array<{ id: string }>;
        if (typeRows.length > 0) {
          const certTypeId = typeRows[0]!.id;
          // Re-certify path: ON CONFLICT DO UPDATE bumps issued_at +
          // expires_at + status='ACTIVE'. Need a UNIQUE on
          // (employee_id, certification_type_id) when status='ACTIVE'
          // — schema doesn't have that today, so the service-layer
          // approach is "look up + UPDATE if found else INSERT".
          const existing = (await tx.$queryRawUnsafe(
            'SELECT id::text AS id FROM hr_employee_certifications ' +
              'WHERE employee_id = $1::uuid AND certification_type_id = $2::uuid ' +
              "  AND status = 'ACTIVE' LIMIT 1",
            input.employeeId,
            certTypeId,
          )) as Array<{ id: string }>;
          const issuedAtDate = completedAt.slice(0, 10);
          const expiresAt = addMonths(issuedAtDate, event.renewalMonths);
          if (existing.length > 0) {
            autoIssuedCertId = existing[0]!.id;
            await tx.$executeRawUnsafe(
              'UPDATE hr_employee_certifications ' +
                'SET issued_at = $1::date, expires_at = $2::date, updated_at = now() ' +
                'WHERE id = $3::uuid',
              issuedAtDate,
              expiresAt,
              autoIssuedCertId,
            );
          } else {
            autoIssuedCertId = generateId();
            await tx.$executeRawUnsafe(
              'INSERT INTO hr_employee_certifications ' +
                '(id, employee_id, certification_type_id, school_id, issued_at, expires_at, status) ' +
                "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, 'ACTIVE')",
              autoIssuedCertId,
              input.employeeId,
              certTypeId,
              tenant.schoolId,
              issuedAtDate,
              expiresAt,
            );
          }
        }
      }

      // Outbox enqueue — fires inside the same tx so a Kafka outage
      // cannot roll back the completion record. Mirrors the P2-4a
      // markPaid + P2-4b offer-accept patterns.
      await this.outbox.enqueueInTx(tx as never, {
        topic: 'hr.training.completed',
        key: id,
        sourceModule: 'hr-training',
        payload: {
          completionId: id,
          eventId,
          eventTitle: event.eventTitle,
          programmeId: event.programmeId,
          employeeId: input.employeeId,
          schoolId: tenant.schoolId,
          score: input.score ?? null,
          passed,
          completedAt,
          autoIssuedCertificationId: autoIssuedCertId,
        },
      });

      return id;
    });

    return this.getById(result);
  }

  async getById(id: string): Promise<TrainingCompletionDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_COMPLETION_BASE + 'WHERE c.school_id = $1::uuid AND c.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as CompletionRow[];
      if (rows.length === 0) throw new NotFoundException('Completion record not found');
      return this.rowToDto(rows[0]!);
    });
  }

  private async programmeNameForEvent(tx: unknown, programmeId: string): Promise<string> {
    const rows = (await (
      tx as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }
    ).$queryRawUnsafe(
      'SELECT name FROM hr_training_programmes WHERE id = $1::uuid LIMIT 1',
      programmeId,
    )) as Array<{ name: string }>;
    return rows[0]?.name ?? '';
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (await this.isAdmin(actor)) return;
    throw new ForbiddenException(
      'Recording training completions requires hr-004:write or school admin.',
    );
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-004:write',
      'hr-004:admin',
    ]);
  }

  private rowToDto(r: CompletionRow): TrainingCompletionDto {
    const name =
      r.employee_first || r.employee_last
        ? [r.employee_first, r.employee_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      eventId: r.event_id,
      eventTitle: r.event_title,
      programmeId: r.programme_id,
      programmeName: r.programme_name,
      employeeId: r.employee_id,
      employeeName: name,
      schoolId: r.school_id,
      completedAt: r.completed_at,
      score: r.score === null ? null : Number(r.score),
      passed: r.passed,
      notes: r.notes,
      createdAt: r.created_at,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (!e) return false;
    if (e.code === 'P2010' && e.meta?.code === '23505') return true;
    if (typeof e.message === 'string' && /unique/i.test(e.message)) return true;
    return false;
  }
}

/** Add `months` to an ISO date string `YYYY-MM-DD`, returning the same shape. */
function addMonths(isoDate: string, months: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const month = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(month / 12);
  const newMonth = ((month % 12) + 12) % 12;
  const day = d.getUTCDate();
  // Clamp day to last-of-month if the target month is shorter.
  const lastDay = new Date(Date.UTC(year, newMonth + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDay);
  const result = new Date(Date.UTC(year, newMonth, safeDay));
  return result.toISOString().slice(0, 10);
}
