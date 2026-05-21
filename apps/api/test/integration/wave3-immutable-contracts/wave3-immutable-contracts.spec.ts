import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import { TEST_ADMIN_ACCOUNT_ID, TEST_OFFICER_EMPLOYEE_ID } from '../helpers/actor';

/**
 * Wave 3 — DB-level IMMUTABLE trigger contracts for the safety-critical
 * audit tables (migration 177 prevent_mutation):
 *
 *   - inc_incident_timeline   (m87-safety)
 *   - hlth_health_access_log   (m23-health)
 *   - svc_referral_activity    (m27-student-services)
 *
 * These are the 6th, 7th, 8th IMMUTABLE tables verified DB-side by the
 * integration suite. Strategy doc Wave 3 calls each out under its
 * module's spec list; this slice lands the contracts cleanly so the
 * per-module deep specs can build on the proven trigger behaviour.
 *
 * Each trigger uses the same prevent_mutation BEFORE UPDATE OR DELETE
 * pattern. TRUNCATE bypasses BEFORE ROW triggers, so per-test cleanup
 * is via TRUNCATE on the IMMUTABLE table (parent rows are DELETEd in
 * the conventional way).
 */
describe('integration:wave3-immutable-contracts', () => {
  let rawClient: PrismaClient;

  beforeAll(async () => {
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await rawClient.$disconnect();
  });

  // Track all test-seeded ids so beforeEach can purge them. The
  // IMMUTABLE child tables get TRUNCATEd; the parent tables (which
  // are NOT IMMUTABLE) get DELETEd by id.
  const seededIncidentIds: string[] = [];
  const seededReferralIds: string[] = [];
  const seededReferralTypeIds: string[] = [];
  const seededStudentIds: string[] = [];
  const seededPlatformStudentIds: string[] = [];
  const seededPersonIds: string[] = [];
  const seededErasureRequestIds: string[] = [];

  beforeEach(async () => {
    // TRUNCATE the four IMMUTABLE child tables (bypasses BEFORE ROW
    // triggers). Order doesn't matter — independent tables.
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.inc_incident_timeline, ${TEST_SCHEMA}.hlth_health_access_log, ${TEST_SCHEMA}.svc_referral_activity, ${TEST_SCHEMA}.dpo_pseudonymisation_log`,
    );
    if (seededErasureRequestIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.dpo_erasure_requests WHERE id = ANY($1::uuid[])`,
        seededErasureRequestIds.splice(0),
      );
    }
    // Delete parent rows from prior tests
    if (seededReferralIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_referrals WHERE id = ANY($1::uuid[])`,
        seededReferralIds.splice(0),
      );
    }
    if (seededReferralTypeIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_referral_types WHERE id = ANY($1::uuid[])`,
        seededReferralTypeIds.splice(0),
      );
    }
    if (seededIncidentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE id = ANY($1::uuid[])`,
        seededIncidentIds.splice(0),
      );
    }
    if (seededStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        seededStudentIds.splice(0),
      );
    }
    if (seededPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        seededPlatformStudentIds.splice(0),
      );
    }
    if (seededPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        seededPersonIds.splice(0),
      );
    }
  });

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    seededPersonIds.push(personId);
    seededPlatformStudentIds.push(platformStudentId);
    seededStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'W3', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'W3', 'Student', true) ON CONFLICT (id) DO NOTHING`,
      platformStudentId,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'W3-IMM-' + studentId,
    );
    return studentId;
  }

  async function seedIncident(): Promise<string> {
    const id = generateId();
    seededIncidentIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_incidents (id, school_id, declared_by, title, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Wave 3 test incident', 'ACTIVE')`,
      id,
      TEST_SCHOOL_ID,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  async function seedReferralType(): Promise<string> {
    const id = generateId();
    seededReferralTypeIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referral_types (id, school_id, name, default_priority, is_active)
       VALUES ($1::uuid, $2::uuid, $3, 'MEDIUM', true)`,
      id,
      TEST_SCHOOL_ID,
      'W3-TYPE-' + id,
    );
    return id;
  }

  async function seedReferral(studentId: string, referralTypeId: string): Promise<string> {
    const id = generateId();
    seededReferralIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referrals (id, school_id, student_id, referred_by, referral_type_id, priority, status, reason)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'MEDIUM', 'SUBMITTED', 'Wave 3 IMMUTABLE test')`,
      id,
      TEST_SCHOOL_ID,
      studentId,
      TEST_OFFICER_EMPLOYEE_ID, // hr_employees.id from the employees fixture
      referralTypeId,
    );
    return id;
  }

  // Helper that asserts an UPDATE or DELETE raises SQLSTATE 23001
  // (immutable_violation) — the prevent_mutation trigger from migration 177.
  async function assertRaises23001(fn: () => Promise<unknown>): Promise<void> {
    let caught: { meta?: { code?: string }; message?: string } | undefined;
    try {
      await fn();
    } catch (err) {
      caught = err as { meta?: { code?: string }; message?: string };
    }
    expect(caught).toBeDefined();
    const code = caught?.meta?.code ?? '';
    const msg = caught?.message ?? '';
    expect(
      code === '23001' || msg.includes('23001') || msg.toLowerCase().includes('immutable'),
    ).toBe(true);
  }

  // ────────────────────────────────────────────────────────────────────
  // inc_incident_timeline (m87-safety)
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE inc_incident_timeline', () => {
    async function seedTimelineEntry(): Promise<string> {
      const incidentId = await seedIncident();
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.inc_incident_timeline (id, incident_id, recorded_by, event_type, description)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'DECLARED', 'Incident declared by admin')`,
        id,
        incidentId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }

    it('UPDATE description → SQLSTATE 23001', async () => {
      const id = await seedTimelineEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.inc_incident_timeline SET description = 'tampered' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE event_type → SQLSTATE 23001', async () => {
      const id = await seedTimelineEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.inc_incident_timeline SET event_type = 'RESOLVED' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE metadata → SQLSTATE 23001', async () => {
      const id = await seedTimelineEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.inc_incident_timeline SET metadata = '{"injected":true}'::jsonb WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('DELETE → SQLSTATE 23001', async () => {
      const id = await seedTimelineEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.inc_incident_timeline WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('INSERT is allowed (the only writer is the service layer)', async () => {
      const id = await seedTimelineEntry();
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.inc_incident_timeline WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // hlth_health_access_log (m23-health)
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE hlth_health_access_log', () => {
    async function seedAccessLogEntry(): Promise<string> {
      const studentId = await seedStudent();
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_health_access_log (id, school_id, accessed_by, student_id, access_type, ip_address)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'VIEW_RECORD', '192.168.1.1')`,
        id,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
        studentId,
      );
      return id;
    }

    it('UPDATE access_type → SQLSTATE 23001', async () => {
      const id = await seedAccessLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.hlth_health_access_log SET access_type = 'EXPORT' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE ip_address → SQLSTATE 23001 (tampering with audit trail)', async () => {
      const id = await seedAccessLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.hlth_health_access_log SET ip_address = '0.0.0.0' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE accessed_by → SQLSTATE 23001 (cannot reattribute access)', async () => {
      const id = await seedAccessLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.hlth_health_access_log SET accessed_by = $1::uuid WHERE id = $2::uuid`,
          TEST_OFFICER_EMPLOYEE_ID,
          id,
        ),
      );
    });

    it('DELETE → SQLSTATE 23001', async () => {
      const id = await seedAccessLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.hlth_health_access_log WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('TRUNCATE succeeds — table-level operation bypasses BEFORE ROW triggers', async () => {
      const id = await seedAccessLogEntry();
      const before = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.hlth_health_access_log WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(before[0]!.n).toBe(1);
      // TRUNCATE inside a rolled-back tx so the seed survives for the
      // next assertion in this beforeEach scope.
      await rawClient
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`);
          const empty = (await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.hlth_health_access_log WHERE id = $1::uuid`,
            id,
          )) as Array<{ n: number }>;
          expect(empty[0]!.n).toBe(0);
          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
      const after = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.hlth_health_access_log WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(after[0]!.n).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // svc_referral_activity (m27-student-services)
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE svc_referral_activity', () => {
    async function seedReferralActivityEntry(): Promise<string> {
      const studentId = await seedStudent();
      const typeId = await seedReferralType();
      const referralId = await seedReferral(studentId, typeId);
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.svc_referral_activity (id, referral_id, actor_id, activity_type, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'STATUS_CHANGE', 'Wave 3 IMMUTABLE seed')`,
        id,
        referralId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }

    it('UPDATE activity_type → SQLSTATE 23001', async () => {
      const id = await seedReferralActivityEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.svc_referral_activity SET activity_type = 'ESCALATED' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE notes → SQLSTATE 23001', async () => {
      const id = await seedReferralActivityEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.svc_referral_activity SET notes = 'tampered notes' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE actor_id → SQLSTATE 23001 (cannot reattribute action)', async () => {
      const id = await seedReferralActivityEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.svc_referral_activity SET actor_id = $1::uuid WHERE id = $2::uuid`,
          TEST_OFFICER_EMPLOYEE_ID,
          id,
        ),
      );
    });

    it('DELETE → SQLSTATE 23001', async () => {
      const id = await seedReferralActivityEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.svc_referral_activity WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('TRUNCATE succeeds — table-level operation bypasses BEFORE ROW triggers', async () => {
      const id = await seedReferralActivityEntry();
      await rawClient
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.svc_referral_activity`);
          const empty = (await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.svc_referral_activity WHERE id = $1::uuid`,
            id,
          )) as Array<{ n: number }>;
          expect(empty[0]!.n).toBe(0);
          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    });

    it('INSERT followed by 6 different activity_type enum values lands without trigger interference', async () => {
      const studentId = await seedStudent();
      const typeId = await seedReferralType();
      const referralId = await seedReferral(studentId, typeId);
      const enumValues = [
        'STATUS_CHANGE',
        'ASSIGNMENT_CHANGE',
        'NOTE_ADDED',
        'PARENT_NOTIFIED',
        'ESCALATED',
        'EXTERNAL_CONTACT_MADE',
      ];
      for (const t of enumValues) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.svc_referral_activity (id, referral_id, actor_id, activity_type)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
          generateId(),
          referralId,
          TEST_ADMIN_ACCOUNT_ID,
          t,
        );
      }
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.svc_referral_activity WHERE referral_id = $1::uuid`,
        referralId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // dpo_pseudonymisation_log — Codex review FIX 4. The table is the
  // 6th IMMUTABLE contract on the cumulative list; it's already
  // covered in `m00-platform/governance-erasure.spec.ts` but Codex
  // flagged its absence here as a contract-completeness gap (every
  // IMMUTABLE table should be visible in the immutable-contracts
  // suite for at-a-glance review). This block duplicates the Wave 2
  // assertion deliberately and locks the trigger-level contract.
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE dpo_pseudonymisation_log', () => {
    async function seedPseudonymisationLogEntry(): Promise<string> {
      // The pseudonymisation log row references dpo_erasure_requests.id
      // via FK (ON DELETE NO ACTION), so we seed a minimal erasure
      // request first.
      const erasureRequestId = generateId();
      seededErasureRequestIds.push(erasureRequestId);
      const dataSubjectId = generateId();
      // Status RECEIVED keeps us out of the dpo_erasure_completed_chk
      // multi-column lockstep — we only need a valid parent FK for
      // dpo_pseudonymisation_log to seed against.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_erasure_requests
           (id, school_id, data_subject_id, requested_by, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'RECEIVED')`,
        erasureRequestId,
        TEST_SCHOOL_ID,
        dataSubjectId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_pseudonymisation_log
           (id, school_id, erasure_request_id, data_subject_id, target_table,
            target_field, rows_pseudonymised, pseudonymisation_token,
            pseudonymised_by, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'sis_students',
                 'first_name', 1, $5, $6::uuid, 'W3 IMMUTABLE seed')`,
        id,
        TEST_SCHOOL_ID,
        erasureRequestId,
        dataSubjectId,
        'PSEUDO-TOKEN-' + id.slice(-8),
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }

    it('UPDATE target_field → SQLSTATE 23001', async () => {
      const id = await seedPseudonymisationLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.dpo_pseudonymisation_log SET target_field = 'last_name' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE rows_pseudonymised → SQLSTATE 23001 (cannot revise the audit count)', async () => {
      const id = await seedPseudonymisationLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.dpo_pseudonymisation_log SET rows_pseudonymised = 999 WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('UPDATE pseudonymisation_token → SQLSTATE 23001 (cannot rewrite the linkage token)', async () => {
      const id = await seedPseudonymisationLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.dpo_pseudonymisation_log SET pseudonymisation_token = 'TAMPERED' WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('DELETE → SQLSTATE 23001 (GDPR audit trail cannot be deleted)', async () => {
      const id = await seedPseudonymisationLogEntry();
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.dpo_pseudonymisation_log WHERE id = $1::uuid`,
          id,
        ),
      );
    });

    it('TRUNCATE succeeds — table-level operation bypasses BEFORE ROW triggers', async () => {
      const id = await seedPseudonymisationLogEntry();
      await rawClient
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.dpo_pseudonymisation_log`);
          const empty = (await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.dpo_pseudonymisation_log WHERE id = $1::uuid`,
            id,
          )) as Array<{ n: number }>;
          expect(empty[0]!.n).toBe(0);
          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    });
  });
});
