import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { OutboxService } from '../kafka/outbox.service';
import { AssignmentResponseDto, CancelAssignmentDto } from './dto/substitutes.dto';

/**
 * Deterministic v5-shaped UUID for the late-cancellation outbox emit.
 * Same pattern as Cycle 4 deterministicCoverageEventId, P2-4a payroll,
 * P2-8 athletics. Outbox retries land the same envelope every time so
 * the CancellationPolicyWorker's idempotency catches redelivery.
 */
export function deterministicLateCancellationEventId(assignmentId: string): string {
  const hash = createHash('sha1')
    .update(assignmentId + ':sub.assignment.late_cancelled:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

interface AssignmentRow {
  id: string;
  job_id: string;
  substitute_id: string;
  confirmed_at: string;
  check_in_at: string | null;
  check_out_at: string | null;
  status: string;
  cancelled_at: string | null;
  cancelled_by_type: string | null;
  cancellation_reason: string | null;
  is_late_cancellation: boolean;
  late_cancellation_consequence_applied: boolean;
}

const SELECT_ASSIGNMENT_BASE = `
  SELECT a.id::text AS id,
         a.job_id::text AS job_id,
         a.substitute_id::text AS substitute_id,
         TO_CHAR(a.confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS confirmed_at,
         TO_CHAR(a.check_in_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS check_in_at,
         TO_CHAR(a.check_out_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS check_out_at,
         a.status,
         TO_CHAR(a.cancelled_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS cancelled_at,
         a.cancelled_by_type,
         a.cancellation_reason,
         a.is_late_cancellation,
         a.late_cancellation_consequence_applied
  FROM sub_assignments a
`;

/**
 * AssignmentService — P2-9b Step 7.
 *
 * Owns the substitute assignment lifecycle: CONFIRMED -> CHECKED_IN ->
 * CHECKED_OUT happy path, plus CANCELLED + NO_SHOW terminal alternates.
 *
 * The keystone here is `cancel()` — it reads the school cancellation
 * policy + the parent job's start time and computes
 * is_late_cancellation = (now() + late_window_hours >= job_start_at).
 * On a late cancellation the service flips the row + emits
 * sub.assignment.late_cancelled via the durable outbox so the
 * CancellationPolicyWorker (B6 in P2-9b) applies the configured
 * consequence per repeat-offence threshold.
 *
 * check_in / check_out are pinned by the schema-level multi-column
 * check_in_chk + check_out_chk lockstep — CHECKED_OUT requires
 * check_in_at + check_out_at both populated, etc. Concurrent attempts
 * to check_in/out the same assignment serialise on the FOR UPDATE
 * row lock.
 *
 * check_out additionally bumps the platform_substitute_profiles.total_assignments
 * counter inside the same tenant tx so the marketplace browser sees an
 * up-to-date count.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sch-004:write',
    ]);
  }

  // ── Reads ────────────────────────────────────────────────────────

  async list(actor: ResolvedActor, statusFilter?: string): Promise<AssignmentResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql =
        SELECT_ASSIGNMENT_BASE +
        ' JOIN sub_job_postings j ON j.id = a.job_id WHERE j.school_id = $1::uuid';
      const params: unknown[] = [tenant.schoolId];

      // Substitute persona: filter to own assignments. Admin sees all.
      if (!(await this.hasAdminScope(actor))) {
        if (!actor.personId) return [];
        const platform = this.tenantPrisma.getPlatformClient();
        const profile = await platform.substituteProfile.findUnique({
          where: { personId: actor.personId },
        });
        if (!profile) return [];
        sql += ` AND a.substitute_id = $${params.length + 1}::uuid`;
        params.push(profile.id);
      }
      if (statusFilter) {
        sql += ` AND a.status = $${params.length + 1}`;
        params.push(statusFilter);
      }
      sql += ' ORDER BY a.confirmed_at DESC';
      const rows = (await client.$queryRawUnsafe(sql, ...params)) as AssignmentRow[];
      return rows.map(this.rowToDto);
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<AssignmentResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE +
          ' JOIN sub_job_postings j ON j.id = a.job_id WHERE a.id = $1::uuid AND j.school_id = $2::uuid',
        id,
        tenant.schoolId,
      )) as AssignmentRow[];
      if (rows.length === 0) throw new NotFoundException('Assignment not found');

      // Visibility: admin all; substitute own only.
      if (!(await this.hasAdminScope(actor))) {
        if (!actor.personId) throw new NotFoundException('Assignment not found');
        const platform = this.tenantPrisma.getPlatformClient();
        const profile = await platform.substituteProfile.findUnique({
          where: { personId: actor.personId },
        });
        if (!profile || profile.id !== rows[0]!.substitute_id) {
          throw new NotFoundException('Assignment not found');
        }
      }
      return this.rowToDto(rows[0]!);
    });
  }

  // ── Lifecycle transitions ────────────────────────────────────────

  async checkIn(id: string, actor: ResolvedActor): Promise<AssignmentResponseDto> {
    return this.transitionToCheckIn(id, actor);
  }

  async checkOut(id: string, actor: ResolvedActor): Promise<AssignmentResponseDto> {
    return this.transitionToCheckOut(id, actor);
  }

  async cancel(
    id: string,
    input: CancelAssignmentDto,
    actor: ResolvedActor,
  ): Promise<AssignmentResponseDto> {
    const tenant = getCurrentTenant();
    const platform = this.tenantPrisma.getPlatformClient();

    // Resolve the substitute profile from actor to verify SUBSTITUTE side cancellations
    let subProfileId: string | null = null;
    if (actor.personId) {
      const profile = await platform.substituteProfile.findUnique({
        where: { personId: actor.personId },
      });
      subProfileId = profile?.id ?? null;
    }

    const isAdmin = await this.hasAdminScope(actor);

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the assignment + read parent job start time + school policy in same tx
      const rows = (await tx.$queryRawUnsafe(
        `SELECT a.id, a.status, a.substitute_id::text AS substitute_id, a.is_late_cancellation,
                j.job_date, j.start_time, j.school_id::text AS school_id,
                p.late_window_hours
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         LEFT JOIN sub_cancellation_policies p ON p.school_id = j.school_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid
         FOR UPDATE OF a`,
        id,
        tenant.schoolId,
      )) as Array<{
        id: string;
        status: string;
        substitute_id: string;
        is_late_cancellation: boolean;
        job_date: string;
        start_time: string;
        school_id: string;
        late_window_hours: number | null;
      }>;
      if (rows.length === 0) throw new NotFoundException('Assignment not found');
      const row = rows[0]!;
      if (row.status === 'CHECKED_OUT' || row.status === 'CANCELLED' || row.status === 'NO_SHOW') {
        throw new ConflictException(
          `Assignment is in terminal status ${row.status} and cannot be cancelled.`,
        );
      }

      // Authority check
      if (input.cancelledByType === 'SCHOOL') {
        if (!isAdmin) {
          throw new ForbiddenException(
            'Only school admins can cancel an assignment on behalf of the school.',
          );
        }
      } else {
        // SUBSTITUTE cancel: only the assigned substitute or an admin
        if (!isAdmin && subProfileId !== row.substitute_id) {
          throw new ForbiddenException(
            'Only the assigned substitute can cancel their own assignment.',
          );
        }
      }

      if (!input.cancellationReason || !input.cancellationReason.trim()) {
        throw new BadRequestException('cancellationReason is required.');
      }

      // Compute is_late_cancellation. Late = SUBSTITUTE-cancelled within the
      // configured window before job_start. SCHOOL-cancellations never count
      // as late (the school is initiating, by definition).
      let isLate = false;
      const lateWindowHours = row.late_window_hours ?? 2;
      if (input.cancelledByType === 'SUBSTITUTE') {
        const jobStartAt = new Date(`${row.job_date}T${row.start_time}Z`);
        const lateThreshold = new Date(jobStartAt.getTime() - lateWindowHours * 60 * 60 * 1000);
        if (Date.now() >= lateThreshold.getTime()) {
          isLate = true;
        }
      }

      // UPDATE atomic — status flip + cancelled_at + cancelled_by_type + reason + is_late_cancellation
      await tx.$executeRawUnsafe(
        `UPDATE sub_assignments
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancelled_by_type = $1,
             cancellation_reason = $2,
             is_late_cancellation = $3,
             updated_at = now()
         WHERE id = $4::uuid`,
        input.cancelledByType,
        input.cancellationReason,
        isLate,
        id,
      );

      // Re-open the parent job so admin can re-post if needed
      await tx.$executeRawUnsafe(
        `UPDATE sub_job_postings SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
         WHERE id IN (SELECT job_id FROM sub_assignments WHERE id = $1::uuid)`,
        id,
      );

      // Emit sub.assignment.late_cancelled only on late SUBSTITUTE cancel
      if (isLate) {
        await this.outbox.enqueueInTx(tx as never, {
          topic: 'sub.assignment.late_cancelled',
          key: id,
          eventId: deterministicLateCancellationEventId(id),
          sourceModule: 'substitutes',
          payload: {
            assignmentId: id,
            schoolId: row.school_id,
            substituteId: row.substitute_id,
            jobDate: row.job_date,
            jobStartTime: row.start_time,
            lateWindowHours,
            cancelledByType: input.cancelledByType,
            cancellationReason: input.cancellationReason,
            cancelledAt: new Date().toISOString(),
          },
        });
      }

      const fresh = (await tx.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE + ' WHERE a.id = $1::uuid',
        id,
      )) as AssignmentRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async transitionToCheckIn(
    id: string,
    actor: ResolvedActor,
  ): Promise<AssignmentResponseDto> {
    const tenant = getCurrentTenant();
    const platform = this.tenantPrisma.getPlatformClient();
    const isAdmin = await this.hasAdminScope(actor);
    let subProfileId: string | null = null;
    if (actor.personId) {
      const profile = await platform.substituteProfile.findUnique({
        where: { personId: actor.personId },
      });
      subProfileId = profile?.id ?? null;
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT a.id, a.status, a.substitute_id::text AS substitute_id
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid
         FOR UPDATE OF a`,
        id,
        tenant.schoolId,
      )) as Array<{ id: string; status: string; substitute_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Assignment not found');
      if (rows[0]!.status !== 'CONFIRMED') {
        throw new ConflictException(
          `Can only check in a CONFIRMED assignment (current: ${rows[0]!.status}).`,
        );
      }
      if (!isAdmin && subProfileId !== rows[0]!.substitute_id) {
        throw new ForbiddenException('Only the assigned substitute or an admin can check in.');
      }
      await tx.$executeRawUnsafe(
        `UPDATE sub_assignments SET status = 'CHECKED_IN', check_in_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        id,
      );
      const fresh = (await tx.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE + ' WHERE a.id = $1::uuid',
        id,
      )) as AssignmentRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  private async transitionToCheckOut(
    id: string,
    actor: ResolvedActor,
  ): Promise<AssignmentResponseDto> {
    const tenant = getCurrentTenant();
    const platform = this.tenantPrisma.getPlatformClient();
    const isAdmin = await this.hasAdminScope(actor);
    let subProfileId: string | null = null;
    if (actor.personId) {
      const profile = await platform.substituteProfile.findUnique({
        where: { personId: actor.personId },
      });
      subProfileId = profile?.id ?? null;
    }

    let bumpedSubId: string | null = null;
    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT a.id, a.status, a.substitute_id::text AS substitute_id, a.check_in_at
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid
         FOR UPDATE OF a`,
        id,
        tenant.schoolId,
      )) as Array<{
        id: string;
        status: string;
        substitute_id: string;
        check_in_at: Date | null;
      }>;
      if (rows.length === 0) throw new NotFoundException('Assignment not found');
      if (rows[0]!.status !== 'CHECKED_IN') {
        throw new ConflictException(
          `Can only check out a CHECKED_IN assignment (current: ${rows[0]!.status}). Check in first.`,
        );
      }
      if (!isAdmin && subProfileId !== rows[0]!.substitute_id) {
        throw new ForbiddenException('Only the assigned substitute or an admin can check out.');
      }
      bumpedSubId = rows[0]!.substitute_id;
      await tx.$executeRawUnsafe(
        `UPDATE sub_assignments SET status = 'CHECKED_OUT', check_out_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        id,
      );
      const fresh = (await tx.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE + ' WHERE a.id = $1::uuid',
        id,
      )) as AssignmentRow[];
      return this.rowToDto(fresh[0]!);
    });

    // Bump total_assignments counter on platform side after tenant tx commits.
    // Best-effort — the counter is materialised so a failure is recoverable.
    if (bumpedSubId) {
      try {
        await platform.substituteProfile.update({
          where: { id: bumpedSubId },
          data: { totalAssignments: { increment: 1 } },
        });
      } catch (e) {
        // Log + drop — the counter can be re-materialised by a future
        // RatingService re-compute or by a manual SQL fix.
        this.logger.warn(`Failed to bump total_assignments for ${bumpedSubId}: ${String(e)}`);
      }
    }
    return result;
  }

  private rowToDto = (r: AssignmentRow): AssignmentResponseDto => ({
    id: r.id,
    jobId: r.job_id,
    substituteId: r.substitute_id,
    confirmedAt: r.confirmed_at,
    status: r.status as AssignmentResponseDto['status'],
    checkInAt: r.check_in_at,
    checkOutAt: r.check_out_at,
    isLateCancellation: r.is_late_cancellation,
    cancelledAt: r.cancelled_at,
    cancelledByType: r.cancelled_by_type as AssignmentResponseDto['cancelledByType'],
    cancellationReason: r.cancellation_reason,
  });
}
