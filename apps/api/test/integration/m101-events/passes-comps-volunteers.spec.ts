import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  SeasonPassService,
  CompListService,
  VolunteerService,
} from '@modules/m101-events/gate.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  teacherActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_PERSON_ID,
} from '../helpers/actor';
import { resetEventsTables } from '../fixtures/events';
import { seedStudent, cleanupSeededIds } from '../m20-sis/sis-helpers';

describe('integration:m101-events/passes-comps-volunteers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let passes: SeasonPassService;
  let comps: CompListService;
  let vols: VolunteerService;

  const studentIds: string[] = [];
  const platformStudentIds: string[] = [];
  const personIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    passes = new SeasonPassService(tenantPrisma, permCheck);
    comps = new CompListService(tenantPrisma, permCheck);
    vols = new VolunteerService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEventsTables(rawClient);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  async function seedEventDirect(
    opts: {
      schoolId?: string;
      eventType?: string;
      status?: 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'COMPLETED' | 'CANCELLED';
      eventDate?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.evt_events
         (id, school_id, title, event_type, event_date, start_time, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'Pass Event', $3, $4::date, '19:00', $5, $6::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.eventType ?? 'ATHLETIC_GAME',
      opts.eventDate ?? '2025-10-15',
      opts.status ?? 'ON_SALE',
      TEST_ADMIN_PERSON_ID,
    );
    return id;
  }

  // ─── SeasonPassService ───
  describe('SeasonPassService', () => {
    it('admin creates pass for another person', async () => {
      const pass = await withTestTenant(async () =>
        passes.create(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'All Sports',
            price: 100,
            academicYear: '2025-2026',
            notes: 'comp',
          } as any,
          adminActor(),
        ),
      );
      expect(pass.status).toBe('ACTIVE');
      expect(pass.passType).toBe('All Sports');
      expect(pass.personId).toBe(TEST_PARENT_PERSON_ID);
    });

    it('non-admin can purchase for self', async () => {
      const pass = await withTestTenant(async () =>
        passes.create(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'All Sports',
            price: 50,
            academicYear: '2025-2026',
          } as any,
          parentActor(),
        ),
      );
      expect(pass.personId).toBe(TEST_PARENT_PERSON_ID);
    });

    it('non-admin trying to buy for another person → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_STUDENT_PERSON_ID,
              passType: 'X',
              price: 5,
              academicYear: '2025-2026',
            } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForActor writer sees all', async () => {
      await withTestTenant(async () =>
        passes.create(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'X',
            price: 5,
            academicYear: '2025-2026',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => passes.listForActor(adminActor()));
      expect(list.length).toBe(1);
    });

    it('listForActor non-writer scoped to self', async () => {
      await withTestTenant(async () =>
        passes.create(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'X',
            price: 5,
            academicYear: '2025-2026',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => passes.listForActor(parentActor()));
      expect(list.length).toBe(1);
      expect(list[0]!.personId).toBe(TEST_PARENT_PERSON_ID);
    });

    it('revoke flips ACTIVE → REVOKED', async () => {
      const pass = await withTestTenant(async () =>
        passes.create(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'X',
            price: 5,
            academicYear: '2025-2026',
          } as any,
          adminActor(),
        ),
      );
      const revoked = await withTestTenant(async () => passes.revoke(pass.id, adminActor()));
      expect(revoked.status).toBe('REVOKED');
    });

    it('revoke twice → BadRequestException', async () => {
      const pass = await withTestTenant(async () =>
        passes.create(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'X',
            price: 5,
            academicYear: '2025-2026',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => passes.revoke(pass.id, adminActor()));
      await expect(
        withTestTenant(async () => passes.revoke(pass.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin cannot revoke → ForbiddenException', async () => {
      const pass = await withTestTenant(async () =>
        passes.create(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'X',
            price: 5,
            academicYear: '2025-2026',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => passes.revoke(pass.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // ─── SeasonPass gateCheck ───
    describe('gateCheck', () => {
      it('events_included list match → admitted', async () => {
        const eventId = await seedEventDirect({ eventDate: '2025-10-15' });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'Custom',
              price: 10,
              academicYear: '2025-2026',
              eventsIncluded: [eventId],
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(true);
      });

      it('events_included list missing event → denied', async () => {
        const eventId = await seedEventDirect({ eventDate: '2025-10-15' });
        const otherEvent = await seedEventDirect({ eventDate: '2025-11-01' });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'Custom',
              price: 10,
              academicYear: '2025-2026',
              eventsIncluded: [otherEvent],
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(false);
        expect(result.reason).toMatch(/coverage list/i);
      });

      it('pass_type "All Sports" admits ATHLETIC_GAME by coverage', async () => {
        const eventId = await seedEventDirect({
          eventType: 'ATHLETIC_GAME',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'All Sports',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(true);
      });

      it('pass_type "Theatre Season" admits PERFORMANCE', async () => {
        const eventId = await seedEventDirect({
          eventType: 'PERFORMANCE',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'Theatre Season',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(true);
      });

      it('pass_type "All Events Pass" admits any event_type', async () => {
        const eventId = await seedEventDirect({
          eventType: 'DANCE',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'All Events Pass',
              price: 50,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(true);
      });

      it('DANCE-typed pass admits DANCE', async () => {
        const eventId = await seedEventDirect({
          eventType: 'DANCE',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'Dance Pass',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(true);
      });

      it('FUNDRAISER-typed pass admits FUNDRAISER', async () => {
        const eventId = await seedEventDirect({
          eventType: 'FUNDRAISER',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'Fundraiser Season',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(true);
      });

      it('literal pass_type match (uppercase equals event_type)', async () => {
        const eventId = await seedEventDirect({
          eventType: 'GRADUATION',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'GRADUATION',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(true);
      });

      it('event date outside academic year window → denied', async () => {
        const eventId = await seedEventDirect({
          eventType: 'ATHLETIC_GAME',
          eventDate: '2024-05-01', // way before 2025-2026
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'All Sports',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(false);
        expect(result.reason).toMatch(/window/i);
      });

      it('unknown pass_type → denied (deny-unless-matching)', async () => {
        const eventId = await seedEventDirect({
          eventType: 'PERFORMANCE',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'Mystery',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(false);
      });

      it('REVOKED pass → denied', async () => {
        const eventId = await seedEventDirect({ eventDate: '2025-10-15' });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'All Sports',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        await withTestTenant(async () => passes.revoke(pass.id, adminActor()));
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(false);
        expect(result.reason).toMatch(/REVOKED/);
      });

      it('missing pass → denied', async () => {
        const eventId = await seedEventDirect({ eventDate: '2025-10-15' });
        const result = await withTestTenant(async () =>
          passes.gateCheck(
            { passId: '00000000-0000-0000-0000-000000000000', eventId } as any,
            adminActor(),
          ),
        );
        expect(result.admitted).toBe(false);
        expect(result.reason).toMatch(/not found/i);
      });

      it('missing event → denied', async () => {
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'All Sports',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck(
            { passId: pass.id, eventId: '00000000-0000-0000-0000-000000000000' } as any,
            adminActor(),
          ),
        );
        expect(result.admitted).toBe(false);
      });

      it('DRAFT event → denied', async () => {
        const eventId = await seedEventDirect({
          eventType: 'PERFORMANCE',
          status: 'DRAFT',
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'Theatre',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(false);
      });

      it('non-writer gate check → ForbiddenException', async () => {
        const eventId = await seedEventDirect({ eventDate: '2025-10-15' });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'All Sports',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        await expect(
          withTestTenant(async () =>
            passes.gateCheck({ passId: pass.id, eventId } as any, parentActor()),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('malformed academic_year → denied', async () => {
        const eventId = await seedEventDirect({
          eventType: 'PERFORMANCE',
          eventDate: '2025-10-15',
        });
        // Bypass class-validator by inserting directly
        const passId = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.evt_season_passes
             (id, school_id, person_id, pass_type, price, status, academic_year, purchased_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Theatre', 10, 'ACTIVE', 'invalid', now())`,
          passId,
          TEST_SCHOOL_ID,
          TEST_PARENT_PERSON_ID,
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId, eventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(false);
        expect(result.reason).toMatch(/malformed/);
      });

      it('cross-school: School A pass cannot admit School B event', async () => {
        const bEventId = await seedEventDirect({
          schoolId: TEST_SCHOOL_B_ID,
          eventDate: '2025-10-15',
        });
        const pass = await withTestTenant(async () =>
          passes.create(
            {
              personId: TEST_PARENT_PERSON_ID,
              passType: 'All Sports',
              price: 10,
              academicYear: '2025-2026',
            } as any,
            adminActor(),
          ),
        );
        const result = await withTestTenant(async () =>
          passes.gateCheck({ passId: pass.id, eventId: bEventId } as any, adminActor()),
        );
        expect(result.admitted).toBe(false);
      });
    });
  });

  // ─── CompListService ───
  describe('CompListService', () => {
    it('add STAFF comp using admin employee row', async () => {
      const eventId = await seedEventDirect();
      const entry = await withTestTenant(async () =>
        comps.add(
          eventId,
          {
            compType: 'STAFF',
            personId: TEST_ADMIN_PERSON_ID,
          } as any,
          adminActor(),
        ),
      );
      expect(entry.compType).toBe('STAFF');
      expect(entry.personId).toBe(TEST_ADMIN_PERSON_ID);
    });

    it('add COACH comp using teacher employee', async () => {
      const eventId = await seedEventDirect();
      const entry = await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'COACH', personId: TEST_TEACHER_PERSON_ID } as any,
          adminActor(),
        ),
      );
      expect(entry.compType).toBe('COACH');
    });

    it('add STUDENT comp using sis_students projection', async () => {
      const eventId = await seedEventDirect();
      const student = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_ID });
      personIds.push(student.personId);
      platformStudentIds.push(student.platformStudentId);
      studentIds.push(student.studentId);
      const entry = await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'STUDENT', personId: student.personId } as any,
          adminActor(),
        ),
      );
      expect(entry.compType).toBe('STUDENT');
    });

    it('add ATHLETE comp using sis_students projection', async () => {
      const eventId = await seedEventDirect();
      const student = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_ID });
      personIds.push(student.personId);
      platformStudentIds.push(student.platformStudentId);
      studentIds.push(student.studentId);
      const entry = await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'ATHLETE', personId: student.personId } as any,
          adminActor(),
        ),
      );
      expect(entry.compType).toBe('ATHLETE');
    });

    it('add OFFICIAL comp using platform_official_profiles', async () => {
      const eventId = await seedEventDirect();
      const personId = generateId();
      personIds.push(personId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Ref', 'X', 'STAFF', true)`,
        personId,
      );
      const profileId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_official_profiles
           (id, person_id, sports, certification_level, base_fee, is_available)
         VALUES ($1::uuid, $2::uuid, ARRAY['Soccer']::text[], 'STATE', 50.00, true)`,
        profileId,
        personId,
      );
      const entry = await withTestTenant(async () =>
        comps.add(eventId, { compType: 'OFFICIAL', personId } as any, adminActor()),
      );
      expect(entry.compType).toBe('OFFICIAL');
      // Cleanup the platform_official_profiles row directly
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_official_profiles WHERE id = $1::uuid`,
        profileId,
      );
    });

    it('add VIP / MEDIA / OTHER comp requires tenant footprint', async () => {
      const eventId = await seedEventDirect();
      // Admin person has hr_employees row in School A — should pass
      const entry = await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'VIP', personId: TEST_ADMIN_PERSON_ID, notes: 'donor' } as any,
          adminActor(),
        ),
      );
      expect(entry.compType).toBe('VIP');
    });

    it('add MEDIA without tenant footprint → BadRequestException', async () => {
      const eventId = await seedEventDirect();
      const orphanPersonId = generateId();
      personIds.push(orphanPersonId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Orphan', 'P', 'STAFF', true)`,
        orphanPersonId,
      );
      await expect(
        withTestTenant(async () =>
          comps.add(eventId, { compType: 'MEDIA', personId: orphanPersonId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('add STAFF for non-employee → BadRequestException', async () => {
      const eventId = await seedEventDirect();
      const orphanPersonId = generateId();
      personIds.push(orphanPersonId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Orphan', 'Q', 'STAFF', true)`,
        orphanPersonId,
      );
      await expect(
        withTestTenant(async () =>
          comps.add(eventId, { compType: 'STAFF', personId: orphanPersonId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('add STUDENT for non-student → BadRequestException', async () => {
      const eventId = await seedEventDirect();
      await expect(
        withTestTenant(async () =>
          comps.add(
            eventId,
            { compType: 'STUDENT', personId: TEST_ADMIN_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('add OFFICIAL for non-official → BadRequestException', async () => {
      const eventId = await seedEventDirect();
      await expect(
        withTestTenant(async () =>
          comps.add(
            eventId,
            { compType: 'OFFICIAL', personId: TEST_ADMIN_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('add to missing event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          comps.add(
            '00000000-0000-0000-0000-000000000000',
            { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('duplicate (event, comp_type, person) → ConflictException', async () => {
      const eventId = await seedEventDirect();
      await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          comps.add(
            eventId,
            { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-writer add → ForbiddenException', async () => {
      const eventId = await seedEventDirect();
      await expect(
        withTestTenant(async () =>
          comps.add(
            eventId,
            { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForEvent returns added entries', async () => {
      const eventId = await seedEventDirect();
      await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => comps.listForEvent(eventId, adminActor()));
      expect(list.length).toBe(1);
    });

    it('remove deletes entry', async () => {
      const eventId = await seedEventDirect();
      const entry = await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => comps.remove(eventId, entry.id, adminActor()));
      const list = await withTestTenant(async () => comps.listForEvent(eventId, adminActor()));
      expect(list.length).toBe(0);
    });

    it('remove missing → NotFoundException', async () => {
      const eventId = await seedEventDirect();
      await expect(
        withTestTenant(async () =>
          comps.remove(eventId, '00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('gateCheck admitted=true for present comp', async () => {
      const eventId = await seedEventDirect();
      await withTestTenant(async () =>
        comps.add(
          eventId,
          { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () =>
        comps.gateCheck({ eventId, personId: TEST_ADMIN_PERSON_ID } as any, adminActor()),
      );
      expect(result.admitted).toBe(true);
      expect(result.compType).toBe('STAFF');
    });

    it('gateCheck admitted=false when not on list', async () => {
      const eventId = await seedEventDirect();
      const result = await withTestTenant(async () =>
        comps.gateCheck({ eventId, personId: TEST_PARENT_PERSON_ID } as any, adminActor()),
      );
      expect(result.admitted).toBe(false);
    });

    it('cross-school: School A admin cannot add to School B event', async () => {
      const bEventId = await seedEventDirect({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          comps.add(
            bEventId,
            { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── VolunteerService ───
  describe('VolunteerService', () => {
    it('signUp self', async () => {
      const eventId = await seedEventDirect();
      const dto = await withTestTenant(async () =>
        vols.signUp(
          eventId,
          { personId: TEST_PARENT_PERSON_ID, role: 'gate' } as any,
          parentActor(),
        ),
      );
      expect(dto.status).toBe('SIGNED_UP');
      expect(dto.role).toBe('gate');
    });

    it('admin signs up someone else', async () => {
      const eventId = await seedEventDirect();
      const dto = await withTestTenant(async () =>
        vols.signUp(
          eventId,
          { personId: TEST_PARENT_PERSON_ID, role: 'concessions' } as any,
          adminActor(),
        ),
      );
      expect(dto.personId).toBe(TEST_PARENT_PERSON_ID);
    });

    it('non-admin cannot sign up someone else → ForbiddenException', async () => {
      const eventId = await seedEventDirect();
      await expect(
        withTestTenant(async () =>
          vols.signUp(eventId, { personId: TEST_ADMIN_PERSON_ID } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate (event, person) → ConflictException', async () => {
      const eventId = await seedEventDirect();
      await withTestTenant(async () =>
        vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, parentActor()),
      );
      await expect(
        withTestTenant(async () =>
          vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('signUp missing event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          vols.signUp(
            '00000000-0000-0000-0000-000000000000',
            { personId: TEST_PARENT_PERSON_ID } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForEvent returns signed up volunteers', async () => {
      const eventId = await seedEventDirect();
      await withTestTenant(async () =>
        vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, parentActor()),
      );
      const list = await withTestTenant(async () => vols.listForEvent(eventId));
      expect(list.length).toBe(1);
    });

    it('self-cancel allowed', async () => {
      const eventId = await seedEventDirect();
      const dto = await withTestTenant(async () =>
        vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, parentActor()),
      );
      const cancelled = await withTestTenant(async () =>
        vols.patch(dto.id, { status: 'CANCELLED' as any } as any, parentActor()),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('non-owner non-admin cannot patch → ForbiddenException', async () => {
      const eventId = await seedEventDirect();
      const dto = await withTestTenant(async () =>
        vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, parentActor()),
      );
      await expect(
        withTestTenant(async () =>
          vols.patch(dto.id, { status: 'CANCELLED' as any } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin cannot flip to CONFIRMED → ForbiddenException', async () => {
      const eventId = await seedEventDirect();
      const dto = await withTestTenant(async () =>
        vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, parentActor()),
      );
      await expect(
        withTestTenant(async () =>
          vols.patch(dto.id, { status: 'CONFIRMED' as any } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin checkIn stamps timestamp', async () => {
      const eventId = await seedEventDirect();
      const dto = await withTestTenant(async () =>
        vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, adminActor()),
      );
      const checkedIn = await withTestTenant(async () =>
        vols.patch(
          dto.id,
          { status: 'CONFIRMED' as any, checkIn: true, role: 'gate' } as any,
          adminActor(),
        ),
      );
      expect(checkedIn.status).toBe('CONFIRMED');
      expect(checkedIn.role).toBe('gate');
      expect(checkedIn.checkInAt).toBeTruthy();
    });

    it('patch missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          vols.patch(
            '00000000-0000-0000-0000-000000000000',
            { status: 'CANCELLED' as any } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch empty body — no-op', async () => {
      const eventId = await seedEventDirect();
      const dto = await withTestTenant(async () =>
        vols.signUp(eventId, { personId: TEST_PARENT_PERSON_ID } as any, adminActor()),
      );
      const out = await withTestTenant(async () => vols.patch(dto.id, {} as any, adminActor()));
      expect(out.id).toBe(dto.id);
    });
  });
});

void TEST_ADMIN_EMPLOYEE_ID;
void teacherActor;
