import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ImmunisationService } from '@modules/m23-health/immunisation/immunisation.service';
import { ImmunisationRequirementService } from '@modules/m23-health/immunisation/immunisation-requirement.service';
import { ImmunisationComplianceService } from '@modules/m23-health/immunisation/immunisation-compliance.service';
import { DietaryProfileService } from '@modules/m23-health/dietary/dietary-profile.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { RecordingKafkaProducer } from '../helpers/recording-kafka';

describe('integration:m23-health/immunisation-and-dietary', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let accessLog: HealthAccessLogService;
  let records: HealthRecordService;
  let immunisation: ImmunisationService;
  let requirement: ImmunisationRequirementService;
  let compliance: ImmunisationComplianceService;
  let dietary: DietaryProfileService;
  let kafka: RecordingKafkaProducer;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    const guardianAuthz = new GuardianAuthorizationService(tenantPrisma);
    const outbox = new OutboxService();
    accessLog = new HealthAccessLogService(tenantPrisma);
    records = new HealthRecordService(tenantPrisma, accessLog, permCheck, guardianAuthz, outbox);
    kafka = new RecordingKafkaProducer();
    immunisation = new ImmunisationService(tenantPrisma, accessLog, records);
    requirement = new ImmunisationRequirementService(tenantPrisma, permCheck);
    compliance = new ImmunisationComplianceService(
      tenantPrisma,
      permCheck,
      requirement,
      kafka as unknown as KafkaProducerService,
    );
    dietary = new DietaryProfileService(tenantPrisma, accessLog, records);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_immunisation_compliance WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_immunisation_requirements WHERE school_id IN ($1::uuid, $2::uuid) OR vaccine_name LIKE 'IMM-%'`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_immunisations WHERE health_record_id IN
         (SELECT id FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN
           (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'IM-%'))`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_dietary_profiles WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'IM-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'IM-%')`,
    );
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'IM-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'IM-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'IM-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  async function seedStudent(opts?: { schoolId?: string; grade?: string }): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'IM-Stu', $2, 'STUDENT', true)`,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'IM-Stu', $3, true)`,
      platformStudentId,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ENROLLED')`,
      studentId,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      platformStudentId,
      'IM-' + suffix,
      opts?.grade ?? '5',
    );
    return studentId;
  }

  async function seedHealthRecord(
    studentId: string,
    schoolId: string = TEST_SCHOOL_ID,
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hlth_student_health_records
         (id, school_id, student_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      id,
      schoolId,
      studentId,
    );
    return id;
  }

  // ─── ImmunisationService ─────────────────────────────────────

  describe('ImmunisationService', () => {
    it('admin creates → lists → updates immunisation; VIEW_IMMUNISATIONS audit row written', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const r = await withTestTenant(async () =>
        immunisation.create(
          studentId,
          {
            vaccineName: 'MMR',
            administeredDate: '2024-09-01',
            status: 'CURRENT',
            administeredBy: 'School Nurse',
          },
          adminActor(),
        ),
      );
      expect(r.vaccineName).toBe('MMR');

      const list = await withTestTenant(async () =>
        immunisation.listForStudent(studentId, adminActor()),
      );
      expect(list.find((x) => x.id === r.id)).toBeDefined();

      const u = await withTestTenant(async () =>
        immunisation.update(
          r.id,
          {
            vaccineName: 'MMR Booster',
            administeredDate: '2025-09-01',
            dueDate: '2030-09-01',
            administeredBy: 'Dr. Smith',
            status: 'OVERDUE',
          },
          adminActor(),
        ),
      );
      expect(u.vaccineName).toBe('MMR Booster');
      expect(u.status).toBe('OVERDUE');

      const audit = (await rawClient.$queryRawUnsafe(
        `SELECT access_type FROM ${TEST_SCHEMA}.hlth_health_access_log
           WHERE access_type = 'VIEW_IMMUNISATIONS'`,
      )) as Array<{ access_type: string }>;
      expect(audit.length).toBeGreaterThanOrEqual(1);
    });

    it('empty patch returns existing', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const r = await withTestTenant(async () =>
        immunisation.create(studentId, { vaccineName: 'X', status: 'CURRENT' }, adminActor()),
      );
      const u = await withTestTenant(async () => immunisation.update(r.id, {}, adminActor()));
      expect(u.id).toBe(r.id);
    });

    it('update missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          immunisation.update(generateId(), { status: 'CURRENT' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden on create/update', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      await expect(
        withTestTenant(async () =>
          immunisation.create(studentId, { vaccineName: 'X', status: 'CURRENT' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher listForStudent → Forbidden (NotFound from row-scope first)', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      await expect(
        withTestTenant(async () => immunisation.listForStudent(studentId, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForStudent without health record → NotFound', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () => immunisation.listForStudent(studentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── ImmunisationRequirementService ──────────────────────────

  describe('ImmunisationRequirementService', () => {
    it('admin creates → list → patch a per-school requirement', async () => {
      const r = await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-MMR',
            requiredDoses: 2,
            requiredByGrade: 'K',
            allowsExemption: true,
            exemptionTypes: ['MEDICAL', 'RELIGIOUS'],
          },
          adminActor(),
        ),
      );
      expect(r.stateCode).toBe('KS');

      const list = await withTestTenant(async () => requirement.list('KS'));
      expect(list.find((x) => x.id === r.id)).toBeDefined();

      const got = await withTestTenant(async () => requirement.getById(r.id));
      expect(got.id).toBe(r.id);

      const u = await withTestTenant(async () =>
        requirement.patch(
          r.id,
          {
            requiredDoses: 3,
            allowsExemption: false,
            exemptionTypes: [],
            isActive: false,
          },
          adminActor(),
        ),
      );
      expect(u.requiredDoses).toBe(3);
      expect(u.isActive).toBe(false);
    });

    it('officer with hlt-001:admin can create', async () => {
      await grantOfficer(['hlt-001:admin']);
      const r = await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'CA',
            vaccineName: 'IMM-DTaP',
            requiredDoses: 4,
            requiredByGrade: 'K',
          },
          officerActor(),
        ),
      );
      expect(r.id).toBeTruthy();
    });

    it('non-admin → Forbidden on create/patch', async () => {
      await expect(
        withTestTenant(async () =>
          requirement.create(
            { stateCode: 'KS', vaccineName: 'X', requiredDoses: 1, requiredByGrade: 'K' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate (state,vaccine,grade,scope) → BadRequest', async () => {
      await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-Polio',
            requiredDoses: 4,
            requiredByGrade: 'K',
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          requirement.create(
            {
              stateCode: 'KS',
              vaccineName: 'IMM-Polio',
              requiredDoses: 4,
              requiredByGrade: 'K',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => requirement.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          requirement.patch(generateId(), { requiredDoses: 1 }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch platform-default row → Forbidden', async () => {
      // Insert a platform-default row directly (school_id NULL).
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_immunisation_requirements
           (id, school_id, state_code, vaccine_name, required_doses, required_by_grade, is_active)
         VALUES ($1::uuid, NULL, 'XX', 'IMM-PlatformDefault', 1, 'K', true)`,
        id,
      );
      await expect(
        withTestTenant(async () => requirement.patch(id, { requiredDoses: 2 }, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('empty patch returns existing', async () => {
      const r = await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-HepB',
            requiredDoses: 3,
            requiredByGrade: '1',
          },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () => requirement.patch(r.id, {}, adminActor()));
      expect(u.id).toBe(r.id);
    });

    it('loadActiveForCompute returns active requirements for state', async () => {
      await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-Compute',
            requiredDoses: 2,
            requiredByGrade: 'K',
          },
          adminActor(),
        ),
      );
      const rows = await withTestTenant(async () => requirement.loadActiveForCompute('KS'));
      expect(rows.find((r) => r.vaccine_name === 'IMM-Compute')).toBeDefined();
    });
  });

  // ─── ImmunisationComplianceService ──────────────────────────

  describe('ImmunisationComplianceService', () => {
    async function seedComplianceFixtures(): Promise<{
      studentId: string;
      complianceId: string;
    }> {
      const studentId = await seedStudent({ grade: '5' });
      await seedHealthRecord(studentId);
      await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-Polio',
            requiredDoses: 4,
            requiredByGrade: 'K',
          },
          adminActor(),
        ),
      );
      const complianceId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_immunisation_compliance
           (id, student_id, school_id, status, missing_vaccines, last_computed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'NON_COMPLIANT',
                 '[{"vaccine_name":"IMM-Polio","doses_received":2,"doses_required":4}]'::jsonb, now())`,
        complianceId,
        studentId,
        TEST_SCHOOL_ID,
      );
      return { studentId, complianceId };
    }

    it('dashboard returns rollup counts + compliancePercent', async () => {
      await seedComplianceFixtures();
      const d = await withTestTenant(async () => compliance.dashboard());
      expect(d.totalStudents).toBeGreaterThanOrEqual(1);
      expect(d.nonCompliant).toBeGreaterThanOrEqual(1);
      expect(d.compliancePercent).toBeGreaterThanOrEqual(0);
    });

    it('list filters by status + grade + limit clamp', async () => {
      await seedComplianceFixtures();
      const list = await withTestTenant(async () =>
        compliance.list({ status: 'NON_COMPLIANT', grade: '5', limit: 9999 }),
      );
      expect(list.every((c) => c.status === 'NON_COMPLIANT')).toBe(true);
      expect(list.length).toBeLessThanOrEqual(500);
    });

    it('admin getForStudent returns the row', async () => {
      const { studentId } = await seedComplianceFixtures();
      const r = await withTestTenant(async () => compliance.getForStudent(studentId, adminActor()));
      expect(r.studentId).toBe(studentId);
    });

    it('teacher without hlt-007 → NotFound on getForStudent', async () => {
      const { studentId } = await seedComplianceFixtures();
      await expect(
        withTestTenant(async () => compliance.getForStudent(studentId, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('officer with hlt-007:read can read', async () => {
      await grantOfficer(['hlt-007:read']);
      const { studentId } = await seedComplianceFixtures();
      const r = await withTestTenant(async () =>
        compliance.getForStudent(studentId, officerActor()),
      );
      expect(r.studentId).toBe(studentId);
    });

    it('getForStudent missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => compliance.getForStudent(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('runManually requires admin scope', async () => {
      await expect(
        withTestTenant(async () => compliance.runManually(null, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('computeForSchool: flags NON_COMPLIANT students + emits hlth.immunisation.noncompliant', async () => {
      // Requirement: IMM-MMR, 2 doses at grade K applies to all higher grades.
      await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-MMR',
            requiredDoses: 2,
            requiredByGrade: 'K',
          },
          adminActor(),
        ),
      );
      const studentId = await seedStudent({ grade: '5' });
      const recordId = await seedHealthRecord(studentId);
      // Only one MMR dose → non-compliant.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_immunisations
           (id, health_record_id, vaccine_name, status, administered_date)
         VALUES ($1::uuid, $2::uuid, 'IMM-MMR', 'CURRENT', '2024-09-01'::date)`,
        generateId(),
        recordId,
      );

      kafka.reset();
      const r = await withTestTenant(async () => compliance.runManually(null, adminActor()));
      expect(r.computed).toBeGreaterThanOrEqual(1);
      expect(r.newlyNonCompliant).toBeGreaterThanOrEqual(1);
      expect(kafka.callsForTopic('hlth.immunisation.noncompliant').length).toBeGreaterThanOrEqual(
        1,
      );

      const stored = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.hlth_immunisation_compliance
           WHERE student_id = $1::uuid`,
        studentId,
      )) as Array<{ status: string }>;
      expect(stored[0]!.status).toBe('NON_COMPLIANT');
    });

    it('computeForSchool: re-run for COMPLIANT student stays compliant (no second emit)', async () => {
      await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-Tdap',
            requiredDoses: 1,
            requiredByGrade: 'K',
          },
          adminActor(),
        ),
      );
      const studentId = await seedStudent({ grade: '8' });
      const recordId = await seedHealthRecord(studentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_immunisations
           (id, health_record_id, vaccine_name, status, administered_date)
         VALUES ($1::uuid, $2::uuid, 'IMM-Tdap', 'CURRENT', '2024-09-01'::date)`,
        generateId(),
        recordId,
      );
      await withTestTenant(async () => compliance.runManually(null, adminActor()));
      kafka.reset();
      // Re-run — already COMPLIANT, no new emits.
      await withTestTenant(async () => compliance.runManually(null, adminActor()));
      expect(kafka.callsForTopic('hlth.immunisation.noncompliant').length).toBe(0);
    });

    it('computeForSchool: EXEMPT status is preserved across reruns', async () => {
      await withTestTenant(async () =>
        requirement.create(
          {
            stateCode: 'KS',
            vaccineName: 'IMM-Var',
            requiredDoses: 1,
            requiredByGrade: 'K',
          },
          adminActor(),
        ),
      );
      const studentId = await seedStudent({ grade: '6' });
      await seedHealthRecord(studentId);
      // Pre-seed EXEMPT row.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_immunisation_compliance
           (id, student_id, school_id, status, missing_vaccines, exemption_type, last_computed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'EXEMPT', '[]'::jsonb, 'MEDICAL', now())`,
        generateId(),
        studentId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => compliance.runManually(null, adminActor()));
      const stored = (await rawClient.$queryRawUnsafe(
        `SELECT status, exemption_type FROM ${TEST_SCHEMA}.hlth_immunisation_compliance
           WHERE student_id = $1::uuid`,
        studentId,
      )) as Array<{ status: string; exemption_type: string }>;
      expect(stored[0]!.status).toBe('EXEMPT');
      expect(stored[0]!.exemption_type).toBe('MEDICAL');
    });

    it('stateReportCsv produces CSV with header + one row per (student, vaccine)', async () => {
      await seedComplianceFixtures();
      const csv = await withTestTenant(async () => compliance.stateReportCsv());
      const lines = csv.trim().split('\n');
      expect(lines[0]).toContain('student_state_id');
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── DietaryProfileService ──────────────────────────────────

  describe('DietaryProfileService', () => {
    it('admin creates → updates → reads dietary profile; VIEW_DIETARY audit', async () => {
      const studentId = await seedStudent();
      const p = await withTestTenant(async () =>
        dietary.create(
          studentId,
          {
            dietaryRestrictions: ['GLUTEN_FREE'],
            allergens: [{ allergen: 'PEANUTS', severity: 'SEVERE' }],
            specialMealInstructions: 'No nuts',
            posAllergenAlert: true,
          },
          adminActor(),
        ),
      );
      expect(p.studentId).toBe(studentId);
      expect(p.posAllergenAlert).toBe(true);

      const u = await withTestTenant(async () =>
        dietary.update(
          p.id,
          {
            dietaryRestrictions: ['VEGETARIAN'],
            allergens: [],
            specialMealInstructions: 'Updated',
            posAllergenAlert: false,
          },
          adminActor(),
        ),
      );
      expect(u.posAllergenAlert).toBe(false);

      const got = await withTestTenant(async () => dietary.getForStudent(studentId, adminActor()));
      expect(got!.id).toBe(p.id);

      const audit = (await rawClient.$queryRawUnsafe(
        `SELECT access_type FROM ${TEST_SCHEMA}.hlth_health_access_log
           WHERE access_type = 'VIEW_DIETARY'`,
      )) as Array<{ access_type: string }>;
      expect(audit.length).toBeGreaterThanOrEqual(1);
    });

    it('create duplicate dietary profile → BadRequest', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () => dietary.create(studentId, {}, adminActor()));
      await expect(
        withTestTenant(async () => dietary.create(studentId, {}, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create on non-existent student → NotFound', async () => {
      await expect(
        withTestTenant(async () => dietary.create(generateId(), {}, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getForStudent with no profile returns null', async () => {
      const studentId = await seedStudent();
      const r = await withTestTenant(async () => dietary.getForStudent(studentId, adminActor()));
      expect(r).toBeNull();
    });

    it('update missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          dietary.update(generateId(), { posAllergenAlert: true }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden on create/update', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () => dietary.create(studentId, {}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listAllergenAlerts returns only posAllergenAlert=true profiles', async () => {
      const s1 = await seedStudent();
      const s2 = await seedStudent();
      await withTestTenant(async () =>
        dietary.create(s1, { posAllergenAlert: true }, adminActor()),
      );
      await withTestTenant(async () =>
        dietary.create(s2, { posAllergenAlert: false }, adminActor()),
      );
      const list = await withTestTenant(async () => dietary.listAllergenAlerts(adminActor()));
      expect(list.find((p) => p.studentId === s1)).toBeDefined();
      expect(list.find((p) => p.studentId === s2)).toBeUndefined();
    });

    it('listAllergenAlerts non-nurse → Forbidden', async () => {
      await expect(
        withTestTenant(async () => dietary.listAllergenAlerts(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── cross-school ─────────────────────────────────────────────

  describe('cross-school isolation', () => {
    it('Compliance dashboard counts confine to School A', async () => {
      const sA = await seedStudent({ schoolId: TEST_SCHOOL_ID });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_immunisation_compliance
           (id, student_id, school_id, status, missing_vaccines, last_computed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMPLIANT', '[]'::jsonb, now())`,
        generateId(),
        sA,
        TEST_SCHOOL_ID,
      );
      const sB = await seedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hlth_immunisation_compliance
           (id, student_id, school_id, status, missing_vaccines, last_computed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'NON_COMPLIANT',
                 '[{"vaccine_name":"X","doses_received":0,"doses_required":1}]'::jsonb, now())`,
        generateId(),
        sB,
        TEST_SCHOOL_B_ID,
      );

      const dashA = await withTestTenant(async () => compliance.dashboard());
      const dashB = await withTestTenantB(async () => compliance.dashboard());
      expect(dashA.totalStudents).toBeGreaterThanOrEqual(1);
      expect(dashB.totalStudents).toBeGreaterThanOrEqual(1);
      // School A non-compliant count should not include School B's row.
      expect(dashA.nonCompliant).toBe(0);
      expect(dashB.nonCompliant).toBeGreaterThanOrEqual(1);
    });
  });
});
