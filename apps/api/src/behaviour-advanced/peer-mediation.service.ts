import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CreatePeerMediationDto,
  PeerMediationResponseDto,
  PeerMediationStatus,
  UpdatePeerMediationDto,
} from './dto/behaviour-advanced.dto';

interface PeerMediationRow {
  id: string;
  school_id: string;
  mediator_student_id: string;
  mediator_first: string | null;
  mediator_last: string | null;
  party_a_student_id: string;
  party_a_first: string | null;
  party_a_last: string | null;
  party_b_student_id: string;
  party_b_first: string | null;
  party_b_last: string | null;
  referred_by: string | null;
  referrer_first: string | null;
  referrer_last: string | null;
  conflict_description: string;
  mediation_date: string | null;
  outcome: string | null;
  status: string;
  is_mediator_trained: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT m.id::text AS id, m.school_id::text AS school_id, ' +
  'm.mediator_student_id::text AS mediator_student_id, mp.first_name AS mediator_first, mp.last_name AS mediator_last, ' +
  'm.party_a_student_id::text AS party_a_student_id, pa.first_name AS party_a_first, pa.last_name AS party_a_last, ' +
  'm.party_b_student_id::text AS party_b_student_id, pb.first_name AS party_b_first, pb.last_name AS party_b_last, ' +
  'm.referred_by::text AS referred_by, rp.first_name AS referrer_first, rp.last_name AS referrer_last, ' +
  'm.conflict_description, ' +
  'TO_CHAR(m.mediation_date, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS mediation_date, ' +
  'm.outcome, m.status, m.is_mediator_trained, ' +
  'TO_CHAR(m.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(m.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM sis_peer_mediations m ' +
  'JOIN sis_students ms ON ms.id = m.mediator_student_id ' +
  'JOIN platform.platform_students mps ON mps.id = ms.platform_student_id ' +
  'JOIN platform.iam_person mp ON mp.id = mps.person_id ' +
  'JOIN sis_students pas ON pas.id = m.party_a_student_id ' +
  'JOIN platform.platform_students paps ON paps.id = pas.platform_student_id ' +
  'JOIN platform.iam_person pa ON pa.id = paps.person_id ' +
  'JOIN sis_students pbs ON pbs.id = m.party_b_student_id ' +
  'JOIN platform.platform_students pbps ON pbps.id = pbs.platform_student_id ' +
  'JOIN platform.iam_person pb ON pb.id = pbps.person_id ' +
  'LEFT JOIN hr_employees re ON re.id = m.referred_by ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = re.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: PeerMediationRow): PeerMediationResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    mediatorStudentId: r.mediator_student_id,
    mediatorStudentName: fullName(r.mediator_first, r.mediator_last),
    partyAStudentId: r.party_a_student_id,
    partyAStudentName: fullName(r.party_a_first, r.party_a_last),
    partyBStudentId: r.party_b_student_id,
    partyBStudentName: fullName(r.party_b_first, r.party_b_last),
    referredBy: r.referred_by,
    referredByName: fullName(r.referrer_first, r.referrer_last),
    conflictDescription: r.conflict_description,
    mediationDate: r.mediation_date,
    outcome: r.outcome,
    status: r.status as PeerMediationStatus,
    isMediatorTrained: r.is_mediator_trained,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Peer Mediation Service (P2-14 Step 4).
 *
 * Lower-tier conflict resolution between two students with a trained
 * peer mediator facilitating. Teachers can refer (with BEH-001:write).
 * Counsellor/admin schedule plus mark resolved. Schema-side CHECKs
 * reject mediator=party plus party_a=party_b at the layer below the
 * service.
 */
@Injectable()
export class PeerMediationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasReferralScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-001:write',
      'beh-001:admin',
    ]);
  }

  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-001:admin',
    ]);
  }

  async list(
    _actor: ResolvedActor,
    status?: PeerMediationStatus,
  ): Promise<PeerMediationResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_BASE + 'WHERE m.school_id = $1::uuid ';
      const args: unknown[] = [tenant.schoolId];
      if (status) {
        args.push(status);
        sql += 'AND m.status = $' + args.length + ' ';
      }
      sql += 'ORDER BY m.created_at DESC';
      const rows = (await client.$queryRawUnsafe(sql, ...args)) as PeerMediationRow[];
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<PeerMediationResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE m.school_id = $1::uuid AND m.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as PeerMediationRow[];
      const first = rows[0];
      if (!first) throw new NotFoundException('Peer mediation not found');
      return rowToDto(first);
    });
  }

  /**
   * Teacher refers a conflict. Validates all 3 students belong to the
   * school. Schema-side mediator_chk + parties_chk reject self/dup at
   * the DB layer.
   */
  async create(
    input: CreatePeerMediationDto,
    actor: ResolvedActor,
  ): Promise<PeerMediationResponseDto> {
    if (!(await this.hasReferralScope(actor))) {
      throw new ForbiddenException('Only staff with beh-001:write can refer peer mediations');
    }
    if (input.partyAStudentId === input.partyBStudentId) {
      throw new BadRequestException('partyAStudentId and partyBStudentId must be different');
    }
    if (
      input.mediatorStudentId === input.partyAStudentId ||
      input.mediatorStudentId === input.partyBStudentId
    ) {
      throw new BadRequestException('mediatorStudentId cannot be a party to the conflict');
    }
    const tenant = getCurrentTenant();
    const referrerId = actor.employeeId;
    if (!referrerId) {
      throw new BadRequestException('Caller has no hr_employees row in this school.');
    }

    const id = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const students = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_students WHERE school_id = $1::uuid AND id = ANY($2::uuid[])',
        tenant.schoolId,
        [input.mediatorStudentId, input.partyAStudentId, input.partyBStudentId],
      )) as Array<{ id: string }>;
      if (students.length !== 3) {
        throw new BadRequestException(
          'One or more student ids do not match students in this school',
        );
      }

      const newId = generateId();
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_peer_mediations ' +
            '(id, school_id, mediator_student_id, party_a_student_id, party_b_student_id, ' +
            ' referred_by, conflict_description, status, is_mediator_trained) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9)',
          newId,
          tenant.schoolId,
          input.mediatorStudentId,
          input.partyAStudentId,
          input.partyBStudentId,
          referrerId,
          input.conflictDescription,
          'REFERRED',
          true,
        );
      } catch (err: unknown) {
        // Schema CHECK violations surface here defensively
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('sis_peer_med_parties_chk') || msg.includes('sis_peer_med_mediator_chk')) {
          throw new BadRequestException(
            'Peer mediation violates schema constraints (mediator or parties)',
          );
        }
        throw err;
      }
      return newId;
    });

    return this.getById(id);
  }

  /**
   * Counsellor/admin schedules + records outcome.
   */
  async update(
    id: string,
    input: UpdatePeerMediationDto,
    actor: ResolvedActor,
  ): Promise<PeerMediationResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors or admins can schedule or resolve peer mediations',
      );
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const cur = (await tx.$queryRawUnsafe(
        'SELECT status FROM sis_peer_mediations WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ status: string }>;
      if (cur.length === 0) throw new NotFoundException('Peer mediation not found');
      await tx.$executeRawUnsafe(
        'UPDATE sis_peer_mediations SET ' +
          'status = COALESCE($1, status), ' +
          'mediation_date = COALESCE($2::timestamptz, mediation_date), ' +
          'outcome = COALESCE($3, outcome), ' +
          'updated_at = now() ' +
          'WHERE school_id = $4::uuid AND id = $5::uuid',
        input.status ?? null,
        input.mediationDate ?? null,
        input.outcome ?? null,
        tenant.schoolId,
        id,
      );
    });
    return this.getById(id);
  }

  /**
   * List trained student mediators in the school. Filters by
   * is_mediator_trained=true membership on prior mediations.
   * Future improvement: dedicated `sis_peer_mediator_training`
   * roster, but for now infer from prior mediations.
   */
  async listTrainedMediators(): Promise<Array<{ studentId: string; studentName: string | null }>> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT DISTINCT m.mediator_student_id::text AS student_id, ' +
          'p.first_name AS first_name, p.last_name AS last_name ' +
          'FROM sis_peer_mediations m ' +
          'JOIN sis_students s ON s.id = m.mediator_student_id ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person p ON p.id = ps.person_id ' +
          'WHERE m.school_id = $1::uuid AND m.is_mediator_trained = true ' +
          'ORDER BY last_name, first_name',
        tenant.schoolId,
      )) as Array<{ student_id: string; first_name: string | null; last_name: string | null }>;
      return rows.map((r) => ({
        studentId: r.student_id,
        studentName: fullName(r.first_name, r.last_name),
      }));
    });
  }
}
