import type { PrismaClient } from '@prisma/client';
import { TEST_SCHOOL_ID, TEST_SCHOOL_B_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import { TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';

/**
 * Wave 5 — m42-publications fixtures.
 *
 * Seeds the shared catalogue rows required for the publications /
 * sections / versions / distribution / series services:
 *
 *   - pub_series (one fixture series per school for default-series tests)
 *
 * Per-test rows (publications, sections, versions, contributors,
 * collaborators, distributions) are created inside each spec file's
 * beforeEach.
 *
 * IDs follow the suite convention: aaaa-7777-8888-0000000006xx
 * for School A, with -00000000b6xx mirrors on School B.
 */
export const TEST_PUB_SERIES_ID = '019e0cf8-aaaa-7777-8888-000000000600';
export const TEST_PUB_SERIES_B_ID = '019e0cf8-aaaa-7777-8888-00000000b600';

export async function ensurePublicationsFixtures(prisma: PrismaClient): Promise<void> {
  // Series — School A
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.pub_series
       (id, school_id, title, description, publication_type, frequency, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'Fixture Series A', 'Suite default series', 'NEWSLETTER', 'WEEKLY', true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PUB_SERIES_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );

  // Series — School B
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.pub_series
       (id, school_id, title, description, publication_type, frequency, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'Fixture Series B', 'Suite default series B', 'NEWSLETTER', 'WEEKLY', true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PUB_SERIES_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );
}
