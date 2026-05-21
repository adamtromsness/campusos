import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  AcademicTreeService,
  type GradeBandDefinitions,
} from '@modules/m00-platform/configuration/configuration.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

const GRADE_BAND_CONFIG_KEY = 'grade_band_definitions';

/**
 * DB-backed integration tests for the AcademicTreeService grade-band
 * persistence (loadBandDefinitions / saveBandDefinitions) plus the
 * gradeBands + ungroupedGrades grouping branches in getTree().
 *
 * The existing configuration-trees.spec.ts hits the empty-class path
 * for getTree but not the band-grouping logic that fires once classes
 * exist.
 */
describe('integration:m00-platform/configuration-grade-bands', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let academic: AcademicTreeService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    academic = new AcademicTreeService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe stored grade-band definitions so each test starts deterministic
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.school_config WHERE config_key = $1`,
      GRADE_BAND_CONFIG_KEY,
    );
  });

  describe('saveBandDefinitions — validation', () => {
    it('rejects missing bands array', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({} as unknown as GradeBandDefinitions),
        ),
      ).rejects.toThrow(/Body must include a `bands` array/);
    });

    it('rejects non-array bands', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: 'not-an-array' as unknown as GradeBandDefinitions['bands'],
          }),
        ),
      ).rejects.toThrow(/bands/);
    });

    it('rejects entry that is not an object', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: [null as unknown as { key: string; label: string; grades: string[] }],
          }),
        ),
      ).rejects.toThrow(/Each band must be an object/);
    });

    it('rejects missing key', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: [{ key: '', label: 'Elementary', grades: ['1'] }],
          }),
        ),
      ).rejects.toThrow(/Band `key` is required/);
    });

    it('rejects missing label', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: [{ key: 'elem', label: '', grades: ['1'] }],
          }),
        ),
      ).rejects.toThrow(/Band `label` is required/);
    });

    it('rejects key > 60 chars', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: [{ key: 'x'.repeat(61), label: 'L', grades: ['1'] }],
          }),
        ),
      ).rejects.toThrow(/too long/);
    });

    it('rejects duplicate band keys', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: [
              { key: 'elem', label: 'Elementary', grades: ['1'] },
              { key: 'elem', label: 'Duplicate', grades: ['2'] },
            ],
          }),
        ),
      ).rejects.toThrow(/Duplicate band key/);
    });

    it('rejects band with non-array grades', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: [
              {
                key: 'elem',
                label: 'Elementary',
                grades: 'not-an-array' as unknown as string[],
              },
            ],
          }),
        ),
      ).rejects.toThrow(/must include a `grades` array/);
    });

    it('rejects grade appearing in two bands', async () => {
      await expect(
        withTestTenant(async () =>
          academic.saveBandDefinitions({
            bands: [
              { key: 'elem', label: 'Elementary', grades: ['1', '2'] },
              { key: 'mid', label: 'Middle', grades: ['2', '3'] },
            ],
          }),
        ),
      ).rejects.toThrow(/appears in more than one band/);
    });

    it('happy path: persists sanitised bands and ignores blank grade entries', async () => {
      const result = await withTestTenant(async () =>
        academic.saveBandDefinitions({
          bands: [
            { key: 'elem', label: 'Elementary', grades: ['1', '2', '', '3'] },
            { key: 'middle', label: 'Middle School', grades: ['6', '7', '8'] },
          ],
        }),
      );
      expect(result.bands).toHaveLength(2);
      expect(result.bands[0]!.grades).toEqual(['1', '2', '3']);
      expect(result.bands[1]!.grades).toEqual(['6', '7', '8']);

      // Persisted in school_config
      const stored = await withTestTenant(async () => academic.loadBandDefinitions());
      expect(stored.bands).toHaveLength(2);
      expect(stored.bands.find((b) => b.key === 'elem')).toBeDefined();
    });

    it('UPSERT: second save replaces previous bands', async () => {
      await withTestTenant(async () =>
        academic.saveBandDefinitions({
          bands: [{ key: 'old', label: 'Old', grades: ['1'] }],
        }),
      );
      await withTestTenant(async () =>
        academic.saveBandDefinitions({
          bands: [{ key: 'new', label: 'New', grades: ['9'] }],
        }),
      );
      const stored = await withTestTenant(async () => academic.loadBandDefinitions());
      expect(stored.bands).toHaveLength(1);
      expect(stored.bands[0]!.key).toBe('new');
    });
  });

  describe('loadBandDefinitions — defensive parsing', () => {
    it('returns empty bands when school_config row is missing', async () => {
      const defs = await withTestTenant(async () => academic.loadBandDefinitions());
      expect(defs.bands).toEqual([]);
    });

    it('returns empty bands when config_value is not an object', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.school_config (id, config_key, config_value)
         VALUES (gen_random_uuid(), $1, '"not-an-object"'::jsonb)`,
        GRADE_BAND_CONFIG_KEY,
      );
      const defs = await withTestTenant(async () => academic.loadBandDefinitions());
      expect(defs.bands).toEqual([]);
    });

    it('returns empty bands when bands key is missing or not an array', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.school_config (id, config_key, config_value)
         VALUES (gen_random_uuid(), $1, '{"foo": "bar"}'::jsonb)`,
        GRADE_BAND_CONFIG_KEY,
      );
      const defs = await withTestTenant(async () => academic.loadBandDefinitions());
      expect(defs.bands).toEqual([]);
    });

    it('skips malformed band entries inside an otherwise valid bands array', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.school_config (id, config_key, config_value)
         VALUES (gen_random_uuid(), $1, $2::jsonb)`,
        GRADE_BAND_CONFIG_KEY,
        JSON.stringify({
          bands: [
            null, // skipped
            { key: 'no-label', grades: ['1'] }, // skipped — missing label
            { key: 'no-grades', label: 'X' }, // skipped — missing grades
            { key: 'good', label: 'Good', grades: ['5', 6, '7'] }, // valid; 6 (number) skipped
          ],
        }),
      );
      const defs = await withTestTenant(async () => academic.loadBandDefinitions());
      expect(defs.bands).toHaveLength(1);
      expect(defs.bands[0]!.key).toBe('good');
      expect(defs.bands[0]!.grades).toEqual(['5', '7']);
    });
  });

  describe('getTree — gradeBands + ungroupedGrades grouping', () => {
    const createdCourseIds: string[] = [];
    const createdClassIds: string[] = [];

    beforeEach(async () => {
      // Wipe seeded classes/courses created by previous test
      if (createdClassIds.length > 0) {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.sis_classes WHERE id = ANY($1::uuid[])`,
          createdClassIds.splice(0),
        );
      }
      if (createdCourseIds.length > 0) {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.sis_courses WHERE id = ANY($1::uuid[])`,
          createdCourseIds.splice(0),
        );
      }
    });

    async function seedClass(gradeLevel: string, courseName: string): Promise<string> {
      const courseId = generateId();
      const classId = generateId();
      createdCourseIds.push(courseId);
      createdClassIds.push(classId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_courses (id, school_id, name, code, grade_level)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
        courseId,
        TEST_SCHOOL_ID,
        courseName,
        'TEST-' + courseId.slice(-6).toUpperCase(),
        gradeLevel,
      );
      // Find current academic_year
      const yearRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_academic_years WHERE is_current = true LIMIT 1`,
      )) as Array<{ id: string }>;
      const yearId =
        yearRows.length > 0
          ? yearRows[0]!.id
          : (
              (await rawClient.$queryRawUnsafe(
                `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_academic_years ORDER BY start_date DESC LIMIT 1`,
              )) as Array<{ id: string }>
            )[0]!.id;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_classes (id, school_id, course_id, academic_year_id, section_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`,
        classId,
        TEST_SCHOOL_ID,
        courseId,
        yearId,
        'TST-' + classId.slice(-4),
      );
      return classId;
    }

    it('classes with grade matching a band → land under the band; unmatched grade → ungroupedGrades', async () => {
      await withTestTenant(async () =>
        academic.saveBandDefinitions({
          bands: [{ key: 'elementary', label: 'Elementary', grades: ['1', '2', '3'] }],
        }),
      );
      await seedClass('1', 'Math 1'); // → elementary band
      await seedClass('2', 'Reading 2'); // → elementary band
      await seedClass('9', 'Algebra 9'); // → ungrouped

      const tree = await withTestTenant(async () => academic.getTree());
      const elementary = tree.gradeBands.find((b) => b.bandKey === 'elementary');
      expect(elementary).toBeDefined();
      // The grade nodes for '1' and '2' should exist (with classes)
      const grade1 = elementary!.grades.find((g) => g.gradeLevel === '1');
      const grade2 = elementary!.grades.find((g) => g.gradeLevel === '2');
      expect(grade1).toBeDefined();
      expect(grade2).toBeDefined();
      expect(grade1!.classes.length).toBeGreaterThanOrEqual(1);
      expect(grade2!.classes.length).toBeGreaterThanOrEqual(1);

      // grade '9' is ungrouped (not in band, has classes)
      const ungrouped9 = tree.ungroupedGrades.find((g) => g.gradeLevel === '9');
      expect(ungrouped9).toBeDefined();
      expect(ungrouped9!.classes.length).toBeGreaterThanOrEqual(1);
    });

    it('class node carries section_code + course_name + grade_level + studentCount', async () => {
      await seedClass('5', 'Science 5');
      const tree = await withTestTenant(async () => academic.getTree());
      const grade5 = tree.ungroupedGrades.find((g) => g.gradeLevel === '5');
      expect(grade5).toBeDefined();
      const sci = grade5!.classes.find((c) => c.courseName === 'Science 5');
      expect(sci).toBeDefined();
      expect(sci!.sectionCode).toMatch(/^TST-/);
      expect(sci!.studentCount).toBe(0); // no enrolments seeded
      expect(Array.isArray(sci!.teacherNames)).toBe(true);
    });

    it('grade with no classes is still rendered in the band (empty array)', async () => {
      await withTestTenant(async () =>
        academic.saveBandDefinitions({
          bands: [{ key: 'empty-band', label: 'EmptyTest', grades: ['99-never'] }],
        }),
      );
      const tree = await withTestTenant(async () => academic.getTree());
      const band = tree.gradeBands.find((b) => b.bandKey === 'empty-band');
      expect(band).toBeDefined();
      const g = band!.grades.find((x) => x.gradeLevel === '99-never');
      expect(g).toBeDefined();
      expect(g!.classes).toEqual([]);
    });

    it('ungroupedGrades is sorted alphabetically by gradeLevel', async () => {
      await seedClass('9', 'A');
      await seedClass('5', 'B');
      await seedClass('1', 'C');
      const tree = await withTestTenant(async () => academic.getTree());
      const ungroupedTestGrades = tree.ungroupedGrades
        .map((g) => g.gradeLevel)
        .filter((g) => ['1', '5', '9'].includes(g));
      // localeCompare sort: '1', '5', '9'
      const sorted = [...ungroupedTestGrades].sort((a, b) => a.localeCompare(b));
      expect(ungroupedTestGrades).toEqual(sorted);
    });
  });
});
