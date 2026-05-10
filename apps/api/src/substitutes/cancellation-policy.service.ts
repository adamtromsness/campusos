import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { generateId } from '@campusos/database';
import { CancellationPolicyResponseDto, UpsertCancellationPolicyDto } from './dto/substitutes.dto';

interface PolicyRow {
  id: string;
  school_id: string;
  late_window_hours: number;
  consequence: string;
  suspension_duration_days: number | null;
  repeat_offence_threshold: number;
  rating_penalty_amount: string | null;
  notes: string | null;
  updated_at: string;
}

const SELECT_POLICY_BASE = `
  SELECT id::text AS id,
         school_id::text AS school_id,
         late_window_hours,
         consequence,
         suspension_duration_days,
         repeat_offence_threshold,
         rating_penalty_amount::text AS rating_penalty_amount,
         notes,
         TO_CHAR(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS updated_at
  FROM sub_cancellation_policies
`;

/**
 * CancellationPolicyService — P2-9b Step 7.
 *
 * Per-school cancellation policy. UNIQUE(school_id) caps each school at
 * one policy. The Step 7 AssignmentService.cancel reads
 * late_window_hours to compute is_late_cancellation. The
 * CancellationPolicyWorker (B6) reads consequence + the matching
 * detail-field column on every sub.assignment.late_cancelled emit.
 *
 * The multi-column suspension_chk + penalty_chk schema-level CHECKs
 * enforce the matching detail field is populated for the chosen
 * consequence — TEMPORARY_POOL_SUSPENSION requires
 * suspension_duration_days; RATING_PENALTY requires rating_penalty_amount.
 */
@Injectable()
export class CancellationPolicyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sch-004:write',
    ]);
  }

  async get(): Promise<CancellationPolicyResponseDto | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_POLICY_BASE + ' WHERE school_id = $1::uuid LIMIT 1',
        tenant.schoolId,
      )) as PolicyRow[];
      return rows.length === 0 ? null : this.rowToDto(rows[0]!);
    });
  }

  async upsert(
    input: UpsertCancellationPolicyDto,
    actor: ResolvedActor,
  ): Promise<CancellationPolicyResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only school admins can configure the cancellation policy.');
    }
    const tenant = getCurrentTenant();

    // App-layer validation of the consequence/detail lockstep
    const cons = input.consequence;
    if (cons === 'TEMPORARY_POOL_SUSPENSION') {
      if (input.suspensionDurationDays === undefined || input.suspensionDurationDays === null) {
        throw new BadRequestException('TEMPORARY_POOL_SUSPENSION requires suspensionDurationDays.');
      }
    } else if (cons === 'RATING_PENALTY') {
      if (input.ratingPenaltyAmount === undefined || input.ratingPenaltyAmount === null) {
        throw new BadRequestException('RATING_PENALTY requires ratingPenaltyAmount (1.0–5.0).');
      }
      if (input.ratingPenaltyAmount < 0 || input.ratingPenaltyAmount > 5) {
        throw new BadRequestException('ratingPenaltyAmount must be between 0 and 5.');
      }
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id FROM sub_cancellation_policies WHERE school_id = $1::uuid FOR UPDATE`,
        tenant.schoolId,
      )) as Array<{ id: string }>;

      type Effective = {
        late_window_hours: number;
        consequence: string;
        suspension_duration_days: number | null;
        repeat_offence_threshold: number;
        rating_penalty_amount: number | null;
        notes: string | null;
      };
      // Compute the post-merge effective shape per partial fields
      let effective: Effective = {
        late_window_hours: input.lateWindowHours ?? 2,
        consequence: input.consequence ?? 'WARNING_ONLY',
        suspension_duration_days: input.suspensionDurationDays ?? null,
        repeat_offence_threshold: input.repeatOffenceThreshold ?? 3,
        rating_penalty_amount: input.ratingPenaltyAmount ?? null,
        notes: input.notes ?? null,
      };

      if (existing.length > 0) {
        // PATCH semantics: read current row, merge, write
        const current = (await tx.$queryRawUnsafe(
          SELECT_POLICY_BASE + ' WHERE id = $1::uuid',
          existing[0]!.id,
        )) as PolicyRow[];
        const cur = current[0]!;
        effective = {
          late_window_hours: input.lateWindowHours ?? cur.late_window_hours,
          consequence: input.consequence ?? cur.consequence,
          suspension_duration_days: input.suspensionDurationDays ?? cur.suspension_duration_days,
          repeat_offence_threshold: input.repeatOffenceThreshold ?? cur.repeat_offence_threshold,
          rating_penalty_amount:
            input.ratingPenaltyAmount ??
            (cur.rating_penalty_amount ? parseFloat(cur.rating_penalty_amount) : null),
          notes: input.notes ?? cur.notes,
        };

        // Re-validate consequence/detail lockstep against the merged shape
        if (effective.consequence === 'TEMPORARY_POOL_SUSPENSION') {
          if (effective.suspension_duration_days === null) {
            throw new BadRequestException(
              'TEMPORARY_POOL_SUSPENSION requires suspensionDurationDays.',
            );
          }
        } else {
          effective.suspension_duration_days = null;
        }
        if (effective.consequence === 'RATING_PENALTY') {
          if (effective.rating_penalty_amount === null) {
            throw new BadRequestException('RATING_PENALTY requires ratingPenaltyAmount.');
          }
        } else {
          effective.rating_penalty_amount = null;
        }

        await tx.$executeRawUnsafe(
          `UPDATE sub_cancellation_policies
           SET late_window_hours = $1, consequence = $2, suspension_duration_days = $3,
               repeat_offence_threshold = $4, rating_penalty_amount = $5, notes = $6,
               updated_by = $7::uuid, updated_at = now()
           WHERE id = $8::uuid`,
          effective.late_window_hours,
          effective.consequence,
          effective.suspension_duration_days,
          effective.repeat_offence_threshold,
          effective.rating_penalty_amount,
          effective.notes,
          actor.employeeId,
          existing[0]!.id,
        );
      } else {
        // Clean insert with the same lockstep guarantees
        if (effective.consequence !== 'TEMPORARY_POOL_SUSPENSION') {
          effective.suspension_duration_days = null;
        }
        if (effective.consequence !== 'RATING_PENALTY') {
          effective.rating_penalty_amount = null;
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO sub_cancellation_policies (id, school_id, late_window_hours, consequence, suspension_duration_days, repeat_offence_threshold, rating_penalty_amount, notes, updated_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid)`,
          generateId(),
          tenant.schoolId,
          effective.late_window_hours,
          effective.consequence,
          effective.suspension_duration_days,
          effective.repeat_offence_threshold,
          effective.rating_penalty_amount,
          effective.notes,
          actor.employeeId,
        );
      }

      const rows = (await tx.$queryRawUnsafe(
        SELECT_POLICY_BASE + ' WHERE school_id = $1::uuid',
        tenant.schoolId,
      )) as PolicyRow[];
      if (rows.length === 0) throw new NotFoundException('Policy disappeared after upsert');
      return this.rowToDto(rows[0]!);
    });
  }

  private rowToDto = (r: PolicyRow): CancellationPolicyResponseDto => ({
    id: r.id,
    schoolId: r.school_id,
    lateWindowHours: r.late_window_hours,
    consequence: r.consequence as CancellationPolicyResponseDto['consequence'],
    suspensionDurationDays: r.suspension_duration_days,
    repeatOffenceThreshold: r.repeat_offence_threshold,
    ratingPenaltyAmount: r.rating_penalty_amount,
    notes: r.notes,
    updatedAt: r.updated_at,
  });
}
