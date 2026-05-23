import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { PrismaClient } from '@prisma/client';
import { generateId } from './uuid';

/**
 * seed-personas — populate platform_personas + the
 * David-Chen-as-Maya's-parent family_children row for the 7 demo
 * users that ship with `pnpm db:seed`.
 *
 * Why: persona-registration Step 14 makes /auth/me look up active
 * personas in platform_personas. Without seeded rows, every demo
 * user lands on /getting-started after login because the resolver
 * returns []. This script bridges that — admin@ et al. arrive at
 * the launchpad with their persona already active.
 *
 * Idempotent: ON CONFLICT DO NOTHING on every insert. Safe to re-run
 * after seed-iam / seed-sis / seed-hr have populated the projection
 * tables.
 *
 * Run AFTER seed-hr (employees) and seed-sis (students) so the demo
 * users have their projection rows in place.
 */

interface DemoUser {
  email: string;
  firstName: string;
  lastName: string;
}

interface PersonaSpec {
  type: 'STAFF' | 'STUDENT' | 'PARENT';
  // null for platform-wide (e.g. Platform Admin)
  schoolId: string | null;
  label: string;
}

async function ensureFamily(client: PrismaClient, personId: string): Promise<string> {
  const existing = await client.$queryRawUnsafe<Array<{ family_id: string }>>(
    `SELECT family_id::text AS family_id FROM platform.platform_family_members
     WHERE person_id = $1::uuid LIMIT 1`,
    personId,
  );
  if (existing[0]) return existing[0].family_id;

  const familyId = generateId();
  const memberId = generateId();
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.platform_families (id, name, home_language, mailing_address_same)
       VALUES ($1::uuid, NULL, 'en', true)`,
      familyId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_members
         (id, family_id, person_id, member_role, is_primary_contact, joined_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', true, now())`,
      memberId,
      familyId,
      personId,
    );
  });
  return familyId;
}

async function upsertPersona(
  client: PrismaClient,
  personId: string,
  persona: PersonaSpec,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_personas
       (id, person_id, type, school_id, label, is_active, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, true, now())
     ON CONFLICT (person_id, type, COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET label = EXCLUDED.label, is_active = true`,
    generateId(),
    personId,
    persona.type,
    persona.schoolId,
    persona.label,
  );
}

async function findPerson(
  client: PrismaClient,
  user: DemoUser,
): Promise<{ personId: string; accountId: string } | null> {
  const row = await client.platformUser.findUnique({
    where: { email: user.email },
    select: { id: true, personId: true },
  });
  if (!row) return null;
  return { personId: row.personId, accountId: row.id };
}

async function main(): Promise<void> {
  const client = new PrismaClient();
  await client.$connect();

  console.log('seed-personas — populating platform_personas for the demo users');

  const demoSchool = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!demoSchool) {
    console.log('  No demo school found — run `pnpm db:seed` (seed.ts) first. Skipping.');
    await client.$disconnect();
    return;
  }
  const schoolId = demoSchool.id;
  const schoolName = demoSchool.name;

  // ─── 1. The 7 demo users + their personas ────────────────

  const SPECS: Array<{
    user: DemoUser;
    personas: PersonaSpec[];
  }> = [
    {
      user: {
        email: 'admin@demo.campusos.dev',
        firstName: 'Platform',
        lastName: 'Admin',
      },
      personas: [
        // Platform Admin — no school_id; the dashboard greets them as
        // "Platform Administrator" cross-tenant.
        { type: 'STAFF', schoolId: null, label: 'Platform Administrator' },
      ],
    },
    {
      user: {
        email: 'principal@demo.campusos.dev',
        firstName: 'Sarah',
        lastName: 'Mitchell',
      },
      personas: [{ type: 'STAFF', schoolId, label: `Principal at ${schoolName}` }],
    },
    {
      user: {
        email: 'teacher@demo.campusos.dev',
        firstName: 'James',
        lastName: 'Rivera',
      },
      personas: [{ type: 'STAFF', schoolId, label: `Teacher at ${schoolName}` }],
    },
    {
      user: {
        email: 'student@demo.campusos.dev',
        firstName: 'Maya',
        lastName: 'Chen',
      },
      personas: [{ type: 'STUDENT', schoolId, label: `Student at ${schoolName}` }],
    },
    {
      user: {
        email: 'parent@demo.campusos.dev',
        firstName: 'David',
        lastName: 'Chen',
      },
      personas: [{ type: 'PARENT', schoolId, label: `Parent at ${schoolName}` }],
    },
    {
      user: {
        email: 'vp@demo.campusos.dev',
        firstName: 'Linda',
        lastName: 'Park',
      },
      personas: [{ type: 'STAFF', schoolId, label: `Vice Principal at ${schoolName}` }],
    },
    {
      user: {
        email: 'counsellor@demo.campusos.dev',
        firstName: 'Marcus',
        lastName: 'Hayes',
      },
      personas: [{ type: 'STAFF', schoolId, label: `Counsellor at ${schoolName}` }],
    },
  ];

  for (const spec of SPECS) {
    const found = await findPerson(client, spec.user);
    if (!found) {
      console.log(`  ${spec.user.email}: platform_users row missing — skipping`);
      continue;
    }
    // Every demo user gets a family unit (singles included) so the
    // /family page works without a lazy-create round-trip.
    await ensureFamily(client, found.personId);
    for (const p of spec.personas) {
      await upsertPersona(client, found.personId, p);
    }
    console.log(`  ${spec.user.email}: ${spec.personas.map((p) => p.type).join(', ')}`);
  }

  // ─── 2. David Chen → Maya Chen as LINKED family child ────

  const david = await findPerson(client, {
    email: 'parent@demo.campusos.dev',
    firstName: 'David',
    lastName: 'Chen',
  });
  const maya = await findPerson(client, {
    email: 'student@demo.campusos.dev',
    firstName: 'Maya',
    lastName: 'Chen',
  });

  if (david && maya) {
    const davidFamilyId = await ensureFamily(client, david.personId);

    // Ensure David's family also lists Maya as a member so the /family
    // children view + cross-school sibling detection both see her.
    await client.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_members
         (id, family_id, person_id, member_role, is_primary_contact, joined_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CHILD', false, now())
       ON CONFLICT (family_id, person_id) DO NOTHING`,
      generateId(),
      davidFamilyId,
      maya.personId,
    );

    // platform_family_children — the LINKED row that activates David's
    // PARENT persona via PersonaResolutionService.
    const existing = await client.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_family_children
       WHERE family_id = $1::uuid AND person_id = $2::uuid LIMIT 1`,
      davidFamilyId,
      maya.personId,
    );
    if (existing.length === 0) {
      const mayaPerson = await client.iamPerson.findUnique({
        where: { id: maya.personId },
        select: { firstName: true, lastName: true, dateOfBirth: true },
      });
      await client.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_children
           (id, family_id, person_id, first_name, last_name, date_of_birth, status, linked_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, 'LINKED', now(), now())`,
        generateId(),
        davidFamilyId,
        maya.personId,
        mayaPerson?.firstName ?? 'Maya',
        mayaPerson?.lastName ?? 'Chen',
        mayaPerson?.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      );
      console.log('  David Chen → Maya Chen LINKED in platform_family_children');
    } else {
      console.log('  David Chen → Maya Chen already LINKED');
    }
  }

  console.log('seed-personas complete');
  await client.$disconnect();
}

main().catch((e: unknown) => {
  console.error('seed-personas failed:', e);
  process.exit(1);
});
