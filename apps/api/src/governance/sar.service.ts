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
import { GovernanceAccess } from './access';
import type { CreateSarDto, SubjectAccessRequestDto, UpdateSarDto } from './dto/governance.dto';

/**
 * SarService — GDPR Article 15 Subject Access Requests + 30/45-day
 * deadline tracking.
 *
 * Two row-scope tiers:
 *   - DPO scope (school admin OR holds dpo-004:write) sees everything.
 *   - GUARDIAN scope sees only own children's requests via
 *     sis_student_guardians; GUARDIAN can only submit for a child
 *     whose data_subject_is_self=false.
 *   - STUDENT scope sees only own requests; can only submit for self.
 *
 * **AGE-18 RIGHTS TRANSFER (KEYSTONE):** when
 * platform_students.data_subject_is_self=true, the student is the
 * sole permitted submitter; the GUARDIAN-submit path is refused with
 * a redirect message.
 */
@Injectable()
export class SarService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly access: GovernanceAccess,
  ) {}

  /**
   * "DPO scope" for SAR mutation = school admin OR (STAFF persona
   * with dpo-004:write). Parents + students hold dpo-004:write for
   * self-service submission via the SAR create path, but they MUST
   * NOT mutate any SAR (including their own submission's status) —
   * status flips are DPO-internal.
   */
  async hasDpoScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-004:write',
    ]);
  }

  private async getDefaultDeadlineDays(): Promise<number> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT sar_default_deadline_days FROM dpo_compliance_dashboard_config WHERE school_id = $1::uuid LIMIT 1`,
        tenant.schoolId,
      );
    })) as Array<{ sar_default_deadline_days: number }>;
    return rows[0]?.sar_default_deadline_days ?? 30;
  }

  /**
   * Build the row-scope WHERE predicate for non-DPO callers. Returns
   * { sql, params, nextIndex } so the caller can append more clauses.
   */
  private async buildVisibility(
    actor: ResolvedActor,
    startIndex: number,
  ): Promise<{ sql: string; params: unknown[]; nextIndex: number }> {
    if (await this.hasDpoScope(actor)) {
      return { sql: 'TRUE', params: [], nextIndex: startIndex };
    }
    if (actor.personType === 'GUARDIAN' && actor.personId) {
      // Children of this guardian via sis_student_guardians
      const sql = `(s.requested_by = $${startIndex}::uuid OR s.data_subject_id IN (
        SELECT ip.id FROM platform.iam_person ip
          WHERE ip.id IN (
            SELECT ps.person_id FROM platform.platform_students ps
              JOIN sis_students st ON st.platform_student_id = ps.id
              JOIN sis_student_guardians ssg ON ssg.student_id = st.id
              JOIN sis_guardians g ON g.id = ssg.guardian_id
              WHERE g.person_id = $${startIndex + 1}::uuid
          )
      ))`;
      return {
        sql,
        params: [actor.accountId, actor.personId],
        nextIndex: startIndex + 2,
      };
    }
    if (actor.personType === 'STUDENT' && actor.personId) {
      return {
        sql: `s.data_subject_id = $${startIndex}::uuid`,
        params: [actor.personId],
        nextIndex: startIndex + 1,
      };
    }
    return { sql: 'FALSE', params: [], nextIndex: startIndex };
  }

  /**
   * Returns true when the student data subject has flipped
   * data_subject_is_self=true (age-18 transfer). Returns false when
   * data subject isn't a student row (e.g. staff erasure).
   */
  private async isAgeOfMajority(dataSubjectPersonId: string): Promise<boolean> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT data_subject_is_self FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
        dataSubjectPersonId,
      );
    })) as Array<{ data_subject_is_self: boolean }>;
    if (rows.length === 0) return false;
    return rows[0]!.data_subject_is_self === true;
  }

  /**
   * GUARDIAN submitters must be linked via sis_student_guardians +
   * sis_guardians.person_id == actor.personId.
   */
  private async assertGuardianLink(
    actor: ResolvedActor,
    dataSubjectPersonId: string,
  ): Promise<void> {
    if (!actor.personId) {
      throw new ForbiddenException('Guardian must have a registered iam_person row.');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 AS x
           FROM sis_student_guardians ssg
           JOIN sis_guardians g ON g.id = ssg.guardian_id
           JOIN sis_students s ON s.id = ssg.student_id
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
          WHERE g.person_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1`,
        actor.personId,
        dataSubjectPersonId,
      );
    })) as Array<unknown>;
    if (rows.length === 0) {
      throw new ForbiddenException('Only a linked guardian can submit a SAR on behalf of a child.');
    }
  }

  private async resolvePersonName(personId: string | null): Promise<string | null> {
    if (!personId) return null;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT first_name || ' ' || last_name AS name FROM platform.iam_person WHERE id = $1::uuid LIMIT 1`,
        personId,
      );
    })) as Array<{ name: string }>;
    return rows[0]?.name ?? null;
  }

  private async resolveAccountName(accountId: string | null): Promise<string | null> {
    if (!accountId) return null;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT ip.first_name || ' ' || ip.last_name AS name
           FROM platform.platform_users pu
           JOIN platform.iam_person ip ON ip.id = pu.person_id
          WHERE pu.id = $1::uuid LIMIT 1`,
        accountId,
      );
    })) as Array<{ name: string }>;
    return rows[0]?.name ?? null;
  }

  private rowToSarDto(
    r: Record<string, unknown>,
    dataSubjectName: string | null,
    requestedByName: string | null,
  ): SubjectAccessRequestDto {
    const deadline = String(r.deadline_date).slice(0, 10);
    const deadlineMs = new Date(deadline + 'T23:59:59Z').getTime();
    const days = Math.ceil((deadlineMs - Date.now()) / (24 * 60 * 60 * 1000));
    const status = r.status as SubjectAccessRequestDto['status'];
    const terminal = status === 'COMPLETED' || status === 'DENIED';
    const isOverdue = !terminal && deadlineMs < Date.now();
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      dataSubjectId: r.data_subject_id as string,
      dataSubjectName,
      requestedById: r.requested_by as string,
      requestedByName,
      requestType: r.request_type as SubjectAccessRequestDto['requestType'],
      requestDetails: (r.request_details as string | null) ?? null,
      deadlineDate: deadline,
      status,
      responseS3Key: (r.response_s3_key as string | null) ?? null,
      completedAt: (r.completed_at as Date | null)?.toISOString() ?? null,
      denialReason: (r.denial_reason as string | null) ?? null,
      extensionReason: (r.extension_reason as string | null) ?? null,
      extensionUntil: r.extension_until ? String(r.extension_until).slice(0, 10) : null,
      daysUntilDeadline: days,
      isOverdue,
      notes: (r.notes as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async list(
    actor: ResolvedActor,
    args?: { status?: string; overdueOnly?: boolean },
  ): Promise<SubjectAccessRequestDto[]> {
    const tenant = getCurrentTenant();
    const vis = await this.buildVisibility(actor, 2);
    const where: string[] = ['s.school_id = $1::uuid', vis.sql];
    const params: unknown[] = [tenant.schoolId, ...vis.params];
    let i = vis.nextIndex;
    if (args?.status) {
      where.push(`s.status = $${i}`);
      params.push(args.status);
      i++;
    }
    if (args?.overdueOnly) {
      where.push("s.deadline_date < CURRENT_DATE AND s.status NOT IN ('COMPLETED','DENIED')");
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.* FROM dpo_subject_access_requests s
          WHERE ${where.join(' AND ')}
          ORDER BY s.deadline_date ASC, s.created_at DESC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    const out: SubjectAccessRequestDto[] = [];
    for (const r of rows) {
      const dn = await this.resolvePersonName(r.data_subject_id as string);
      const rn = await this.resolveAccountName(r.requested_by as string);
      out.push(this.rowToSarDto(r, dn, rn));
    }
    return out;
  }

  async getById(actor: ResolvedActor, id: string): Promise<SubjectAccessRequestDto> {
    const tenant = getCurrentTenant();
    const vis = await this.buildVisibility(actor, 3);
    const params: unknown[] = [id, tenant.schoolId, ...vis.params];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT s.* FROM dpo_subject_access_requests s WHERE s.id = $1::uuid AND s.school_id = $2::uuid AND ${vis.sql} LIMIT 1`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`SAR ${id} not found.`);
    const dn = await this.resolvePersonName(rows[0]!.data_subject_id as string);
    const rn = await this.resolveAccountName(rows[0]!.requested_by as string);
    return this.rowToSarDto(rows[0]!, dn, rn);
  }

  async create(actor: ResolvedActor, input: CreateSarDto): Promise<SubjectAccessRequestDto> {
    const isDpo = await this.hasDpoScope(actor);
    // Age-18 keystone: GUARDIAN refused if student is data_subject_is_self
    const ageOfMajority = await this.isAgeOfMajority(input.dataSubjectId);
    if (actor.personType === 'GUARDIAN') {
      if (ageOfMajority) {
        throw new ForbiddenException(
          'This student is the data subject for their own data (age 18+). Only the student or a DPO administrator can submit a SAR for their data.',
        );
      }
      await this.assertGuardianLink(actor, input.dataSubjectId);
    } else if (actor.personType === 'STUDENT') {
      if (actor.personId !== input.dataSubjectId) {
        throw new ForbiddenException('Students can only submit a SAR for their own data.');
      }
    } else if (!isDpo) {
      throw new ForbiddenException(
        'SAR submission is restricted to data subjects, linked guardians, or the DPO.',
      );
    }
    // REVIEW-CYCLE30 BLOCKING 3 — DPO-created SARs must reference a
    // person affiliated with this school. The GUARDIAN/STUDENT branches
    // above already enforce affiliation via the link checks; the DPO
    // path needs the explicit tenant-validation gate.
    if (isDpo && actor.personType !== 'GUARDIAN' && actor.personType !== 'STUDENT') {
      await this.access.assertDataSubjectInCurrentTenant(input.dataSubjectId);
    }
    const tenant = getCurrentTenant();
    const days = await this.getDefaultDeadlineDays();
    const deadline = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO dpo_subject_access_requests
         (id, school_id, data_subject_id, requested_by, request_type, request_details, deadline_date, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, 'RECEIVED', $8)`,
        id,
        tenant.schoolId,
        input.dataSubjectId,
        actor.accountId,
        input.requestType,
        input.requestDetails ?? null,
        deadline,
        input.notes ?? null,
      );
    });
    return this.getById(actor, id);
  }

  async update(
    actor: ResolvedActor,
    id: string,
    input: UpdateSarDto,
  ): Promise<SubjectAccessRequestDto> {
    if (!(await this.hasDpoScope(actor))) {
      throw new ForbiddenException('Only the DPO can mutate SARs (dpo-004:write).');
    }
    const tenant = getCurrentTenant();
    // REVIEW-CYCLE30 MAJOR 9 — locked-row + status-safe transition.
    // Prior implementation read state via getById() then UPDATE'd
    // separately; two DPO users could race the same SAR transition.
    // Now: SELECT … FOR UPDATE inside the same tx as the write, validate
    // the locked snapshot, and emit BadRequestException on terminal-status
    // attempts so the behaviour matches the row-locked state-machine
    // pattern used in Cycle 5/6/8/9/10/11/13/15.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockedRows = (await tx.$queryRawUnsafe(
        `SELECT status FROM dpo_subject_access_requests
          WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (lockedRows.length === 0) throw new NotFoundException(`SAR ${id} not found.`);
      const lockedStatus = lockedRows[0]!.status;
      if (lockedStatus === 'COMPLETED' || lockedStatus === 'DENIED') {
        throw new BadRequestException(
          'A SAR in COMPLETED or DENIED status is immutable. Open a new request instead.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      const push = (col: string, val: unknown, cast?: string) => {
        sets.push(`${col} = $${i}${cast ?? ''}`);
        params.push(val);
        i++;
      };
      let stampCompleted = false;
      if (input.status !== undefined) {
        push('status', input.status);
        if (input.status === 'COMPLETED' || input.status === 'DENIED') stampCompleted = true;
      }
      if (input.responseS3Key !== undefined) push('response_s3_key', input.responseS3Key);
      if (input.denialReason !== undefined) push('denial_reason', input.denialReason);
      if (input.extensionReason !== undefined) push('extension_reason', input.extensionReason);
      if (input.extensionUntil !== undefined)
        push('extension_until', input.extensionUntil, '::date');
      if (input.notes !== undefined) push('notes', input.notes);
      if (stampCompleted) {
        push('completed_at', new Date().toISOString(), '::timestamptz');
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      params.push(tenant.schoolId);
      await tx.$executeRawUnsafe(
        `UPDATE dpo_subject_access_requests SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
      );
    });
    return this.getById(actor, id);
  }
}
