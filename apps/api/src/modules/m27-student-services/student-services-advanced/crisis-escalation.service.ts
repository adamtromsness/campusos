import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { deterministicReferralEscalatedEventId } from './event-ids';
import { EscalateReferralResponseDto } from './dto/student-services-advanced.dto';

/**
 * CrisisEscalationService — P2-28c CRISIS auto-escalation keystone.
 *
 * Two paths:
 *
 *   1. Manual escalation. A counsellor or admin calls
 *      `escalate(referralId)` to raise a referral to URGENT priority,
 *      mark it ACCEPTED, and write an ESCALATED row to the IMMUTABLE
 *      svc_referral_activity audit log — all in one tenant tx. Used
 *      when the counsellor reviewing the queue spots a CRISIS-class
 *      concern that was originally filed at a lower priority.
 *
 *   2. Auto-escalation. The Step 6 ReferralService.create path checks
 *      svc_referral_types.referral_category — when CRISIS, the new
 *      referral is created at URGENT priority + status ACCEPTED + an
 *      ESCALATED activity row is written, and the Kafka envelope on
 *      svc.referral.created carries `autoEscalate=true`. This service
 *      exposes `autoEscalateIfCrisis(referralId)` for that bridge —
 *      called inside the same tenant tx as the parent INSERT.
 *
 * The activity log is IMMUTABLE per ADR-010 — no UPDATE method, no
 * DELETE method. We INSERT a new row and rely on the schema CASCADE
 * on parent referral hard-delete to take the audit with the row.
 */
@Injectable()
export class CrisisEscalationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Referral escalation is staff-only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Staff actor must have an hr_employees row');
    }
  }

  async escalate(referralId: string, actor: ResolvedActor): Promise<EscalateReferralResponseDto> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    let previousPriority = '';
    const activityId = generateId();
    const escalatedAt = new Date().toISOString();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT priority, status FROM svc_referrals WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        referralId,
        tenant.schoolId,
      )) as Array<{ priority: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Referral not found');
      previousPriority = rows[0]!.priority;
      const currentStatus = rows[0]!.status;

      if (
        currentStatus === 'COMPLETED' ||
        currentStatus === 'CANCELLED' ||
        currentStatus === 'DECLINED'
      ) {
        throw new BadRequestException(
          'Cannot escalate a referral in terminal status ' + currentStatus,
        );
      }

      if (previousPriority === 'URGENT' && currentStatus === 'ACCEPTED') {
        throw new BadRequestException(
          'Referral is already at URGENT priority and ACCEPTED status. No escalation needed.',
        );
      }

      await tx.$executeRawUnsafe(
        "UPDATE svc_referrals SET priority = 'URGENT', " +
          "status = CASE WHEN status IN ('SUBMITTED', 'TRIAGED') THEN 'ACCEPTED' ELSE status END, " +
          'updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid',
        referralId,
        tenant.schoolId,
      );

      await tx.$executeRawUnsafe(
        'INSERT INTO svc_referral_activity (id, referral_id, actor_id, activity_type, notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ESCALATED', $4)",
        activityId,
        referralId,
        actor.accountId,
        'Escalated to URGENT — CRISIS handling',
      );

      // REVIEW-P2C28 Round 1 BLOCKING 6 — durable outbox enqueue inside
      // the same tenant tx as the priority/status flip + ESCALATED
      // audit row. Deterministic event_id from (referralId, activityId)
      // so a retry through the OutboxPublisherWorker produces the same
      // envelope and the downstream consumer's idempotency catches
      // redelivery cleanly. Best-effort Kafka.emit() after-commit was
      // dropping events on broker outage — a safety-critical CRISIS
      // event cannot be silently lost.
      await this.outbox.enqueueInTx(tx, {
        topic: 'svc.referral.escalated',
        key: referralId,
        sourceModule: 'student-services-advanced',
        eventId: deterministicReferralEscalatedEventId(referralId, activityId),
        payload: {
          referralId,
          sourceRefId: referralId,
          schoolId: tenant.schoolId,
          previousPriority,
          newPriority: 'URGENT',
          escalatedBy: actor.accountId,
          escalatedAt,
          activityId,
        },
      });
    });

    return {
      referralId,
      previousPriority,
      newPriority: 'URGENT',
      activityId,
      escalatedAt,
    };
  }
}
