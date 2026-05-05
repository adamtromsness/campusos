import { Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { Prisma } from '@prisma/client';
import { ActivityType, ReferralActivityResponseDto } from './dto/counselling.dto';

interface ActivityRow {
  id: string;
  referral_id: string;
  actor_id: string;
  actor_first: string | null;
  actor_last: string | null;
  activity_type: string;
  notes: string | null;
  created_at: string;
}

const SELECT_ACTIVITY_BASE =
  'SELECT a.id::text AS id, a.referral_id::text AS referral_id, ' +
  'a.actor_id::text AS actor_id, ' +
  'p.first_name AS actor_first, p.last_name AS actor_last, ' +
  'a.activity_type, a.notes, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM svc_referral_activity a ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = a.actor_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = pu.person_id ';

function rowToDto(r: ActivityRow): ReferralActivityResponseDto {
  return {
    id: r.id,
    referralId: r.referral_id,
    actorId: r.actor_id,
    actorName: r.actor_first && r.actor_last ? r.actor_first + ' ' + r.actor_last : null,
    activityType: r.activity_type as ActivityType,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

/**
 * ReferralActivityService — IMMUTABLE per ADR-010.
 *
 * Service-side discipline. The only writer is `recordActivity()` which is
 * called by every ReferralService status mutation. There is no `update`
 * method and no `delete` method. The DB-enforced FK on referral_id does
 * CASCADE on parent referral so an emergency hard-delete takes the audit
 * with it (mirrors Cycle 8 tkt_ticket_activity + Cycle 10
 * hlth_health_access_log).
 *
 * The `recordActivity()` helper accepts an optional `tx` so the calling
 * service can write the audit row inside the same locked transaction
 * that performs the referral status flip — keeping the row + audit
 * atomically consistent.
 */
@Injectable()
export class ReferralActivityService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async recordActivity(
    tx: Prisma.TransactionClient,
    referralId: string,
    actorAccountId: string,
    activityType: ActivityType,
    notes: string | null,
  ): Promise<void> {
    const id = generateId();
    await tx.$executeRawUnsafe(
      'INSERT INTO svc_referral_activity (id, referral_id, actor_id, activity_type, notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
      id,
      referralId,
      actorAccountId,
      activityType,
      notes,
    );
  }

  async listForReferral(referralId: string): Promise<ReferralActivityResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ActivityRow[]>(
        SELECT_ACTIVITY_BASE + 'WHERE a.referral_id = $1::uuid ORDER BY a.created_at ASC',
        referralId,
      );
    });
    return rows.map(rowToDto);
  }
}
