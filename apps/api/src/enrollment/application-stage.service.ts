import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ApplicationStageResponseDto, StageTarget } from './dto/cycle16.dto';

interface StageRow {
  id: string;
  application_id: string;
  from_status: string | null;
  to_status: string;
  changed_by: string;
  changed_by_name: string | null;
  notes: string | null;
  changed_at: string;
}

const SELECT_STAGE =
  'SELECT s.id::text AS id, s.application_id::text AS application_id, ' +
  's.from_status, s.to_status, s.changed_by::text AS changed_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = s.changed_by) AS changed_by_name, ' +
  's.notes, ' +
  'TO_CHAR(s.changed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS changed_at ' +
  'FROM enr_application_stages s ';

function rowToDto(r: StageRow): ApplicationStageResponseDto {
  return {
    id: r.id,
    applicationId: r.application_id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    changedBy: r.changed_by,
    changedByName: r.changed_by_name,
    notes: r.notes,
    changedAt: r.changed_at,
  };
}

/**
 * Allowed transitions for the Cycle 16 multi-stage review pipeline.
 * Cycle 6 already supports SUBMITTED → UNDER_REVIEW → ACCEPTED /
 * REJECTED / WAITLISTED → ENROLLED. Cycle 16 layers in INTERVIEW /
 * ASSESSMENT / OFFERED so the EO can drive the full review
 * progression. The map is the source of truth for stage advancement.
 */
const ALLOWED_TRANSITIONS: Record<string, StageTarget[]> = {
  DRAFT: ['SUBMITTED' as StageTarget, 'WITHDRAWN'],
  SUBMITTED: ['UNDER_REVIEW', 'INTERVIEW', 'ASSESSMENT', 'WAITLISTED', 'WITHDRAWN', 'REJECTED'],
  UNDER_REVIEW: [
    'INTERVIEW',
    'ASSESSMENT',
    'OFFERED',
    'ACCEPTED',
    'WAITLISTED',
    'REJECTED',
    'WITHDRAWN',
  ],
  INTERVIEW: ['ASSESSMENT', 'OFFERED', 'WAITLISTED', 'REJECTED', 'WITHDRAWN'],
  ASSESSMENT: ['OFFERED', 'WAITLISTED', 'REJECTED', 'WITHDRAWN'],
  OFFERED: ['ACCEPTED', 'WAITLISTED', 'WITHDRAWN'],
  WAITLISTED: ['OFFERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'],
  ACCEPTED: ['ENROLLED', 'WITHDRAWN'],
};

@Injectable()
export class ApplicationStageService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(applicationId: string): Promise<ApplicationStageResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_STAGE + 'WHERE s.application_id = $1::uuid ORDER BY s.changed_at ASC',
        applicationId,
      );
    })) as StageRow[];
    return rows.map(rowToDto);
  }

  /**
   * Stage advancement keystone. Locks the application row inside one
   * tenant tx, validates the transition via ALLOWED_TRANSITIONS,
   * UPDATEs enr_applications.status, INSERTs an enr_application_stages
   * audit row in the same tx. EO/admin only. Returns the new stage row.
   */
  async advance(
    applicationId: string,
    toStatus: StageTarget,
    notes: string | null,
    actor: ResolvedActor,
  ): Promise<ApplicationStageResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only Enrolment Officers (Staff) or admins can advance application stages',
      );
    }
    const stageId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM enr_applications WHERE id = $1::uuid FOR UPDATE',
        applicationId,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Application not found');
      const fromStatus = lock[0]!.status;
      if (fromStatus === toStatus) {
        throw new BadRequestException('Application already in status ' + toStatus);
      }
      const allowed = ALLOWED_TRANSITIONS[fromStatus] ?? [];
      if (!allowed.includes(toStatus)) {
        throw new BadRequestException(
          'Transition ' +
            fromStatus +
            ' → ' +
            toStatus +
            ' is not allowed. Valid next statuses: ' +
            allowed.join(', '),
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE enr_applications SET status = $1, updated_at = now() WHERE id = $2::uuid',
        toStatus,
        applicationId,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_application_stages (id, application_id, from_status, to_status, changed_by, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)',
        stageId,
        applicationId,
        fromStatus,
        toStatus,
        actor.accountId,
        notes,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_STAGE + 'WHERE s.id = $1::uuid', stageId);
    })) as StageRow[];
    return rowToDto(rows[0]!);
  }
}
