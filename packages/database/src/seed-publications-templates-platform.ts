import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-publications-templates-platform.ts — Phase 2 Cycle 26 Step 7.
 *
 * Platform-tier publication template seeder. Idempotent at every
 * layer:
 *   - Iterates over every active tenant via platform.platform_tenant_routing
 *     so a new tenant added later picks up the templates on the next run.
 *   - Per (tenant, template name) tuple, uses ON CONFLICT DO NOTHING via
 *     the COALESCE-sentinel UNIQUE INDEX so a re-run does not duplicate
 *     rows.
 *
 * 3 system templates land in every tenant:
 *   - Monthly School Newsletter — 5 sections, NEWSLETTER, MONTHLY
 *   - Weekly Bulletin — 2 sections, BULLETIN, WEEKLY
 *   - Annual Report — 7 sections, REPORT, ANNUAL
 *
 * Every row is is_system=true + school_id=NULL — the system_chk
 * multi-column CHECK enforces the pair. Schools see these templates
 * automatically because pub_templates is tenant-scoped and the
 * Step 3 TemplateService.list query returns every row in the tenant
 * (system rows have school_id IS NULL but they are physically present
 * in each tenant schema after this seeder runs).
 *
 * The Step 3 TemplateService refuses any UPDATE / DELETE against
 * is_system=true rows. Only this seeder writes them — so to evolve a
 * system template, the seeder bumps content here and re-runs (the
 * existing rows are untouched because of ON CONFLICT DO NOTHING).
 * To force-update existing rows, drop them manually via SQL first.
 */

interface SystemTemplate {
  name: string;
  description: string;
  publicationType: 'NEWSLETTER' | 'BULLETIN' | 'REPORT' | 'MAGAZINE' | 'ANNOUNCEMENT' | 'PROGRAM';
  templateContent: Record<string, unknown>;
}

const SYSTEM_TEMPLATES: SystemTemplate[] = [
  {
    name: 'Monthly School Newsletter',
    description:
      'Standard monthly newsletter covering principal message, school news, student spotlight, upcoming events, and sports.',
    publicationType: 'NEWSLETTER',
    templateContent: {
      sections: [
        { title: "Principal's Message", sortOrder: 0, ownerHint: 'PRINCIPAL' },
        { title: 'School News', sortOrder: 1, ownerHint: 'STAFF' },
        { title: 'Student Spotlight', sortOrder: 2, ownerHint: 'STUDENT' },
        { title: 'Upcoming Events', sortOrder: 3, ownerHint: 'STAFF' },
        { title: 'Sports Roundup', sortOrder: 4, ownerHint: 'COACH' },
      ],
      suggestedFrequency: 'MONTHLY',
      defaultDistributionLists: ['ROLE:PARENT', 'ROLE:STAFF'],
    },
  },
  {
    name: 'Weekly Bulletin',
    description:
      'Quick weekly bulletin focused on action items and reminders for staff and families.',
    publicationType: 'BULLETIN',
    templateContent: {
      sections: [
        { title: 'Action Required', sortOrder: 0, ownerHint: 'PRINCIPAL' },
        { title: 'Reminders', sortOrder: 1, ownerHint: 'STAFF' },
      ],
      suggestedFrequency: 'WEEKLY',
      defaultDistributionLists: ['ROLE:PARENT'],
    },
  },
  {
    name: 'Annual Report',
    description:
      'End-of-year report covering academic outcomes, financial summary, community engagement, athletics, and looking ahead.',
    publicationType: 'REPORT',
    templateContent: {
      sections: [
        { title: 'Letter from the Head of School', sortOrder: 0, ownerHint: 'PRINCIPAL' },
        { title: 'Academic Year in Review', sortOrder: 1, ownerHint: 'STAFF' },
        { title: 'Financial Summary', sortOrder: 2, ownerHint: 'STAFF' },
        { title: 'Community Engagement', sortOrder: 3, ownerHint: 'STAFF' },
        { title: 'Athletics & Activities', sortOrder: 4, ownerHint: 'COACH' },
        { title: 'Student Voices', sortOrder: 5, ownerHint: 'STUDENT' },
        { title: 'Looking Ahead', sortOrder: 6, ownerHint: 'PRINCIPAL' },
      ],
      suggestedFrequency: 'ANNUAL',
      defaultDistributionLists: ['ROLE:PARENT', 'ROLE:STAFF', 'ROLE:STUDENT'],
    },
  },
];

async function main() {
  const client = getPlatformClient();

  const tenants = (await client.$queryRawUnsafe(
    `SELECT schema_name, tenant_id::text AS school_id FROM platform.platform_tenant_routing WHERE is_active = true`,
  )) as Array<{ schema_name: string; school_id: string | null }>;

  if (tenants.length === 0) {
    console.log('No tenants found — nothing to seed');
    await disconnectAll();
    return;
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  for (const tenant of tenants) {
    if (!tenant.schema_name) continue;
    for (const template of SYSTEM_TEMPLATES) {
      try {
        const result = (await client.$executeRawUnsafe(
          `INSERT INTO ${tenant.schema_name}.pub_templates
             (id, school_id, name, description, publication_type, template_content, is_system, is_active, created_by)
           VALUES ($1::uuid, NULL, $2, $3, $4, $5::jsonb, true, true, NULL)
           ON CONFLICT (COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid), name) DO NOTHING`,
          generateId(),
          template.name,
          template.description,
          template.publicationType,
          JSON.stringify(template.templateContent),
        )) as number | undefined;
        if (typeof result === 'number' && result > 0) {
          totalInserted += 1;
        } else {
          totalSkipped += 1;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `Failed to seed template "${template.name}" into ${tenant.schema_name}: ${msg}`,
        );
      }
    }
  }

  console.log(
    `seed-publications-templates-platform complete: ${tenants.length} tenant(s) scanned, ${totalInserted} template row(s) inserted, ${totalSkipped} skipped (already present).`,
  );

  await disconnectAll();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectAll();
  process.exit(1);
});
