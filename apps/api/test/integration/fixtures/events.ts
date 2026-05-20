import type { PrismaClient } from '@prisma/client';
import {
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';

/**
 * Wave 7 — m101-events fixtures.
 *
 * Resets the 9 evt_* tables + the platform.platform_outbox rows the
 * events module emits (evt.order.confirmed, evt.refund.issued,
 * evt.event.completed, evt.athletic_event.created) so each spec starts
 * on a clean slate. Per-test specs lay down their own events / tiers /
 * orders / tickets inside the test body — no canonical seed needed.
 *
 * The TRUNCATE on evt_ticket_scans is unusual: it is a RANGE-partitioned
 * table and TRUNCATE … CASCADE cleanly resets every partition without
 * needing to enumerate them. The migration provisions monthly partitions
 * 2025-08 → 2027-08; future migrations extend the range.
 */
const EVT_TABLES = [
  'evt_volunteers',
  'evt_comp_lists',
  'evt_season_passes',
  'evt_ticket_scans',
  'evt_refunds',
  'evt_tickets',
  'evt_orders',
  'evt_ticket_tiers',
  'evt_events',
];

const EVT_TOPICS = [
  'evt.order.confirmed',
  'evt.refund.issued',
  'evt.event.completed',
  'evt.athletic_event.created',
];

export async function resetEventsTables(client: PrismaClient): Promise<void> {
  const list = EVT_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox WHERE topic = ANY($1) AND (tenant_id = $2::uuid OR tenant_id = $3::uuid)`,
    EVT_TOPICS,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );
}
