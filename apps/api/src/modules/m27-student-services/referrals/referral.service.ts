import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { KafkaProducerService } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { ReferralActivityService } from './referral-activity.service';
import { ReferralTypeService } from './referral-type.service';
import { CaseloadService } from '../caseload/caseload.service';
import {
  AcceptReferralDto,
  CompleteReferralDto,
  CreateReferralDto,
  DeclineReferralDto,
  ListReferralsQueryDto,
  PrimaryConcern,
  ReferralPriority,
  ReferralResponseDto,
  ReferralStatus,
  TriageReferralDto,
} from '../counselling/dto/counselling.dto';

interface ReferralRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  student_grade: string | null;
  referred_by: string;
  reporter_first: string | null;
  reporter_last: string | null;
  referral_type_id: string;
  referral_type_name: string;
  requires_parent_notification: boolean;
  assigned_counselor_id: string | null;
  counselor_first: string | null;
  counselor_last: string | null;
  priority: string;
  status: string;
  reason: string;
  parent_notified: boolean;
  parent_notified_at: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_REFERRAL_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, ' +
  'r.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, s.grade_level AS student_grade, ' +
  'r.referred_by::text AS referred_by, ' +
  'rp.first_name AS reporter_first, rp.last_name AS reporter_last, ' +
  'r.referral_type_id::text AS referral_type_id, rt.name AS referral_type_name, ' +
  'rt.requires_parent_notification, ' +
  'r.assigned_counselor_id::text AS assigned_counselor_id, ' +
  'cp.first_name AS counselor_first, cp.last_name AS counselor_last, ' +
  'r.priority, r.status, r.reason, r.parent_notified, ' +
  'TO_CHAR(r.parent_notified_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS parent_notified_at, ' +
  'r.outcome, ' +
  'TO_CHAR(r.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(r.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_referrals r ' +
  'JOIN svc_referral_types rt ON rt.id = r.referral_type_id ' +
  'JOIN sis_students s ON s.id = r.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'JOIN hr_employees re ON re.id = r.referred_by ' +
  'JOIN platform.iam_person rp ON rp.id = re.person_id ' +
  'LEFT JOIN hr_employees ce ON ce.id = r.assigned_counselor_id ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = ce.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: ReferralRow): ReferralResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentFirstName: r.student_first,
    studentLastName: r.student_last,
    studentGradeLevel: r.student_grade,
    referredById: r.referred_by,
    referredByName: fullName(r.reporter_first, r.reporter_last),
    referralTypeId: r.referral_type_id,
    referralTypeName: r.referral_type_name,
    requiresParentNotification: r.requires_parent_notification,
    assignedCounselorId: r.assigned_counselor_id,
    assignedCounselorName: fullName(r.counselor_first, r.counselor_last),
    priority: r.priority as ReferralPriority,
    status: r.status as ReferralStatus,
    reason: r.reason,
    parentNotified: r.parent_notified,
    parentNotifiedAt: r.parent_notified_at,
    outcome: r.outcome,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Map the referral's primary referral_type → the corresponding caseload
 * primary_concern when the caller asks to auto-open a caseload from an
 * accepted referral. The mapping is best-effort by name: schools layer
 * their own catalogue on top of the seeded defaults so an unknown type
 * falls through to GENERAL.
 */
function inferConcern(typeName: string): PrimaryConcern {
  const t = typeName.toLowerCase();
  if (t.includes('social') || t.includes('emotional')) return 'SOCIAL_EMOTIONAL';
  if (t.includes('academic')) return 'ACADEMIC';
  if (t.includes('behaviour') || t.includes('behavioral') || t.includes('conduct'))
    return 'BEHAVIORAL';
  if (t.includes('attendance') || t.includes('truancy')) return 'ATTENDANCE';
  if (t.includes('crisis')) return 'CRISIS';
  if (t.includes('transition')) return 'TRANSITION';
  return 'GENERAL';
}

@Injectable()
export class ReferralService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly activity: ReferralActivityService,
    private readonly types: ReferralTypeService,
    private readonly caseloads: CaseloadService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-001:write (the canonical
   * counsellor signal — IAM seed grants this only to Staff / Admin, not
   * to Teacher). Used to gate triage / accept / start / complete /
   * decline at the service layer so a teacher who can submit referrals
   * (cou-002:write held) cannot drive the lifecycle past SUBMITTED.
   */
  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-001:write',
    ]);
  }

  /**
   * Visibility model — split STAFF into counsellor vs non-counsellor
   * branches per REVIEW-CYCLE11 BLOCKING 1. The previous implementation
   * unioned (assigned | unassigned-triage-queue | own-submitted) for
   * every STAFF actor with employeeId, which leaked the triage queue
   * (and therefore every unassigned referral's reason text) to teachers
   * who hold cou-002:write but not cou-001:write.
   *
   * - Admin (`isSchoolAdmin`)                     → all referrals in tenant.
   * - Counsellor (STAFF + holds cou-001:write)    → assigned to me OR
   *   unassigned-triage-queue OR own-submitted. The triage queue
   *   predicate is the gate that lets a counsellor pick up new work.
   * - Non-counsellor STAFF (e.g. teacher with cou-002:write only)
   *                                                → own-submitted only.
   *   Teachers cannot enumerate the triage queue.
   * - Parent / Student / unknown                  → no rows.
   *
   * Async because the counsellor-scope check reads the IAM cache.
   */
  private async buildVisibility(
    actor: ResolvedActor,
    start: number,
  ): Promise<{ fragment: string; params: unknown[]; consumed: number }> {
    if (actor.isSchoolAdmin) {
      return { fragment: '', params: [], consumed: 0 };
    }
    if (actor.personType === 'STAFF' && actor.employeeId) {
      const isCounsellor = await this.hasCounsellorScope(actor);
      if (isCounsellor) {
        // assigned_counselor_id = me OR unassigned-SUBMITTED triage queue OR own-submitted
        return {
          fragment:
            'AND (r.assigned_counselor_id = $' +
            start +
            '::uuid OR (r.assigned_counselor_id IS NULL AND r.status = ' +
            "'SUBMITTED') OR r.referred_by = $" +
            start +
            '::uuid) ',
          params: [actor.employeeId],
          consumed: 1,
        };
      }
      // Non-counsellor STAFF: own-submitted only.
      return {
        fragment: 'AND r.referred_by = $' + start + '::uuid ',
        params: [actor.employeeId],
        consumed: 1,
      };
    }
    return { fragment: 'AND FALSE ', params: [], consumed: 0 };
  }

  async list(query: ListReferralsQueryDto, actor: ResolvedActor): Promise<ReferralResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 200);
    const visibility = await this.buildVisibility(actor, 1);
    const sql: string[] = [SELECT_REFERRAL_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [...visibility.params];
    let idx = 1 + visibility.consumed;
    if (visibility.fragment) sql.push(visibility.fragment);
    if (query.status) {
      sql.push('AND r.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.priority) {
      sql.push('AND r.priority = $' + idx + ' ');
      params.push(query.priority);
      idx++;
    }
    if (query.referralTypeId) {
      sql.push('AND r.referral_type_id = $' + idx + '::uuid ');
      params.push(query.referralTypeId);
      idx++;
    }
    if (query.studentId) {
      sql.push('AND r.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    if (query.assignedCounselorId) {
      sql.push('AND r.assigned_counselor_id = $' + idx + '::uuid ');
      params.push(query.assignedCounselorId);
      idx++;
    }
    sql.push(
      "ORDER BY CASE r.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, " +
        'r.created_at DESC ',
    );
    sql.push('LIMIT ' + limit);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReferralRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<ReferralResponseDto> {
    const dto = await this.loadOrFail(id, actor);
    const activity = await this.activity.listForReferral(id);
    return { ...dto, activity };
  }

  /**
   * Submit a new referral. Stamps referred_by from actor.employeeId;
   * refuses if the caller has no hr_employees row. Copies default
   * priority from the referral_type when the caller doesn't supply
   * one. Auto-creates an initial STATUS_CHANGE activity row inside the
   * same transaction so the audit timeline starts at SUBMITTED. Emits
   * `svc.referral.created` outside the tx so a broker hiccup doesn't
   * roll back the user's submission.
   */
  async create(input: CreateReferralDto, actor: ResolvedActor): Promise<ReferralResponseDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException('Only staff with an employee record can submit referrals');
    }
    const tenant = getCurrentTenant();
    const refType = await this.types.assertActive(input.referralTypeId);
    const priority = input.priority ?? refType.defaultPriority;
    const id = generateId();

    // Validate the supplied student exists in this tenant.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      )) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }
    });

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO svc_referrals (id, school_id, student_id, referred_by, referral_type_id, ' +
          "priority, status, reason) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'SUBMITTED', $7)",
        id,
        tenant.schoolId,
        input.studentId,
        actor.employeeId,
        input.referralTypeId,
        priority,
        input.reason,
      );
      await this.activity.recordActivity(tx, id, actor.accountId, 'STATUS_CHANGE', 'Submitted.');
    });

    const dto = await this.loadOrFailNoAuth(id);
    void this.kafka.emit({
      topic: 'svc.referral.created',
      key: id,
      sourceModule: 'counselling',
      payload: {
        referralId: id,
        sourceRefId: id,
        schoolId: tenant.schoolId,
        studentId: input.studentId,
        studentName: fullName(dto.studentFirstName, dto.studentLastName),
        referralTypeId: input.referralTypeId,
        referralTypeName: refType.name,
        priority,
        requiresParentNotification: refType.requiresParentNotification,
        referredById: actor.employeeId,
        referredByName: dto.referredByName,
        referredByAccountId: actor.accountId,
        reason: input.reason,
        status: 'SUBMITTED' as ReferralStatus,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
    return dto;
  }

  /**
   * Counsellor or admin transitions SUBMITTED → TRIAGED. Locks the row,
   * stamps assigned_counselor_id, writes ASSIGNMENT_CHANGE + STATUS_CHANGE
   * activity rows in the same tx.
   */
  async triage(
    id: string,
    input: TriageReferralDto,
    actor: ResolvedActor,
  ): Promise<ReferralResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can triage referrals');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_referrals WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Referral ' + id);
      if (lockRows[0]!.status !== 'SUBMITTED') {
        throw new BadRequestException(
          'Referral is in status ' + lockRows[0]!.status + '; only SUBMITTED can be triaged',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_referrals SET status = 'TRIAGED', assigned_counselor_id = $2::uuid, " +
          'updated_at = now() WHERE id = $1::uuid',
        id,
        input.assignedCounselorId,
      );
      await this.activity.recordActivity(
        tx,
        id,
        actor.accountId,
        'ASSIGNMENT_CHANGE',
        'Triaged and assigned to counsellor.',
      );
      await this.activity.recordActivity(
        tx,
        id,
        actor.accountId,
        'STATUS_CHANGE',
        input.notes ?? 'SUBMITTED → TRIAGED',
      );
    });
    return this.loadOrFail(id, actor);
  }

  /**
   * Counsellor or admin transitions TRIAGED → ACCEPTED. When
   * `openCaseload=true` the service will additionally open a caseload
   * for the referral's student under the assigned counsellor in the
   * same tx — completing the seeded vertical-slice flow.
   *
   * On accept, status flips to ACCEPTED. The caller then transitions
   * the referral to IN_PROGRESS via their own follow-up workflow (e.g.
   * scheduling sessions). The auto-caseload path bypasses that and
   * leaves the referral in ACCEPTED so the activity timeline shows
   * both the ACCEPT and the caseload link.
   */
  async accept(
    id: string,
    input: AcceptReferralDto,
    actor: ResolvedActor,
  ): Promise<ReferralResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can accept referrals');
    }
    let createdCaseloadId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT student_id::text AS student_id, status, assigned_counselor_id::text AS assigned_counselor_id, ' +
          'referral_type_id::text AS referral_type_id ' +
          'FROM svc_referrals WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        student_id: string;
        status: string;
        assigned_counselor_id: string | null;
        referral_type_id: string;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Referral ' + id);
      const row = lockRows[0]!;
      if (row.status !== 'TRIAGED' && row.status !== 'SUBMITTED') {
        throw new BadRequestException(
          'Referral is in status ' + row.status + '; only TRIAGED or SUBMITTED can be accepted',
        );
      }
      if (!row.assigned_counselor_id) {
        throw new BadRequestException(
          'Referral has no assigned counsellor — triage and assign before accepting',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_referrals SET status = 'ACCEPTED', updated_at = now() WHERE id = $1::uuid",
        id,
      );
      await this.activity.recordActivity(
        tx,
        id,
        actor.accountId,
        'STATUS_CHANGE',
        input.notes ?? row.status + ' → ACCEPTED',
      );
    });

    if (input.openCaseload) {
      // Re-read after the in-tx UPDATE to get the locked snapshot.
      const lockedDto = await this.loadOrFailNoAuth(id);
      if (!input.academicYearId) {
        throw new BadRequestException('academicYearId is required when openCaseload=true');
      }
      const concern =
        input.caseloadConcern ?? inferConcern(lockedDto.referralTypeName ?? 'GENERAL');
      createdCaseloadId = await this.caseloads.createInternal({
        counselorId: lockedDto.assignedCounselorId!,
        studentId: lockedDto.studentId,
        academicYearId: input.academicYearId,
        primaryConcern: concern,
        isPrimaryCounselor: true,
        openedAt: new Date().toISOString().slice(0, 10),
        notes: 'Auto-opened from referral ' + id,
      });
      // Append a NOTE_ADDED activity row referencing the new caseload
      // — outside the locking tx since createInternal opens its own
      // tenant context for the caseload INSERT. The activity row uses
      // a fresh tx but is committed before the response returns.
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await this.activity.recordActivity(
          tx,
          id,
          actor.accountId,
          'NOTE_ADDED',
          'Auto-opened caseload ' + createdCaseloadId,
        );
      });
    }

    return this.getById(id, actor);
  }

  /**
   * Counsellor or admin transitions ACCEPTED → IN_PROGRESS. Recorded as
   * a separate transition so the activity timeline distinguishes the
   * acceptance moment from the start of casework.
   */
  async start(id: string, actor: ResolvedActor): Promise<ReferralResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can start a referral');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_referrals WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Referral ' + id);
      if (lockRows[0]!.status !== 'ACCEPTED') {
        throw new BadRequestException(
          'Referral is in status ' +
            lockRows[0]!.status +
            '; only ACCEPTED can transition to IN_PROGRESS',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_referrals SET status = 'IN_PROGRESS', updated_at = now() WHERE id = $1::uuid",
        id,
      );
      await this.activity.recordActivity(
        tx,
        id,
        actor.accountId,
        'STATUS_CHANGE',
        'ACCEPTED → IN_PROGRESS',
      );
    });
    return this.loadOrFail(id, actor);
  }

  async complete(
    id: string,
    input: CompleteReferralDto,
    actor: ResolvedActor,
  ): Promise<ReferralResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can complete a referral');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_referrals WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Referral ' + id);
      if (lockRows[0]!.status !== 'IN_PROGRESS' && lockRows[0]!.status !== 'ACCEPTED') {
        throw new BadRequestException(
          'Referral is in status ' +
            lockRows[0]!.status +
            '; only IN_PROGRESS or ACCEPTED can be completed',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_referrals SET status = 'COMPLETED', outcome = $2, updated_at = now() WHERE id = $1::uuid",
        id,
        input.outcome,
      );
      await this.activity.recordActivity(
        tx,
        id,
        actor.accountId,
        'STATUS_CHANGE',
        'Completed: ' + input.outcome,
      );
    });
    return this.loadOrFail(id, actor);
  }

  async decline(
    id: string,
    input: DeclineReferralDto,
    actor: ResolvedActor,
  ): Promise<ReferralResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can decline a referral');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_referrals WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Referral ' + id);
      const s = lockRows[0]!.status;
      if (s === 'COMPLETED' || s === 'DECLINED' || s === 'CANCELLED') {
        throw new BadRequestException('Referral is in terminal status ' + s + '; cannot decline');
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_referrals SET status = 'DECLINED', outcome = $2, updated_at = now() WHERE id = $1::uuid",
        id,
        input.reason,
      );
      await this.activity.recordActivity(
        tx,
        id,
        actor.accountId,
        'STATUS_CHANGE',
        'Declined: ' + input.reason,
      );
    });
    return this.loadOrFail(id, actor);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string, actor: ResolvedActor): Promise<ReferralResponseDto> {
    // Wave 3 follow-up: explicit r.school_id predicate. Schema-per-
    // school makes this a no-op in production, but the shared
    // tenant_test schema in the integration harness would otherwise
    // return a foreign-school referral by id-probe under an admin
    // actor (admin's buildVisibility fragment is empty).
    const tenant = getCurrentTenant();
    const visibility = await this.buildVisibility(actor, 3);
    const sql =
      SELECT_REFERRAL_BASE +
      'WHERE r.id = $1::uuid AND r.school_id = $2::uuid ' +
      visibility.fragment;
    const params: unknown[] = [id, tenant.schoolId, ...visibility.params];
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReferralRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Referral ' + id);
    return rowToDto(rows[0]!);
  }

  private async loadOrFailNoAuth(id: string): Promise<ReferralResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReferralRow[]>(
        SELECT_REFERRAL_BASE + 'WHERE r.id = $1::uuid AND r.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Referral ' + id);
    return rowToDto(rows[0]!);
  }
}
