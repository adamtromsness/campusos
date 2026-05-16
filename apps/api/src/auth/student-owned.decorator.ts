import { SetMetadata } from '@nestjs/common';

export const STUDENT_OWNED_KEY = 'studentOwned';

/**
 * P2-H1 Step 4 — @StudentOwned() metadata decorator.
 *
 * Marks an endpoint as student-owned data — mutations must be authored by
 * the calling student themselves (or a school admin override). The actual
 * enforcement lives in the service layer via assertStudentOwnsRecord() since
 * each domain has different student-id extraction conventions (path param,
 * body field, JSONB nested key, soft polymorphic ref, etc.).
 *
 * Examples of student-owned tables (the canonical list per the hardening
 * plan):
 *   - pfl_reflections (Cycle 24)
 *   - pfl_resume_profiles (Cycle 24)
 *   - pfl_college_applications (Cycle 24)
 *   - sis_student_profiles (bio / interests / motto, Cycle 19)
 *   - ath_recruiting_profiles (Cycle 13)
 *   - cls_ai_tutoring_sessions (Cycle 7c)
 *   - svc_wellbeing_checkins (Cycle 11.1)
 *   - lib_reading_logs + lib_reviews (Cycle 12)
 *
 * Usage:
 *   @StudentOwned({ studentIdBody: 'studentId' })
 *   @Post('/portfolio/reflections')
 *   create(@Body() dto: CreateReflectionDto) { ... }
 *
 * The decorator is intentionally a marker — it does not enforce. Each service
 * calls assertStudentOwnsRecord(actor, studentId, tenantPrisma) inline so
 * record-level ownership checks compose cleanly with row-scope filtering,
 * coach-delegation overrides, and per-domain capability gates.
 */
export interface StudentOwnedOptions {
  /** Optional path parameter name carrying the studentId. */
  studentIdParam?: string;
  /** Optional body field name carrying the studentId. */
  studentIdBody?: string;
  /**
   * When true (default), school admins bypass the ownership check. Set to
   * false for surfaces where even admins cannot impersonate a student write
   * (e.g. student-owned reflections, where an admin "ghost-writing" a
   * reflection would be a FERPA / pedagogical contract breach).
   */
  allowAdminOverride?: boolean;
  /**
   * When true (default false), coach role can write on behalf of the student
   * via the iam_delegations pattern. Only honoured for ath_recruiting_profiles
   * (see hardening plan IMP-11).
   */
  allowCoachDelegation?: boolean;
}

export var StudentOwned = function (options: StudentOwnedOptions = {}) {
  return SetMetadata(STUDENT_OWNED_KEY, {
    allowAdminOverride: true,
    allowCoachDelegation: false,
    ...options,
  });
};
