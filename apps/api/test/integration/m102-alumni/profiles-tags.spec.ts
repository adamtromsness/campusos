import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AlumniProfileService, AlumniTagService } from '@modules/m102-alumni/profile.service';
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
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { resetAlumniTables, ensureIamPerson } from '../fixtures/alumni';

/**
 * Wave 7 — m102-alumni AlumniProfileService + AlumniTagService.
 *
 * Exercises:
 *   - CRUD: create / list / getById / getMine / patch (admin + own + cross-actor).
 *   - Opt-in directory filter: non-admin readers see opted-in profiles only;
 *     OWN row visible regardless of opt-in.
 *   - 404 don't-leak-existence for opted-out profiles of other alumni.
 *   - UNIQUE(school_id, person_id) collision → 409.
 *   - Tags add / remove / listByTag with per-row owner check + admin
 *     bypass.
 *   - Cross-school isolation: School A admin cannot read or mutate
 *     School B profiles/tags.
 */
describe('integration:m102-alumni/profiles-tags', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let profiles: AlumniProfileService;
  let tags: AlumniTagService;
  const seededPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    profiles = new AlumniProfileService(tenantPrisma, permCheck);
    tags = new AlumniTagService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAlumniTables(rawClient, { personIds: seededPersonIds.splice(0) });
  });

  async function ensurePersonForActor(personId: string, personType: 'GUARDIAN' | 'STUDENT' | 'STAFF' = 'STAFF') {
    await ensureIamPerson(rawClient, personId, { personType });
  }

  async function seedProfileDirect(opts: {
    schoolId?: string;
    personId?: string;
    optedIn?: boolean;
    graduationYear?: number;
    employer?: string;
  } = {}): Promise<string> {
    const generated = opts.personId === undefined;
    const personId = opts.personId ?? generateId();
    if (generated) seededPersonIds.push(personId);
    await ensureIamPerson(rawClient, personId);
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.alm_alumni_profiles
         (id, school_id, person_id, graduation_year, current_employer, is_opted_in)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      personId,
      opts.graduationYear ?? 2020,
      opts.employer ?? null,
      opts.optedIn ?? true,
    );
    return id;
  }

  describe('AlumniProfileService.create', () => {
    it('admin creates a profile on behalf of any person', async () => {
      const personId = generateId();
      seededPersonIds.push(personId);
      await ensureIamPerson(rawClient, personId, { firstName: 'Alice', lastName: 'Alumna' });

      const dto = await withTestTenant(async () =>
        profiles.create(
          {
            personId,
            graduationYear: 2022,
            degreeProgramme: 'B.Sc',
            currentEmployer: 'Acme',
            currentTitle: 'Engineer',
            linkedinUrl: 'https://example.com',
            contactEmail: 'a@example.com',
            contactPhone: '555-1234',
            isOptedIn: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.graduationYear).toBe(2022);
      expect(dto.currentEmployer).toBe('Acme');
      expect(dto.displayName).toBe('Alice Alumna');
      expect(dto.tags).toEqual([]);
    });

    it('non-admin cannot create profile for another person → ForbiddenException', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const otherPerson = generateId();
      seededPersonIds.push(otherPerson);
      await ensureIamPerson(rawClient, otherPerson);
      await expect(
        withTestTenant(async () =>
          profiles.create(
            { personId: otherPerson, graduationYear: 2020 } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin can create profile for self', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const dto = await withTestTenant(async () =>
        profiles.create(
          { personId: TEST_PARENT_PERSON_ID, graduationYear: 2015 } as any,
          parentActor(),
        ),
      );
      expect(dto.personId).toBe(TEST_PARENT_PERSON_ID);
      expect(dto.isOptedIn).toBe(true);
    });

    it('UNIQUE(school_id, person_id) collision → ConflictException', async () => {
      const personId = generateId();
      seededPersonIds.push(personId);
      await ensureIamPerson(rawClient, personId);
      await withTestTenant(async () =>
        profiles.create({ personId, graduationYear: 2018 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          profiles.create({ personId, graduationYear: 2019 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('AlumniProfileService.list / getById / getMine', () => {
    it('admin sees every row regardless of opt-in', async () => {
      await seedProfileDirect({ optedIn: true });
      await seedProfileDirect({ optedIn: false });
      const list = await withTestTenant(async () => profiles.list(adminActor()));
      expect(list.length).toBe(2);
    });

    it('non-admin sees opted-in rows only; own row visible regardless', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      await seedProfileDirect({ optedIn: true });
      // Hidden — different person, opt-out
      await seedProfileDirect({ optedIn: false });
      // Own row — opt-out but still visible
      const ownId = await seedProfileDirect({ personId: TEST_PARENT_PERSON_ID, optedIn: false });

      const list = await withTestTenant(async () => profiles.list(parentActor()));
      const ids = list.map((p) => p.id);
      expect(ids).toContain(ownId);
      // Two visible: own + opted-in
      expect(list.length).toBe(2);
    });

    it('filters by graduationYear / employer / tag', async () => {
      const a = await seedProfileDirect({ graduationYear: 2018, employer: 'Acme Corp' });
      await seedProfileDirect({ graduationYear: 2020, employer: 'BigCo' });
      // Tag the first
      await withTestTenant(async () =>
        tags.addTag({ alumniId: a, tag: 'STEM_MENTOR' } as any, adminActor()),
      );
      const byYear = await withTestTenant(async () =>
        profiles.list(adminActor(), { graduationYear: 2018 }),
      );
      expect(byYear.length).toBe(1);
      const byEmployer = await withTestTenant(async () =>
        profiles.list(adminActor(), { employer: 'acme' }),
      );
      expect(byEmployer.length).toBe(1);
      const byTag = await withTestTenant(async () =>
        profiles.list(adminActor(), { tag: 'STEM_MENTOR' }),
      );
      expect(byTag.length).toBe(1);
    });

    it('getById: opted-out → 404 for non-admin non-owner', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const hiddenId = await seedProfileDirect({ optedIn: false });
      await expect(
        withTestTenant(async () => profiles.getById(hiddenId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Admin sees it
      const seen = await withTestTenant(async () => profiles.getById(hiddenId, adminActor()));
      expect(seen.id).toBe(hiddenId);
    });

    it('getMine returns own profile; 404 when none registered', async () => {
      await ensurePersonForActor(TEST_STUDENT_PERSON_ID, 'STUDENT');
      const ownId = await seedProfileDirect({ personId: TEST_STUDENT_PERSON_ID });
      const mine = await withTestTenant(async () => profiles.getMine(studentActor()));
      expect(mine.id).toBe(ownId);
      // Parent has no profile at this school
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      await expect(
        withTestTenant(async () => profiles.getMine(parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('AlumniProfileService.patch', () => {
    it('admin can patch any profile', async () => {
      const id = await seedProfileDirect();
      const out = await withTestTenant(async () =>
        profiles.patch(
          id,
          {
            currentEmployer: 'NewCo',
            currentTitle: 'CTO',
            isOptedIn: false,
            linkedinUrl: 'https://l/i',
            contactEmail: 'x@y',
            contactPhone: '999',
            degreeProgramme: 'M.Sc',
          } as any,
          adminActor(),
        ),
      );
      expect(out.currentEmployer).toBe('NewCo');
      expect(out.currentTitle).toBe('CTO');
      expect(out.isOptedIn).toBe(false);
    });

    it('non-admin non-owner gets NotFoundException (don\'t-leak-existence)', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const otherId = await seedProfileDirect();
      await expect(
        withTestTenant(async () =>
          profiles.patch(otherId, { currentEmployer: 'X' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('owner can patch own profile', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const ownId = await seedProfileDirect({ personId: TEST_PARENT_PERSON_ID });
      const out = await withTestTenant(async () =>
        profiles.patch(ownId, { currentEmployer: 'OwnCo' } as any, parentActor()),
      );
      expect(out.currentEmployer).toBe('OwnCo');
    });

    it('empty body — returns current state', async () => {
      const id = await seedProfileDirect({ employer: 'Init' });
      const out = await withTestTenant(async () =>
        profiles.patch(id, {} as any, adminActor()),
      );
      expect(out.id).toBe(id);
      expect(out.currentEmployer).toBe('Init');
    });

    it('cross-school: School A admin cannot patch School B profile', async () => {
      const bId = await seedProfileDirect({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          profiles.patch(bId, { currentEmployer: 'X' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // School B context sees it
      const seen = await withTestTenantB(async () => profiles.getById(bId, adminActor()));
      expect(seen.id).toBe(bId);
    });
  });

  describe('AlumniTagService', () => {
    it('admin tags any profile; listByTag returns them', async () => {
      const id = await seedProfileDirect();
      const tag = await withTestTenant(async () =>
        tags.addTag({ alumniId: id, tag: 'DONOR' } as any, adminActor()),
      );
      expect(tag.tag).toBe('DONOR');
      const list = await withTestTenant(async () => tags.listByTag('DONOR', adminActor()));
      expect(list.length).toBe(1);
    });

    it('non-admin cannot tag another alumnus → ForbiddenException', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const otherId = await seedProfileDirect();
      await expect(
        withTestTenant(async () =>
          tags.addTag({ alumniId: otherId, tag: 'X' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('owner can self-tag', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const ownId = await seedProfileDirect({ personId: TEST_PARENT_PERSON_ID });
      const tag = await withTestTenant(async () =>
        tags.addTag({ alumniId: ownId, tag: 'MENTOR' } as any, parentActor()),
      );
      expect(tag.tag).toBe('MENTOR');
    });

    it('UNIQUE(alumni_id, tag) → ConflictException on dup', async () => {
      const id = await seedProfileDirect();
      await withTestTenant(async () =>
        tags.addTag({ alumniId: id, tag: 'BOARD' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          tags.addTag({ alumniId: id, tag: 'BOARD' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('removeTag: admin removes any tag; non-owner gets 404', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const id = await seedProfileDirect();
      const tag = await withTestTenant(async () =>
        tags.addTag({ alumniId: id, tag: 'INTERNATIONAL' } as any, adminActor()),
      );
      // Non-owner sees 404 (don't-leak-existence)
      await expect(
        withTestTenant(async () => tags.removeTag(tag.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Admin removes
      await withTestTenant(async () => tags.removeTag(tag.id, adminActor()));
      const list = await withTestTenant(async () => tags.listByTag('INTERNATIONAL', adminActor()));
      expect(list.length).toBe(0);
    });

    it('removeTag: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          tags.removeTag('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('owner can remove own tag', async () => {
      await ensurePersonForActor(TEST_PARENT_PERSON_ID, 'GUARDIAN');
      const ownId = await seedProfileDirect({ personId: TEST_PARENT_PERSON_ID });
      const tag = await withTestTenant(async () =>
        tags.addTag({ alumniId: ownId, tag: 'SELF' } as any, parentActor()),
      );
      await withTestTenant(async () => tags.removeTag(tag.id, parentActor()));
      const list = await withTestTenant(async () => tags.listByTag('SELF', adminActor()));
      expect(list.length).toBe(0);
    });

    it('listByTag: empty tag → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => tags.listByTag('', adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school: tag UUID from School B → 404 in School A context', async () => {
      const bId = await seedProfileDirect({ schoolId: TEST_SCHOOL_B_ID });
      const tagId = await withTestTenantB(async () =>
        tags.addTag({ alumniId: bId, tag: 'FROM_B' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => tags.removeTag(tagId.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
