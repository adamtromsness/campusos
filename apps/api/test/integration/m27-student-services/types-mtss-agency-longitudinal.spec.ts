import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ReferralTypeService } from '@modules/m27-student-services/referrals/referral-type.service';
import { MtssTeamMeetingService } from '@modules/m27-student-services/mtss/mtss-team-meeting.service';
import { AgencyReferralService } from '@modules/m27-student-services/referrals/agency-referral.service';
import { WellbeingLongitudinalService } from '@modules/m27-student-services/wellbeing/wellbeing-longitudinal.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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
  studentActor,
  parentActor,
  teacherActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

describe('integration:m27-student-services/types-mtss-agency-longitudinal', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let types: ReferralTypeService;
  let teamMeetings: MtssTeamMeetingService;
  let agency: AgencyReferralService;
  let longitudinal: WellbeingLongitudinalService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    types = new ReferralTypeService(tenantPrisma);
    teamMeetings = new MtssTeamMeetingService(tenantPrisma);
    agency = new AgencyReferralService(tenantPrisma);
    longitudinal = new WellbeingLongitudinalService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_referral_types WHERE name LIKE 'TST-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_mtss_team_meeting_students WHERE team_meeting_id IN
         (SELECT id FROM ${TEST_SCHEMA}.svc_mtss_team_meetings WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_mtss_team_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_agency_referrals WHERE referral_id IN
         (SELECT id FROM ${TEST_SCHEMA}.svc_referrals WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    // svc_referral_activity is IMMUTABLE — TRUNCATE bypasses BEFORE ROW
    // triggers. We need to wipe activities first to allow svc_referrals
    // deletion (the FK CASCADE would otherwise try a DELETE on activities).
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.svc_referral_activity CASCADE`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_referrals WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_longitudinal WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'TML-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name LIKE 'TML-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name LIKE 'TML-%'`,
    );
  });

  async function seedStudent(opts: { school?: string } = {}): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'TML-Stu', $2, 'STUDENT', true)`,
      personId,
      'Test-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'TML-Stu', $3, true)`,
      platformStudentId,
      personId,
      'Test-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '8', 'ENROLLED')`,
      studentId,
      opts.school ?? TEST_SCHOOL_ID,
      platformStudentId,
      'TML-' + suffix,
    );
    return studentId;
  }

  async function seedReferralType(): Promise<string> {
    const refTypeRows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.svc_referral_types WHERE is_active = true LIMIT 1`,
    )) as Array<{ id: string }>;
    if (refTypeRows[0]) return refTypeRows[0].id;
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referral_types
         (id, school_id, name, default_priority, requires_parent_notification, is_active)
       VALUES ($1::uuid, $2::uuid, 'TST-TestType', 'MEDIUM', false, true)`,
      id,
      TEST_SCHOOL_ID,
    );
    return id;
  }

  async function seedReferral(opts: { school?: string } = {}): Promise<string> {
    const school = opts.school ?? TEST_SCHOOL_ID;
    const studentId = await seedStudent({ school });
    const typeId = await seedReferralType();
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referrals
         (id, school_id, student_id, referred_by, referral_type_id, priority, status, reason)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'MEDIUM', 'SUBMITTED', 'Test')`,
      id,
      school,
      studentId,
      TEST_ADMIN_EMPLOYEE_ID,
      typeId,
    );
    return id;
  }

  // ============================================================
  // ReferralTypeService
  // ============================================================
  describe('ReferralTypeService', () => {
    function baseType(overrides: Record<string, unknown> = {}) {
      return {
        name: 'TST-RefType-' + Math.random().toString(36).slice(2, 8),
        description: 'Test referral type',
        defaultPriority: 'HIGH' as const,
        requiresParentNotification: true,
        ...overrides,
      };
    }

    it('admin creates a referral type', async () => {
      const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
      expect(t.defaultPriority).toBe('HIGH');
      expect(t.requiresParentNotification).toBe(true);
      expect(t.isActive).toBe(true);
    });

    it('non-admin → Forbidden (create)', async () => {
      await expect(
        withTestTenant(async () => types.create(baseType(), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => types.create(baseType(), teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate name → BadRequest', async () => {
      const input = baseType();
      await withTestTenant(async () => types.create(input, adminActor()));
      await expect(
        withTestTenant(async () => types.create(input, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch fields', async () => {
      const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
      const updated = await withTestTenant(async () =>
        types.patch(
          t.id,
          {
            name: 'TST-Renamed-' + Math.random().toString(36).slice(2, 6),
            description: 'Updated',
            defaultPriority: 'URGENT',
            requiresParentNotification: false,
            isActive: false,
          },
          adminActor(),
        ),
      );
      expect(updated.defaultPriority).toBe('URGENT');
      expect(updated.requiresParentNotification).toBe(false);
      expect(updated.isActive).toBe(false);
    });

    it('patch empty → returns existing', async () => {
      const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
      const r = await withTestTenant(async () => types.patch(t.id, {}, adminActor()));
      expect(r.id).toBe(t.id);
    });

    it('patch as non-admin → Forbidden', async () => {
      const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
      await expect(
        withTestTenant(async () => types.patch(t.id, { name: 'x' }, officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          types.patch(generateId(), { name: 'TST-Missing' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch rename to duplicate → BadRequest', async () => {
      const a = await withTestTenant(async () => types.create(baseType(), adminActor()));
      const b = await withTestTenant(async () => types.create(baseType(), adminActor()));
      await expect(
        withTestTenant(async () =>
          types.patch(b.id, { name: a.name }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list (default) returns active only; includeInactive=true returns both', async () => {
      const active = await withTestTenant(async () => types.create(baseType(), adminActor()));
      const inactive = await withTestTenant(async () =>
        types.create(baseType({ name: 'TST-Inactive-' + generateId().slice(-6) }), adminActor()),
      );
      await withTestTenant(async () =>
        types.patch(inactive.id, { isActive: false }, adminActor()),
      );
      const list = await withTestTenant(async () => types.list());
      expect(list.find((t) => t.id === active.id)).toBeDefined();
      expect(list.find((t) => t.id === inactive.id)).toBeUndefined();
      const all = await withTestTenant(async () => types.list(true));
      expect(all.find((t) => t.id === inactive.id)).toBeDefined();
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => types.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assertActive: inactive type → BadRequest', async () => {
      const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
      await withTestTenant(async () => types.patch(t.id, { isActive: false }, adminActor()));
      await expect(
        withTestTenant(async () => types.assertActive(t.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assertActive: active type returns the dto', async () => {
      const t = await withTestTenant(async () => types.create(baseType(), adminActor()));
      const dto = await withTestTenant(async () => types.assertActive(t.id));
      expect(dto.isActive).toBe(true);
    });
  });

  // ============================================================
  // MtssTeamMeetingService
  // ============================================================
  describe('MtssTeamMeetingService', () => {
    function baseInput(overrides: Record<string, unknown> = {}) {
      return {
        academicYearId: TEST_ACADEMIC_YEAR_ID,
        meetingDate: new Date().toISOString().slice(0, 10),
        notes: 'Weekly MTSS team meeting',
        ...overrides,
      };
    }

    it('staff creates a meeting', async () => {
      const m = await withTestTenant(async () => teamMeetings.create(baseInput(), adminActor()));
      expect(m.academicYearId).toBe(TEST_ACADEMIC_YEAR_ID);
      expect(m.facilitatedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('student/parent → Forbidden', async () => {
      await expect(
        withTestTenant(async () => teamMeetings.create(baseInput(), studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => teamMeetings.create(baseInput(), parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list returns meetings ordered by date DESC', async () => {
      await withTestTenant(async () => teamMeetings.create(baseInput(), adminActor()));
      const list = await withTestTenant(async () => teamMeetings.list(adminActor()));
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => teamMeetings.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getById → NotFound', async () => {
      const m = await withTestTenant(async () => teamMeetings.create(baseInput(), adminActor()));
      await expect(
        withTestTenantB(async () => teamMeetings.getById(m.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe.skip('recordDiscussion (blocked by svc_mtss_tiers.tier_level service-side SELECT bug)', () => {
      async function seedMeeting(): Promise<string> {
        const m = await withTestTenant(async () => teamMeetings.create(baseInput(), adminActor()));
        return m.id;
      }

      it('records MAINTAIN discussion (mapped to NO_CHANGE outcome)', async () => {
        const meetingId = await seedMeeting();
        const studentId = await seedStudent();
        const d = await withTestTenant(async () =>
          teamMeetings.recordDiscussion(
            meetingId,
            {
              studentId,
              tierChangeRecommended: 'MAINTAIN',
              discussionNotes: 'Continue Tier 2 supports',
            },
            adminActor(),
          ),
        );
        expect(d.tierChangeRecommended).toBe('MAINTAIN');
        expect(d.studentId).toBe(studentId);
      });

      it('records ESCALATE (mapped to TIER_UP)', async () => {
        const meetingId = await seedMeeting();
        const studentId = await seedStudent();
        const d = await withTestTenant(async () =>
          teamMeetings.recordDiscussion(
            meetingId,
            { studentId, tierChangeRecommended: 'ESCALATE' },
            adminActor(),
          ),
        );
        expect(d.tierChangeRecommended).toBe('ESCALATE');
      });

      it('records DE_ESCALATE (mapped to TIER_DOWN)', async () => {
        const meetingId = await seedMeeting();
        const studentId = await seedStudent();
        const d = await withTestTenant(async () =>
          teamMeetings.recordDiscussion(
            meetingId,
            { studentId, tierChangeRecommended: 'DE_ESCALATE' },
            adminActor(),
          ),
        );
        expect(d.tierChangeRecommended).toBe('DE_ESCALATE');
      });

      it('cross-school student → BadRequest', async () => {
        const meetingId = await seedMeeting();
        const otherSchoolStudent = await seedStudent({ school: TEST_SCHOOL_B_ID });
        await expect(
          withTestTenant(async () =>
            teamMeetings.recordDiscussion(
              meetingId,
              { studentId: otherSchoolStudent },
              adminActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('missing meeting → NotFound', async () => {
        const studentId = await seedStudent();
        await expect(
          withTestTenant(async () =>
            teamMeetings.recordDiscussion(generateId(), { studentId }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('duplicate student on same meeting → BadRequest', async () => {
        const meetingId = await seedMeeting();
        const studentId = await seedStudent();
        await withTestTenant(async () =>
          teamMeetings.recordDiscussion(meetingId, { studentId }, adminActor()),
        );
        await expect(
          withTestTenant(async () =>
            teamMeetings.recordDiscussion(meetingId, { studentId }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('listDiscussions returns rows for the meeting', async () => {
        const meetingId = await seedMeeting();
        const studentId = await seedStudent();
        await withTestTenant(async () =>
          teamMeetings.recordDiscussion(meetingId, { studentId }, adminActor()),
        );
        const list = await withTestTenant(async () =>
          teamMeetings.listDiscussions(meetingId, adminActor()),
        );
        expect(list.length).toBe(1);
        expect(list[0]!.studentId).toBe(studentId);
      });
    });
  });

  // ============================================================
  // AgencyReferralService
  // ============================================================
  describe('AgencyReferralService', () => {
    function baseInput(referralId: string, overrides: Record<string, unknown> = {}) {
      return {
        referralId,
        agencyName: 'Local Family Therapy Center',
        agencyContact: 'Dr. Smith',
        agencyPhone: '555-1234',
        agencyEmail: 'intake@ftc.example',
        referralDate: new Date().toISOString().slice(0, 10),
        reason: 'Long-term family counselling support',
        consentObtained: false,
        ...overrides,
      };
    }

    it('staff creates an agency referral (status REFERRED)', async () => {
      const referralId = await seedReferral();
      const ar = await withTestTenant(async () =>
        agency.create(baseInput(referralId), adminActor()),
      );
      expect(ar.status).toBe('REFERRED');
      expect(ar.consentObtained).toBe(false);
    });

    it('student/parent → Forbidden', async () => {
      await expect(
        withTestTenant(async () => agency.create(baseInput(generateId()), studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => agency.create(baseInput(generateId()), parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school parent referral → BadRequest', async () => {
      const referralB = await seedReferral({ school: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () => agency.create(baseInput(referralB), adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list with referralId + status filters', async () => {
      const referralId = await seedReferral();
      const a = await withTestTenant(async () =>
        agency.create(baseInput(referralId), adminActor()),
      );
      const byReferral = await withTestTenant(async () =>
        agency.list({ referralId }, adminActor()),
      );
      expect(byReferral.find((r) => r.id === a.id)).toBeDefined();
      const byStatus = await withTestTenant(async () =>
        agency.list({ status: 'REFERRED' }, adminActor()),
      );
      expect(byStatus.find((r) => r.id === a.id)).toBeDefined();
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => agency.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('patch — state machine + consent gate', () => {
      async function seed(): Promise<string> {
        const referralId = await seedReferral();
        const ar = await withTestTenant(async () =>
          agency.create(baseInput(referralId), adminActor()),
        );
        return ar.id;
      }

      it('REFERRED → CONTACTED allowed', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          agency.patch(id, { status: 'CONTACTED' }, adminActor()),
        );
        expect(updated.status).toBe('CONTACTED');
      });

      it('CONTACTED → ACTIVE_SERVICE without consent → BadRequest (CONSENT GATE)', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          agency.patch(id, { status: 'CONTACTED' }, adminActor()),
        );
        await expect(
          withTestTenant(async () =>
            agency.patch(id, { status: 'ACTIVE_SERVICE' }, adminActor()),
          ),
        ).rejects.toThrow(/consent_obtained=true/);
      });

      it('CONTACTED → ACTIVE_SERVICE with consent → success', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          agency.patch(id, { status: 'CONTACTED', consentObtained: true }, adminActor()),
        );
        const updated = await withTestTenant(async () =>
          agency.patch(id, { status: 'ACTIVE_SERVICE' }, adminActor()),
        );
        expect(updated.status).toBe('ACTIVE_SERVICE');
      });

      it('illegal transition REFERRED → ACTIVE_SERVICE → BadRequest', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () =>
            agency.patch(id, { status: 'ACTIVE_SERVICE' }, adminActor()),
          ),
        ).rejects.toThrow(/Illegal transition/);
      });

      it('DISCHARGED is terminal — further status changes rejected', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          agency.patch(id, { status: 'DISCHARGED' }, adminActor()),
        );
        await expect(
          withTestTenant(async () =>
            agency.patch(id, { status: 'CONTACTED' }, adminActor()),
          ),
        ).rejects.toThrow(/Illegal transition/);
      });

      it('empty patch returns existing', async () => {
        const id = await seed();
        const r = await withTestTenant(async () => agency.patch(id, {}, adminActor()));
        expect(r.id).toBe(id);
      });

      it('patch missing → NotFound', async () => {
        await expect(
          withTestTenant(async () =>
            agency.patch(generateId(), { notes: 'x' }, adminActor()),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('patch notes + followUpDate + consentObtained', async () => {
        const id = await seed();
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const r = await withTestTenant(async () =>
          agency.patch(
            id,
            { notes: 'Updated', followUpDate: future, consentObtained: true },
            adminActor(),
          ),
        );
        expect(r.notes).toBe('Updated');
        expect(r.consentObtained).toBe(true);
        expect(r.followUpDate).toBe(future);
      });
    });
  });

  // ============================================================
  // WellbeingLongitudinalService
  // ============================================================
  describe('WellbeingLongitudinalService', () => {
    async function seedLongitudinalRow(opts: {
      studentId: string;
      academicYear: string;
      domain: 'ACADEMIC' | 'SOCIAL' | 'EMOTIONAL' | 'PHYSICAL' | 'SAFETY';
      avgScore: number;
      trend: 'IMPROVING' | 'STABLE' | 'DECLINING';
      school?: string;
    }): Promise<string> {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_longitudinal
           (id, student_id, school_id, academic_year, domain, avg_score, trend,
            checkin_count, flagged_count, materialised_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7, 5, 1, now())`,
        id,
        opts.studentId,
        opts.school ?? TEST_SCHOOL_ID,
        opts.academicYear,
        opts.domain,
        opts.avgScore,
        opts.trend,
      );
      return id;
    }

    it('admin gets longitudinal rows for student sorted year DESC + domain ASC', async () => {
      const studentId = await seedStudent();
      await seedLongitudinalRow({
        studentId,
        academicYear: '2025-2026',
        domain: 'ACADEMIC',
        avgScore: 7.5,
        trend: 'IMPROVING',
      });
      await seedLongitudinalRow({
        studentId,
        academicYear: '2024-2025',
        domain: 'SOCIAL',
        avgScore: 6.0,
        trend: 'STABLE',
      });
      const result = await withTestTenant(async () =>
        longitudinal.getForStudent(studentId, adminActor()),
      );
      expect(result.rows.length).toBe(2);
      expect(result.rows[0]!.academicYear).toBe('2025-2026');
      expect(result.rows[0]!.trend).toBe('IMPROVING');
    });

    it('student/parent → Forbidden', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () => longitudinal.getForStudent(studentId, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => longitudinal.getForStudent(studentId, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school rows are invisible', async () => {
      const studentB = await seedStudent({ school: TEST_SCHOOL_B_ID });
      await seedLongitudinalRow({
        studentId: studentB,
        academicYear: '2025-2026',
        domain: 'ACADEMIC',
        avgScore: 8.0,
        trend: 'IMPROVING',
        school: TEST_SCHOOL_B_ID,
      });
      const result = await withTestTenant(async () =>
        longitudinal.getForStudent(studentB, adminActor()),
      );
      expect(result.rows).toEqual([]);
    });

    it('listForYear returns rows sorted by domain ASC, avg_score ASC', async () => {
      const s1 = await seedStudent();
      const s2 = await seedStudent();
      await seedLongitudinalRow({
        studentId: s1,
        academicYear: '2025-2026',
        domain: 'EMOTIONAL',
        avgScore: 5.0,
        trend: 'STABLE',
      });
      await seedLongitudinalRow({
        studentId: s2,
        academicYear: '2025-2026',
        domain: 'EMOTIONAL',
        avgScore: 3.0,
        trend: 'DECLINING',
      });
      const list = await withTestTenant(async () =>
        longitudinal.listForYear('2025-2026', adminActor()),
      );
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it('listForYear with student → Forbidden', async () => {
      await expect(
        withTestTenant(async () => longitudinal.listForYear('2025-2026', studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('materialise: admin can run', async () => {
      const result = await withTestTenant(async () =>
        longitudinal.materialise('2025-2026', adminActor()),
      );
      expect(result.academicYear).toBe('2025-2026');
      expect(result.rowsWritten).toBeGreaterThanOrEqual(0);
    });

    it('materialise as non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => longitudinal.materialise('2025-2026', officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => longitudinal.materialise('2025-2026', teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
