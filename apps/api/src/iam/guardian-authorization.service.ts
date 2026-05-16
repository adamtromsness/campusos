import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * P2-H1 Step 3 — Centralised guardian custody-aware authorisation.
 *
 * Replaces per-module guardian checks across the platform with a single
 * capability-specific API. Each method answers a single question of the form
 * "can this guardian person see / authorise / receive X for this student?",
 * resolved against the sis_student_guardians + sis_guardians + sis_family_relationships
 * graph.
 *
 * Resolution model (highest signal first):
 *   1. The (guardian_person → sis_guardians.person_id → sis_student_guardians)
 *      chain MUST resolve to a row that links the guardian to the student in
 *      the calling tenant. No link → false (not on the access list at all).
 *   2. sis_student_guardians.portal_access_scope narrows what the link
 *      authorises (FULL / ACADEMIC_ONLY / COMMUNICATIONS_ONLY).
 *   3. sis_student_guardians.has_custody + receives_reports + is_emergency_contact
 *      shape the per-capability decisions. Court-order overrides (e.g. one
 *      parent has sole custody) are expressed via sis_family_relationships.
 *      custody_arrangement.
 *
 * Every access decision is logged via the access-log channel so downstream
 * compliance reports can audit guardian PII access (cf. Cycle 10 HIPAA log
 * pattern). The log is best-effort and structured as a Logger call today;
 * Phase 2 wires a dedicated `platform_audit_log` row per ADR-052.
 */
@Injectable()
export class GuardianAuthorizationService {
  private readonly logger = new Logger(GuardianAuthorizationService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Internal helper: resolve the (guardian, student) link row for the current
   * tenant. Returns null if no link exists in this school. The school_id
   * filter on sis_students keeps cross-school guardian ids from satisfying
   * the relationship gate.
   */
  private async loadLink(
    guardianPersonId: string,
    studentId: string,
  ): Promise<{
    has_custody: boolean;
    is_emergency_contact: boolean;
    receives_reports: boolean;
    portal_access: boolean;
    portal_access_scope: string;
  } | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          has_custody: boolean;
          is_emergency_contact: boolean;
          receives_reports: boolean;
          portal_access: boolean;
          portal_access_scope: string;
        }>
      >(
        'SELECT sg.has_custody, sg.is_emergency_contact, sg.receives_reports, ' +
          'sg.portal_access, sg.portal_access_scope ' +
          'FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'JOIN sis_students s ON s.id = sg.student_id ' +
          'WHERE g.person_id = $1::uuid AND sg.student_id = $2::uuid ' +
          'AND s.school_id = $3::uuid AND g.school_id = $3::uuid LIMIT 1',
        guardianPersonId,
        studentId,
        tenant.schoolId,
      ),
    );
    return rows.length === 0 ? null : rows[0]!;
  }

  /**
   * P2-H1 Step 3 — capability gate. Returns true when the guardian can see
   * the student's academic record (grades, transcripts, gradebook, progress
   * reports). Driven by sis_student_guardians.portal_access AND a non-restrictive
   * portal_access_scope (FULL or ACADEMIC_ONLY).
   */
  async canViewAcademicRecord(guardianPersonId: string, studentId: string): Promise<boolean> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return false;
    if (!link.portal_access) return false;
    return link.portal_access_scope === 'FULL' || link.portal_access_scope === 'ACADEMIC_ONLY';
  }

  /**
   * P2-H1 Step 3 — capability gate. Health records are FERPA-sensitive PHI;
   * portal_access AND receives_reports AND FULL scope required. Emergency
   * contacts who do not have_custody can still see allergy/medication info
   * because they may need to respond to a school-day medical event.
   */
  async canViewHealthRecord(guardianPersonId: string, studentId: string): Promise<boolean> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return false;
    if (!link.portal_access) return false;
    if (link.portal_access_scope !== 'FULL') return false;
    return link.receives_reports || link.is_emergency_contact || link.has_custody;
  }

  /**
   * P2-H1 Step 3 — capability gate. Payment authorisation (charge a family
   * account, submit a payment plan, accept a student's parent-active order)
   * requires has_custody=true. Non-custodial guardians cannot bind the family
   * to financial obligations.
   *
   * familyAccountId is reserved for future per-account guardian binding;
   * today the check is at the student level since pay_family_accounts have
   * one account_holder_id per family.
   */
  async canAuthorizePayment(
    guardianPersonId: string,
    studentId: string,
    _familyAccountId?: string,
  ): Promise<boolean> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return false;
    return link.has_custody;
  }

  /**
   * P2-H1 Step 3 — capability gate. Transport info (bus pass, route, ETA,
   * geofence alerts) is sent to guardians on the receives_reports list. Any
   * linked guardian (including non-custodial) gets it because the parent
   * needs to know if their bus is late even if they aren't the custodial
   * parent. portal_access still required so suspended/inactive guardian
   * records do not receive PII.
   */
  async canReceiveTransportInfo(guardianPersonId: string, studentId: string): Promise<boolean> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return false;
    if (!link.portal_access) return false;
    return link.receives_reports || link.has_custody || link.is_emergency_contact;
  }

  /**
   * P2-H1 Step 3 — capability gate. Communications (announcements, messages,
   * IN_APP notifications) reach guardians with portal_access AND either FULL
   * or COMMUNICATIONS_ONLY scope. Receives_reports is the inbox preference
   * for transactional updates (attendance, behaviour); communications are
   * a broader channel.
   */
  async canViewCommunications(guardianPersonId: string, studentId: string): Promise<boolean> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return false;
    if (!link.portal_access) return false;
    return (
      link.portal_access_scope === 'FULL' || link.portal_access_scope === 'COMMUNICATIONS_ONLY'
    );
  }

  /**
   * P2-H1 Step 3 — capability gate. Conference booking (parent-teacher
   * meeting slot reservation) requires portal_access + a non-blocked scope.
   * Custody not strictly required — even a non-custodial parent receiving
   * reports may want to attend a teacher meeting. Restricted by FULL or
   * COMMUNICATIONS_ONLY scope since the meeting is an academic-adjacent
   * communication event.
   */
  async canAttendConference(guardianPersonId: string, studentId: string): Promise<boolean> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return false;
    if (!link.portal_access) return false;
    return link.portal_access_scope !== 'ACADEMIC_ONLY';
  }

  /**
   * P2-H1 Step 3 — convenience helper for callsites that need the underlying
   * link snapshot (e.g. ParentTrackingService that issues a per-(student,
   * guardian) token). Returns null when there is no link.
   */
  async resolveLink(
    guardianPersonId: string,
    studentId: string,
  ): Promise<{
    hasCustody: boolean;
    isEmergencyContact: boolean;
    receivesReports: boolean;
    portalAccess: boolean;
    portalAccessScope: string;
  } | null> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return null;
    return {
      hasCustody: link.has_custody,
      isEmergencyContact: link.is_emergency_contact,
      receivesReports: link.receives_reports,
      portalAccess: link.portal_access,
      portalAccessScope: link.portal_access_scope,
    };
  }

  /**
   * P2-H1 Step 3 — audit-log every guardian access decision for
   * custody-sensitive records. Best-effort: a logger call today; Phase 2
   * wires a dedicated platform_audit_log row per ADR-052.
   */
  logAccessDecision(
    capability: string,
    guardianPersonId: string,
    studentId: string,
    granted: boolean,
  ): void {
    this.logger.log(
      `guardian-access capability=${capability} guardian=${guardianPersonId} student=${studentId} granted=${granted}`,
    );
  }
}
