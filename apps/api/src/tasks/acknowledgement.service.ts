import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AcknowledgementResponseDto,
  AcknowledgementSourceType,
  AcknowledgementStatus,
} from './dto/task.dto';

interface AckRow {
  id: string;
  school_id: string;
  subject_id: string;
  source_type: string;
  source_ref_id: string;
  source_table: string;
  title: string;
  body_s3_key: string | null;
  requires_dispute_option: boolean;
  status: string;
  acknowledged_at: string | null;
  dispute_reason: string | null;
  created_by: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDto(row: AckRow): AcknowledgementResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    subjectId: row.subject_id,
    sourceType: row.source_type as AcknowledgementSourceType,
    sourceRefId: row.source_ref_id,
    sourceTable: row.source_table,
    title: row.title,
    bodyS3Key: row.body_s3_key,
    requiresDisputeOption: row.requires_dispute_option,
    status: row.status as AcknowledgementStatus,
    acknowledgedAt: row.acknowledged_at,
    disputeReason: row.dispute_reason,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_ACK_BASE =
  'SELECT a.id::text AS id, a.school_id::text AS school_id, a.subject_id::text AS subject_id, ' +
  'a.source_type, a.source_ref_id::text AS source_ref_id, a.source_table, a.title, a.body_s3_key, ' +
  'a.requires_dispute_option, a.status, ' +
  "TO_CHAR(a.acknowledged_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS acknowledged_at, " +
  'a.dispute_reason, a.created_by::text AS created_by, ' +
  "TO_CHAR(a.expires_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS expires_at, " +
  "TO_CHAR(a.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS created_at, " +
  "TO_CHAR(a.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS updated_at " +
  'FROM tsk_acknowledgements a ';

@Injectable()
export class AcknowledgementService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Pending acknowledgements for the calling user. Filtered to status=
   * PENDING by default. Subject_id is iam_person.id; the actor's
   * personId resolves the row.
   */
  async listOwnPending(actor: ResolvedActor): Promise<AcknowledgementResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AckRow[]>(
        SELECT_ACK_BASE +
          "WHERE a.subject_id = $1::uuid AND a.status = 'PENDING' " +
          'ORDER BY a.expires_at NULLS LAST, a.created_at',
        actor.personId,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<AcknowledgementResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AckRow[]>(SELECT_ACK_BASE + 'WHERE a.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Acknowledgement ' + id);
    const row = rows[0]!;
    if (!actor.isSchoolAdmin && row.subject_id !== actor.personId) {
      throw new NotFoundException('Acknowledgement ' + id);
    }
    return rowToDto(row);
  }

  /**
   * Acknowledge — flips status PENDING → ACKNOWLEDGED, sets
   * acknowledged_at = now(), and DONE-flips the linked tsk_tasks rows
   * for the same acknowledgement_id in the same transaction. Emits
   * student.acknowledgement.completed once on success.
   */
  async acknowledge(
    id: string,
    actor: ResolvedActor,
  ): Promise<AcknowledgementResponseDto> {
    return this.complete(id, 'ACKNOWLEDGED', null, actor);
  }

  /**
   * Dispute — same as acknowledge but flips status to
   * ACKNOWLEDGED_WITH_DISPUTE and stores the reason. The schema's
   * dispute_chk requires dispute_reason on this status; service-side
   * validation gives the user a friendly 400 before the schema does.
   */
  async dispute(
    id: string,
    reason: string,
    actor: ResolvedActor,
  ): Promise<AcknowledgementResponseDto> {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A dispute reason is required');
    }
    return this.complete(id, 'ACKNOWLEDGED_WITH_DISPUTE', reason.trim(), actor);
  }

  private async complete(
    id: string,
    nextStatus: 'ACKNOWLEDGED' | 'ACKNOWLEDGED_WITH_DISPUTE',
    reason: string | null,
    actor: ResolvedActor,
  ): Promise<AcknowledgementResponseDto> {
    const tenant = getCurrentTenant();
    let resolvedSubjectId: string | null = null;
    let resolvedSourceRefId: string | null = null;
    let resolvedSourceType: string | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the ack row so two parallel acknowledgements serialise.
      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          subject_id: string;
          status: string;
          source_type: string;
          source_ref_id: string;
        }>
      >(
        'SELECT id::text AS id, subject_id::text AS subject_id, status, source_type, source_ref_id::text AS source_ref_id ' +
          'FROM tsk_acknowledgements WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Acknowledgement ' + id);
      const row = rows[0]!;
      if (!actor.isSchoolAdmin && row.subject_id !== actor.personId) {
        throw new NotFoundException('Acknowledgement ' + id);
      }
      if (row.status !== 'PENDING') {
        throw new BadRequestException(
          'Only PENDING acknowledgements can be ' +
            (nextStatus === 'ACKNOWLEDGED' ? 'acknowledged' : 'disputed'),
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE tsk_acknowledgements SET status = $1, acknowledged_at = now(), dispute_reason = $2, updated_at = now() ' +
          'WHERE id = $3::uuid',
        nextStatus,
        reason,
        id,
      );
      // Cascade DONE-flip onto any linked task rows. The completed_chk
      // multi-column constraint is satisfied by setting completed_at in
      // the same UPDATE.
      await tx.$executeRawUnsafe(
        "UPDATE tsk_tasks SET status = 'DONE', completed_at = now(), updated_at = now() " +
          "WHERE acknowledgement_id = $1::uuid AND status NOT IN ('DONE', 'CANCELLED')",
        id,
      );
      resolvedSubjectId = row.subject_id;
      resolvedSourceRefId = row.source_ref_id;
      resolvedSourceType = row.source_type;
    });

    // Emit outside the tx — the row is committed and the consumers (e.g.
    // a future audit-log writer) shouldn't be blocked by network latency.
    void this.kafka.emit({
      topic: 'student.acknowledgement.completed',
      key: id,
      sourceModule: 'tasks',
      payload: {
        acknowledgementId: id,
        subjectId: resolvedSubjectId,
        status: nextStatus,
        sourceType: resolvedSourceType,
        sourceRefId: resolvedSourceRefId,
        disputeReason: reason,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });

    return this.getById(id, actor);
  }

  /**
   * Optional admin-only history view. Emits the full set of acks for
   * the caller's tenant so the future Step 8 admin UI can render the
   * compliance dashboard. Not in the plan's MVP scope but cheap to
   * include since the row scope is "admin-only".
   */
  async listAll(actor: ResolvedActor): Promise<AcknowledgementResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can list every acknowledgement');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AckRow[]>(SELECT_ACK_BASE + 'ORDER BY a.created_at DESC LIMIT 200');
    });
    return rows.map(rowToDto);
  }
}

