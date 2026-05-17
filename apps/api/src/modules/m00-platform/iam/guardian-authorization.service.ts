import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';

/**
 * P2-H1 Step 3 + P2-H5 DEFECT 4 — centralised, custody-aware guardian
 * authorisation.
 *
 * Replaces per-module guardian checks with a single capability-specific API.
 * Each method answers a single question of the form "can this guardian
 * person see / authorise / receive X for this student?".
 *
 * Resolution graph (P2-H5 hardening):
 *   1. The (guardian_person → sis_guardians.person_id → sis_student_guardians)
 *      chain MUST resolve to a row that links the guardian to the student in
 *      the calling tenant. No link → false (not on the access list at all).
 *   2. sis_family_relationships.custody_arrangement (JOINT / SOLE_A / SOLE_B
 *      / OTHER) is the legal custody record. A guardian whose relationship
 *      shows the OTHER parent has sole custody is denied — sis_student_guardians
 *      can be stale, court orders are authoritative.
 *   3. sis_family_relationships.court_order_restrictions JSONB carries
 *      per-capability blocks. {"academic_records": false} explicitly denies
 *      the academic-records capability for the matching guardian.
 *   4. sis_student_guardians.portal_access_scope narrows what the link
 *      authorises (FULL / ACADEMIC_ONLY / COMMUNICATIONS_ONLY). Null/missing
 *      scope fails closed (deny) under P2-H5; only an explicit allow-state
 *      grants access.
 *   5. sis_student_guardians.has_custody + receives_reports +
 *      is_emergency_contact shape the per-capability decisions on top of the
 *      custody/court-order/scope chain.
 *
 * Every access decision is persisted to platform_audit_log with
 * data_subject_id = studentId per ADR-052. The audit row goes via the
 * AuditLog model so it shares the partitioning + retention with the rest of
 * the FERPA/GDPR access audit corpus.
 */
@Injectable()
export class GuardianAuthorizationService {
  private readonly logger = new Logger(GuardianAuthorizationService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  // ─── Internal resolution ─────────────────────────────────────

  private async loadLink(
    guardianPersonId: string,
    studentId: string,
  ): Promise<{
    guardian_id: string;
    has_custody: boolean;
    is_emergency_contact: boolean;
    receives_reports: boolean;
    portal_access: boolean;
    portal_access_scope: string | null;
    family_id: string | null;
  } | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          guardian_id: string;
          has_custody: boolean;
          is_emergency_contact: boolean;
          receives_reports: boolean;
          portal_access: boolean;
          portal_access_scope: string | null;
          family_id: string | null;
        }>
      >(
        'SELECT g.id::text AS guardian_id, sg.has_custody, sg.is_emergency_contact, sg.receives_reports, ' +
          'sg.portal_access, sg.portal_access_scope, g.family_id::text AS family_id ' +
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
   * P2-H5 DEFECT 4 + P2-H6 FIX 1: load every family-relationship row that
   * names this guardian (guardian_a / guardian_b ordering is arbitrary at
   * write time) and return the custody decision + any court-order
   * restrictions that apply.
   *
   * Fail-closed contract (P2-H6 FIX 1):
   *   - No `familyId` on the link row → deny. A guardian without a family
   *     record cannot legally authorise on behalf of the household.
   *   - Zero relationship rows in `sis_family_relationships` → deny.
   *     Absence is unknown; unknown is not "permissive". Schools must
   *     record the custody row before the guardian can act.
   *   - `custody_arrangement IS NULL` on a relationship row → deny on
   *     that row. SOLE_A / SOLE_B drive the directional exclusion;
   *     JOINT / OTHER are explicit allow-states; NULL is unknown and
   *     unknown fails closed.
   */
  private async loadCustodyContext(
    guardianId: string,
    familyId: string | null,
  ): Promise<{
    custodyAllows: boolean;
    courtOrderRestrictions: Record<string, unknown>;
  }> {
    if (!familyId) {
      // No family record means no custody arrangement — fail closed.
      return { custodyAllows: false, courtOrderRestrictions: {} };
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          guardian_a_id: string;
          guardian_b_id: string;
          custody_arrangement: string | null;
          court_order_restrictions: Record<string, unknown> | null;
        }>
      >(
        'SELECT guardian_a_id::text, guardian_b_id::text, custody_arrangement, ' +
          'court_order_restrictions ' +
          'FROM sis_family_relationships ' +
          'WHERE family_id = $1::uuid AND (guardian_a_id = $2::uuid OR guardian_b_id = $2::uuid)',
        familyId,
        guardianId,
      ),
    );
    if (rows.length === 0) {
      // P2-H6 FIX 1a: no recorded relationship — unknown custody is not a
      // permissive default. Deny until the school records the row.
      return { custodyAllows: false, courtOrderRestrictions: {} };
    }
    const mergedRestrictions: Record<string, unknown> = {};
    let custodyAllows = true;
    for (const row of rows) {
      const isA = row.guardian_a_id === guardianId;
      // P2-H6 FIX 1b: custody_arrangement NULL is unknown → deny. Only
      // JOINT / OTHER explicitly allow both sides; SOLE_A / SOLE_B drive
      // directional exclusion.
      if (row.custody_arrangement === null) custodyAllows = false;
      if (row.custody_arrangement === 'SOLE_A' && !isA) custodyAllows = false;
      if (row.custody_arrangement === 'SOLE_B' && isA) custodyAllows = false;
      if (row.court_order_restrictions) {
        Object.assign(mergedRestrictions, row.court_order_restrictions);
      }
    }
    return { custodyAllows, courtOrderRestrictions: mergedRestrictions };
  }

  private courtOrderAllows(restrictions: Record<string, unknown>, capabilityKey: string): boolean {
    // Only an explicit false denies. Missing keys mean no restriction.
    return restrictions[capabilityKey] !== false;
  }

  /**
   * P2-H5 DEFECT 4: persist each guardian access decision to
   * platform_audit_log with data_subject_id = studentId per ADR-052.
   * Logged at WARN when access is granted to capture the trail; failures
   * are logged at INFO. Best-effort — a failure to insert the audit row
   * is logged but does not block the access decision because the caller
   * has already enforced the gate at the service layer.
   */
  async logAccessDecision(
    capability: string,
    guardianPersonId: string,
    studentId: string,
    granted: boolean,
  ): Promise<void> {
    this.logger.log(
      `guardian-access capability=${capability} guardian=${guardianPersonId} student=${studentId} granted=${granted}`,
    );
    try {
      const tenant = getCurrentTenant();
      const platform = this.tenantPrisma.getPlatformClient();
      await platform.auditLog.create({
        data: {
          id: generateId(),
          actorId: guardianPersonId,
          actorType: 'HUMAN',
          action: 'guardian_access_decision',
          actionCategory: 'READ',
          entityType: 'sis_students',
          entityId: studentId,
          dataSubjectId: studentId,
          tenantId: tenant.schoolId,
          metadata: { capability, granted },
        },
      });
    } catch (err) {
      this.logger.warn(
        `guardian-access audit-log write failed capability=${capability} guardian=${guardianPersonId} student=${studentId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  // ─── Capability gates ────────────────────────────────────────

  /**
   * Academic record (grades, transcripts, gradebook). Requires
   * portal_access, FULL or ACADEMIC_ONLY scope, custody not excluded,
   * and no court-order block on `academic_records`.
   */
  async canViewAcademicRecord(guardianPersonId: string, studentId: string): Promise<boolean> {
    const granted = await this.evaluate(guardianPersonId, studentId, (link, custody) => {
      if (!link.portal_access) return false;
      if (link.portal_access_scope == null) return false;
      if (link.portal_access_scope !== 'FULL' && link.portal_access_scope !== 'ACADEMIC_ONLY') {
        return false;
      }
      if (!custody.custodyAllows) return false;
      return this.courtOrderAllows(custody.courtOrderRestrictions, 'academic_records');
    });
    await this.logAccessDecision('academic_record', guardianPersonId, studentId, granted);
    return granted;
  }

  /**
   * Health record (FERPA-sensitive PHI). Requires portal_access, FULL
   * scope, custody not excluded, no court-order block on
   * `health_records`, and the receives_reports / emergency-contact /
   * custody flag chain.
   */
  async canViewHealthRecord(guardianPersonId: string, studentId: string): Promise<boolean> {
    const granted = await this.evaluate(guardianPersonId, studentId, (link, custody) => {
      if (!link.portal_access) return false;
      if (link.portal_access_scope !== 'FULL') return false;
      if (!custody.custodyAllows) return false;
      if (!this.courtOrderAllows(custody.courtOrderRestrictions, 'health_records')) return false;
      return link.receives_reports || link.is_emergency_contact || link.has_custody;
    });
    await this.logAccessDecision('health_record', guardianPersonId, studentId, granted);
    return granted;
  }

  /**
   * Payment authorisation. Requires has_custody, custody arrangement not
   * excluding this guardian, no court-order block on
   * `financial_authority`, and — when a familyAccountId is supplied — the
   * account must be bound to the (guardian, student) relationship: the
   * account holder is this guardian AND the account links to this student.
   */
  async canAuthorizePayment(
    guardianPersonId: string,
    studentId: string,
    familyAccountId?: string,
  ): Promise<boolean> {
    const granted = await this.evaluate(guardianPersonId, studentId, (link, custody) => {
      if (!link.has_custody) return false;
      if (!custody.custodyAllows) return false;
      return this.courtOrderAllows(custody.courtOrderRestrictions, 'financial_authority');
    });
    if (!granted) {
      await this.logAccessDecision('payment_authorise', guardianPersonId, studentId, false);
      return false;
    }
    if (familyAccountId) {
      const tenant = getCurrentTenant();
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM pay_family_accounts fa ' +
            'JOIN pay_family_account_students fas ON fas.family_account_id = fa.id ' +
            'WHERE fa.id = $1::uuid AND fa.school_id = $2::uuid ' +
            'AND fa.account_holder_id = $3::uuid AND fas.student_id = $4::uuid LIMIT 1',
          familyAccountId,
          tenant.schoolId,
          guardianPersonId,
          studentId,
        ),
      );
      const accountAllows = rows.length > 0;
      await this.logAccessDecision('payment_authorise', guardianPersonId, studentId, accountAllows);
      return accountAllows;
    }
    await this.logAccessDecision('payment_authorise', guardianPersonId, studentId, true);
    return true;
  }

  /**
   * Transport info (bus pass, ETA, geofence alerts). Requires
   * portal_access, custody not excluded, and no court-order block on
   * `transport_contact`. Non-custodial parents on the receives_reports
   * list still get alerts because the bus running late is a safety event.
   */
  async canReceiveTransportInfo(guardianPersonId: string, studentId: string): Promise<boolean> {
    const granted = await this.evaluate(guardianPersonId, studentId, (link, custody) => {
      if (!link.portal_access) return false;
      if (!custody.custodyAllows) return false;
      if (!this.courtOrderAllows(custody.courtOrderRestrictions, 'transport_contact')) {
        return false;
      }
      return link.receives_reports || link.has_custody || link.is_emergency_contact;
    });
    await this.logAccessDecision('transport_info', guardianPersonId, studentId, granted);
    return granted;
  }

  /**
   * Communications (announcements, messages, IN_APP notifications).
   * Requires portal_access, FULL or COMMUNICATIONS_ONLY scope, custody
   * not excluded, and no court-order block on `communications`.
   */
  async canViewCommunications(guardianPersonId: string, studentId: string): Promise<boolean> {
    const granted = await this.evaluate(guardianPersonId, studentId, (link, custody) => {
      if (!link.portal_access) return false;
      if (link.portal_access_scope == null) return false;
      if (
        link.portal_access_scope !== 'FULL' &&
        link.portal_access_scope !== 'COMMUNICATIONS_ONLY'
      ) {
        return false;
      }
      if (!custody.custodyAllows) return false;
      return this.courtOrderAllows(custody.courtOrderRestrictions, 'communications');
    });
    await this.logAccessDecision('communications', guardianPersonId, studentId, granted);
    return granted;
  }

  /**
   * Conference attendance. Requires portal_access, a non-ACADEMIC_ONLY
   * scope (the meeting is an academic-adjacent communication event),
   * custody not excluded, and no court-order block on
   * `conference_attendance`.
   */
  async canAttendConference(guardianPersonId: string, studentId: string): Promise<boolean> {
    const granted = await this.evaluate(guardianPersonId, studentId, (link, custody) => {
      if (!link.portal_access) return false;
      if (link.portal_access_scope == null) return false;
      if (link.portal_access_scope === 'ACADEMIC_ONLY') return false;
      if (!custody.custodyAllows) return false;
      return this.courtOrderAllows(custody.courtOrderRestrictions, 'conference_attendance');
    });
    await this.logAccessDecision('conference', guardianPersonId, studentId, granted);
    return granted;
  }

  /**
   * Internal shared resolver: loads the link + custody context and runs
   * the per-capability predicate. Null link returns false (not on the
   * access list). The predicate is run only when both link and custody
   * data are present.
   */
  private async evaluate(
    guardianPersonId: string,
    studentId: string,
    predicate: (
      link: {
        guardian_id: string;
        has_custody: boolean;
        is_emergency_contact: boolean;
        receives_reports: boolean;
        portal_access: boolean;
        portal_access_scope: string | null;
        family_id: string | null;
      },
      custody: { custodyAllows: boolean; courtOrderRestrictions: Record<string, unknown> },
    ) => boolean,
  ): Promise<boolean> {
    const link = await this.loadLink(guardianPersonId, studentId);
    if (!link) return false;
    const custody = await this.loadCustodyContext(link.guardian_id, link.family_id);
    return predicate(link, custody);
  }

  /**
   * Convenience helper for callsites that need the raw link snapshot
   * (e.g. ParentTrackingService issuing per-(student, guardian) tokens).
   * Returns null when the (guardian, student) link is absent in the
   * current tenant. Does NOT consult custody data — callers that need
   * authorisation should use the capability methods above.
   */
  async resolveLink(
    guardianPersonId: string,
    studentId: string,
  ): Promise<{
    hasCustody: boolean;
    isEmergencyContact: boolean;
    receivesReports: boolean;
    portalAccess: boolean;
    portalAccessScope: string | null;
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
}
