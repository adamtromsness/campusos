import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { OutboxService } from '@shared/kafka';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  deterministicAthleticEventCreatedEventId,
  deterministicEventCompletedEventId,
} from './event-ids';
import type {
  CreateEventDto,
  CreateTierDto,
  EventDto,
  EventStatus,
  EventType,
  TierDto,
  UpdateEventDto,
  UpdateTierDto,
} from './dto/events.dto';

interface EventRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  event_type: string;
  event_date: string;
  start_time: string;
  end_time: string | null;
  venue_id: string | null;
  venue_name: string | null;
  total_capacity: number | null;
  total_tier_quantity: number;
  linked_game_id: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface TierRow {
  id: string;
  event_id: string;
  name: string;
  price: string | number;
  quantity: number;
  quantity_sold: number;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  is_active: boolean;
}

const ALLOWED_STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  DRAFT: ['ON_SALE', 'CANCELLED'],
  ON_SALE: ['SOLD_OUT', 'COMPLETED', 'CANCELLED'],
  SOLD_OUT: ['ON_SALE', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async isWriter(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'evt-001:write',
      'evt-001:admin',
    ]);
  }

  async assertWriter(actor: ResolvedActor): Promise<void> {
    if (!(await this.isWriter(actor))) {
      throw new ForbiddenException('Event management requires evt-001:write or admin scope.');
    }
  }

  private rowToDto(r: EventRow, tiers?: TierDto[]): EventDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      title: r.title,
      description: r.description,
      eventType: r.event_type as EventType,
      eventDate: r.event_date,
      startTime: r.start_time,
      endTime: r.end_time,
      venueId: r.venue_id,
      venueName: r.venue_name,
      totalCapacity: r.total_capacity,
      totalTierQuantity: Number(r.total_tier_quantity),
      linkedGameId: r.linked_game_id,
      status: r.status as EventStatus,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      tiers,
    };
  }

  private tierRowToDto(r: TierRow): TierDto {
    const qty = Number(r.quantity);
    const sold = Number(r.quantity_sold);
    return {
      id: r.id,
      eventId: r.event_id,
      name: r.name,
      price: Number(r.price),
      quantity: qty,
      quantitySold: sold,
      remaining: Math.max(qty - sold, 0),
      saleStartsAt: r.sale_starts_at,
      saleEndsAt: r.sale_ends_at,
      isActive: r.is_active,
    };
  }

  async list(
    actor: ResolvedActor,
    filters?: { status?: EventStatus; eventType?: EventType; fromDate?: string },
  ): Promise<EventDto[]> {
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    const where: string[] = ['e.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    // Non-writers see ON_SALE + SOLD_OUT + COMPLETED only — they never
    // see DRAFT events. Writers see everything.
    if (!writer) {
      where.push(`e.status <> 'DRAFT' AND e.status <> 'CANCELLED'`);
    }
    if (filters?.status) {
      where.push(`e.status = $${i++}`);
      params.push(filters.status);
    }
    if (filters?.eventType) {
      where.push(`e.event_type = $${i++}`);
      params.push(filters.eventType);
    }
    if (filters?.fromDate) {
      where.push(`e.event_date >= $${i++}::date`);
      params.push(filters.fromDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT e.id::text AS id, e.school_id::text AS school_id, e.title, e.description,
                e.event_type, e.event_date::text AS event_date, e.start_time::text AS start_time,
                e.end_time::text AS end_time, e.venue_id::text AS venue_id, e.venue_name,
                e.total_capacity, e.total_tier_quantity, e.linked_game_id::text AS linked_game_id,
                e.status, e.created_by::text AS created_by,
                e.created_at::text AS created_at, e.updated_at::text AS updated_at
         FROM evt_events e
         WHERE ${where.join(' AND ')}
         ORDER BY e.event_date ASC, e.start_time ASC`,
        ...params,
      );
    })) as EventRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<EventDto> {
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT e.id::text AS id, e.school_id::text AS school_id, e.title, e.description,
                e.event_type, e.event_date::text AS event_date, e.start_time::text AS start_time,
                e.end_time::text AS end_time, e.venue_id::text AS venue_id, e.venue_name,
                e.total_capacity, e.total_tier_quantity, e.linked_game_id::text AS linked_game_id,
                e.status, e.created_by::text AS created_by,
                e.created_at::text AS created_at, e.updated_at::text AS updated_at
         FROM evt_events e
         WHERE e.id = $1::uuid AND e.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as EventRow[];
    if (rows.length === 0) throw new NotFoundException('Event not found');
    const event = rows[0]!;
    // Hide DRAFT events from non-writers
    if (!writer && (event.status === 'DRAFT' || event.status === 'CANCELLED')) {
      throw new NotFoundException('Event not found');
    }
    const tiers = await this.loadTiers(event.id);
    return this.rowToDto(event, tiers);
  }

  /**
   * REVIEW-P2C12 ROUND 1 MAJOR 2 — loadTiers now JOINs through
   * evt_events with the school predicate so a foreign-school event id
   * cannot leak tier rows. The public TierService.listForEvent path
   * goes through this method directly and inherits the predicate.
   */
  async loadTiers(eventId: string): Promise<TierDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT t.id::text AS id, t.event_id::text AS event_id, t.name, t.price,
                t.quantity, t.quantity_sold,
                t.sale_starts_at::text AS sale_starts_at,
                t.sale_ends_at::text AS sale_ends_at, t.is_active
         FROM evt_ticket_tiers t
         JOIN evt_events e ON e.id = t.event_id
         WHERE t.event_id = $1::uuid AND e.school_id = $2::uuid
         ORDER BY t.created_at ASC`,
        eventId,
        tenant.schoolId,
      );
    })) as TierRow[];
    return rows.map((r) => this.tierRowToDto(r));
  }

  async create(input: CreateEventDto, actor: ResolvedActor): Promise<EventDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    let athleticEventCreated = false;
    let compAddedCount = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO evt_events
         (id, school_id, title, description, event_type, event_date, start_time, end_time,
          venue_id, venue_name, total_capacity, linked_game_id, status, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::time, $8::time,
                 $9::uuid, $10, $11, $12::uuid, 'DRAFT', $13::uuid)`,
        id,
        tenant.schoolId,
        input.title,
        input.description ?? null,
        input.eventType,
        input.eventDate,
        input.startTime,
        input.endTime ?? null,
        input.venueId ?? null,
        input.venueName ?? null,
        input.totalCapacity ?? null,
        input.linkedGameId ?? null,
        actor.personId,
      );

      // ─── Step 9: Athletic game linking ───
      // REVIEW-P2C12 ROUND 1 BLOCKING 3 — every athletic lookup is now
      // school-scoped. The linked game must resolve through
      // ath_games → ath_rosters → ath_seasons → ath_programmes.school_id
      // matching the current tenant before any comp population happens.
      // The 3 INSERT…SELECT fan-outs carry the same school-safe join
      // chain so a foreign-school game can never seed comp entries
      // into the current school's event. A School A admin who plants a
      // School B `ath_games.id` now sees zero comp rows added and a
      // WARN log line — the event itself still creates (DRAFT, no
      // tickets yet) so the operator can correct the linkedGameId or
      // unlink the game.
      //
      // Athletes resolve through sis_students.platform_student_id →
      // platform.platform_students.person_id. Coaches use the soft
      // coach_person_id directly. Officials use the soft FK to
      // platform.platform_official_profiles via the assignment row.
      if (input.eventType === 'ATHLETIC_GAME' && input.linkedGameId) {
        athleticEventCreated = true;

        // Resolve roster_id from ath_games — the JOIN through
        // ath_rosters → ath_seasons → ath_programmes pins the row to
        // the current school. On miss we WARN and skip comp
        // population so a stale or foreign-school linked_game_id
        // does not block the create.
        const gameRows = (await tx.$queryRawUnsafe(
          `SELECT g.roster_id::text AS roster_id
           FROM ath_games g
           JOIN ath_rosters ar ON ar.id = g.roster_id
           JOIN ath_seasons sn ON sn.id = ar.season_id
           JOIN ath_programmes pr ON pr.id = sn.programme_id
           WHERE g.id = $1::uuid AND pr.school_id = $2::uuid
           LIMIT 1`,
          input.linkedGameId,
          tenant.schoolId,
        )) as Array<{ roster_id: string }>;
        if (gameRows.length === 1) {
          const rosterId = gameRows[0]!.roster_id;
          // ATHLETE — active roster members. JOIN through ath_rosters
          // and sis_students.school_id (sis_students carries
          // school_id directly) so the comp row can never reference a
          // foreign-school student.
          const athleteRes = await tx.$executeRawUnsafe(
            `INSERT INTO evt_comp_lists (id, event_id, comp_type, person_id, added_by, notes)
             SELECT gen_random_uuid(), $1::uuid, 'ATHLETE', ps.person_id, $2::uuid,
                    'Auto-populated from ath_roster_members'
             FROM ath_roster_members rm
             JOIN ath_rosters ar2 ON ar2.id = rm.roster_id
             JOIN ath_seasons sn2 ON sn2.id = ar2.season_id
             JOIN ath_programmes pr2 ON pr2.id = sn2.programme_id
             JOIN sis_students s ON s.id = rm.student_id AND s.school_id = $4::uuid
             JOIN platform.platform_students ps ON ps.id = s.platform_student_id
             WHERE rm.roster_id = $3::uuid AND rm.removed_at IS NULL
               AND rm.eligibility_status = 'ELIGIBLE'
               AND pr2.school_id = $4::uuid
             ON CONFLICT ON CONSTRAINT evt_comp_uq DO NOTHING`,
            id,
            actor.personId,
            rosterId,
            tenant.schoolId,
          );
          compAddedCount += Number(athleteRes ?? 0);

          // COACH — active coaching assignments. JOIN through the
          // roster → season → programme chain so the school_id
          // predicate filters the rows even though
          // ath_coaching_assignments has no direct school_id column.
          const coachRes = await tx.$executeRawUnsafe(
            `INSERT INTO evt_comp_lists (id, event_id, comp_type, person_id, added_by, notes)
             SELECT gen_random_uuid(), $1::uuid, 'COACH', ca.coach_person_id, $2::uuid,
                    'Auto-populated from ath_coaching_assignments'
             FROM ath_coaching_assignments ca
             JOIN ath_rosters ar3 ON ar3.id = ca.roster_id
             JOIN ath_seasons sn3 ON sn3.id = ar3.season_id
             JOIN ath_programmes pr3 ON pr3.id = sn3.programme_id
             WHERE ca.roster_id = $3::uuid AND ca.is_active = true
               AND pr3.school_id = $4::uuid
             ON CONFLICT ON CONSTRAINT evt_comp_uq DO NOTHING`,
            id,
            actor.personId,
            rosterId,
            tenant.schoolId,
          );
          compAddedCount += Number(coachRes ?? 0);

          // OFFICIAL — assigned officials for the linked game. JOIN
          // through ath_games + the roster → season → programme chain
          // so the OFFICIAL comp row can never seed from a
          // foreign-school official assignment.
          const officialRes = await tx.$executeRawUnsafe(
            `INSERT INTO evt_comp_lists (id, event_id, comp_type, person_id, added_by, notes)
             SELECT gen_random_uuid(), $1::uuid, 'OFFICIAL', op.person_id, $2::uuid,
                    'Auto-populated from ath_official_assignments'
             FROM ath_official_assignments oa
             JOIN ath_games g2 ON g2.id = oa.game_id
             JOIN ath_rosters ar4 ON ar4.id = g2.roster_id
             JOIN ath_seasons sn4 ON sn4.id = ar4.season_id
             JOIN ath_programmes pr4 ON pr4.id = sn4.programme_id
             JOIN platform.platform_official_profiles op ON op.id = oa.official_profile_id
             WHERE oa.game_id = $3::uuid
               AND oa.status IN ('ACCEPTED', 'CONFIRMED', 'COMPLETED')
               AND pr4.school_id = $4::uuid
             ON CONFLICT ON CONSTRAINT evt_comp_uq DO NOTHING`,
            id,
            actor.personId,
            input.linkedGameId,
            tenant.schoolId,
          );
          compAddedCount += Number(officialRes ?? 0);
        } else {
          this.logger.warn(
            `[events] linked_game_id=${input.linkedGameId} did not resolve to an ath_games row in school ${tenant.schoolId} (or belongs to another school) — skipping comp auto-populate`,
          );
        }

        // REVIEW-P2C12 ROUND 1 BLOCKING 1 — evt.athletic_event.created
        // is durable. Enqueue inside the create tx so a Kafka outage
        // cannot drop the event awareness signal. We emit on every
        // athletic event create regardless of whether the linked game
        // resolved, because downstream consumers can choose to skip on
        // compEntriesAdded=0 — the awareness signal itself stays
        // durable.
        await this.outbox.enqueueInTx(tx, {
          topic: 'evt.athletic_event.created',
          key: id,
          sourceModule: 'events',
          eventId: deterministicAthleticEventCreatedEventId(id),
          payload: {
            eventId: id,
            schoolId: tenant.schoolId,
            linkedGameId: input.linkedGameId,
            compEntriesAdded: compAddedCount,
            createdAt: new Date().toISOString(),
            createdBy: actor.personId,
          },
        });
      }
    });
    // athleticEventCreated tracking is no longer used since the
    // outbox enqueue is the durable signal. Suppress unused-var.
    void athleticEventCreated;

    return this.getById(id, actor);
  }

  async patch(id: string, input: UpdateEventDto, actor: ResolvedActor): Promise<EventDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const currentRows = (await tx.$queryRawUnsafe(
        `SELECT status FROM evt_events
         WHERE id = $1::uuid AND school_id = $2::uuid
         FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (currentRows.length === 0) throw new NotFoundException('Event not found');
      const currentStatus = currentRows[0]!.status as EventStatus;

      if (input.status && input.status !== currentStatus) {
        const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];
        if (!allowed.includes(input.status)) {
          throw new BadRequestException(
            `Status transition ${currentStatus} → ${input.status} not allowed. Allowed: ${allowed.join(', ') || 'none'}.`,
          );
        }
      }

      const set: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.title !== undefined) {
        set.push(`title = $${i++}`);
        params.push(input.title);
      }
      if (input.description !== undefined) {
        set.push(`description = $${i++}`);
        params.push(input.description);
      }
      if (input.eventDate !== undefined) {
        set.push(`event_date = $${i++}::date`);
        params.push(input.eventDate);
      }
      if (input.startTime !== undefined) {
        set.push(`start_time = $${i++}::time`);
        params.push(input.startTime);
      }
      if (input.endTime !== undefined) {
        set.push(`end_time = $${i++}::time`);
        params.push(input.endTime);
      }
      if (input.venueName !== undefined) {
        set.push(`venue_name = $${i++}`);
        params.push(input.venueName);
      }
      if (input.totalCapacity !== undefined) {
        set.push(`total_capacity = $${i++}`);
        params.push(input.totalCapacity);
      }
      if (input.status !== undefined) {
        set.push(`status = $${i++}`);
        params.push(input.status);
      }
      if (set.length === 0) return;
      set.push(`updated_at = now()`);
      params.push(id, tenant.schoolId);
      await tx.$executeRawUnsafe(
        `UPDATE evt_events SET ${set.join(', ')} WHERE id = $${i++}::uuid AND school_id = $${i++}::uuid`,
        ...params,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Auto-flip an event to SOLD_OUT when every active tier reports
   * quantity_sold >= quantity. Called by OrderService.purchase after a
   * successful atomic sale. Idempotent: only flips ON_SALE → SOLD_OUT.
   */
  async maybeAutoFlipSoldOut(eventId: string): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const eventRows = (await tx.$queryRawUnsafe(
        `SELECT status FROM evt_events WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        eventId,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (eventRows.length === 0) return;
      if (eventRows[0]!.status !== 'ON_SALE') return;
      const remainingRows = (await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM evt_ticket_tiers
         WHERE event_id = $1::uuid AND is_active = true AND quantity_sold < quantity`,
        eventId,
      )) as Array<{ n: number }>;
      if (Number(remainingRows[0]!.n) === 0) {
        // REVIEW-P2C12 ROUND 1 MAJOR 1 — carry the school predicate
        // through the UPDATE as well as the lock, matching the Phase 2
        // hardening convention. The lock above already pins the row to
        // (id, school_id) so this is defence-in-depth.
        await tx.$executeRawUnsafe(
          `UPDATE evt_events SET status = 'SOLD_OUT', updated_at = now()
           WHERE id = $1::uuid AND school_id = $2::uuid`,
          eventId,
          tenant.schoolId,
        );
        this.logger.log(`[events] event ${eventId} auto-flipped ON_SALE -> SOLD_OUT`);
      }
    });
  }

  async complete(id: string, actor: ResolvedActor): Promise<EventDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    // REVIEW-P2C12 ROUND 1 BLOCKING 1 — evt.event.completed is now
    // durable. Enqueue the outbox row INSIDE the same tenant tx as the
    // status flip; the OutboxPublisherWorker handles the wire publish.
    // The deterministic event id keys on the event id so a redelivered
    // event silently dedups on the consumer side (GLConsumer dedups
    // via fin_journal_batches.source_event_id UNIQUE).
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE evt_events SET status = 'COMPLETED', updated_at = now()
         WHERE id = $1::uuid AND school_id = $2::uuid
           AND status IN ('ON_SALE', 'SOLD_OUT')
         RETURNING updated_at::text AS updated_at`,
        id,
        tenant.schoolId,
      )) as Array<{ updated_at: string }>;
      if (rows.length === 0) {
        throw new BadRequestException(
          'Event cannot be completed — must be ON_SALE or SOLD_OUT, and must belong to this school.',
        );
      }
      const completedAt = rows[0]!.updated_at;
      await this.outbox.enqueueInTx(tx, {
        topic: 'evt.event.completed',
        key: id,
        sourceModule: 'events',
        eventId: deterministicEventCompletedEventId(id),
        payload: {
          eventId: id,
          schoolId: tenant.schoolId,
          completedAt,
          completedBy: actor.personId,
        },
      });
    });
    return this.getById(id, actor);
  }
}

@Injectable()
export class TierService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly events: EventService,
  ) {
    // logger removed — TierService surfaces errors via thrown exceptions
  }

  async listForEvent(eventId: string): Promise<TierDto[]> {
    return this.events.loadTiers(eventId);
  }

  /**
   * Create a tier and maintain the parent event.total_tier_quantity
   * inside the same tenant tx so the evt_events_venue_capacity_chk
   * CHECK constraint can never be violated by a service-layer bug.
   * The tenant provisioner cannot host a DB trigger because the SQL
   * splitter cuts on every semicolon, so the service is the single
   * writer responsible for maintaining the denormalised total.
   */
  async create(eventId: string, input: CreateTierDto, actor: ResolvedActor): Promise<TierDto> {
    await this.events.assertWriter(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock parent event so the tier total maintenance is consistent
      const eventRows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status FROM evt_events
         WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        eventId,
        tenant.schoolId,
      )) as Array<{ id: string; status: string }>;
      if (eventRows.length === 0) throw new NotFoundException('Event not found');
      if (eventRows[0]!.status === 'COMPLETED' || eventRows[0]!.status === 'CANCELLED') {
        throw new BadRequestException('Cannot add tiers to a COMPLETED or CANCELLED event.');
      }
      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO evt_ticket_tiers
           (id, event_id, name, price, quantity, sale_starts_at, sale_ends_at, is_active)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8)`,
          id,
          eventId,
          input.name,
          input.price,
          input.quantity,
          input.saleStartsAt ?? null,
          input.saleEndsAt ?? null,
          input.isActive ?? true,
        );
        // Recompute event.total_tier_quantity = SUM(quantity) within same tx
        await tx.$executeRawUnsafe(
          `UPDATE evt_events SET total_tier_quantity = (
             SELECT COALESCE(SUM(quantity), 0)::int FROM evt_ticket_tiers WHERE event_id = $1::uuid
           ), updated_at = now() WHERE id = $1::uuid`,
          eventId,
        );
      } catch (e: unknown) {
        const msg = String((e as Error).message ?? e);
        if (msg.includes('evt_events_venue_capacity_chk')) {
          throw new ConflictException(
            'Adding this tier would push total tier quantity past the event capacity.',
          );
        }
        throw e;
      }
    });
    const rows = await this.events.loadTiers(eventId);
    const created = rows.find((r) => r.id === id);
    if (!created) throw new NotFoundException('Tier creation failed');
    return created;
  }

  async patch(tierId: string, input: UpdateTierDto, actor: ResolvedActor): Promise<TierDto> {
    await this.events.assertWriter(actor);
    const tenant = getCurrentTenant();
    let eventId = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT t.event_id::text AS event_id, t.quantity_sold
         FROM evt_ticket_tiers t
         JOIN evt_events e ON e.id = t.event_id
         WHERE t.id = $1::uuid AND e.school_id = $2::uuid
         FOR UPDATE OF t`,
        tierId,
        tenant.schoolId,
      )) as Array<{ event_id: string; quantity_sold: number }>;
      if (rows.length === 0) throw new NotFoundException('Tier not found');
      eventId = rows[0]!.event_id;
      const sold = Number(rows[0]!.quantity_sold);
      if (input.quantity !== undefined && input.quantity < sold) {
        throw new BadRequestException(
          `Cannot reduce quantity below tickets already sold (${sold}).`,
        );
      }
      const set: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.name !== undefined) {
        set.push(`name = $${i++}`);
        params.push(input.name);
      }
      if (input.price !== undefined) {
        set.push(`price = $${i++}`);
        params.push(input.price);
      }
      if (input.quantity !== undefined) {
        set.push(`quantity = $${i++}`);
        params.push(input.quantity);
      }
      if (input.saleStartsAt !== undefined) {
        set.push(`sale_starts_at = $${i++}::timestamptz`);
        params.push(input.saleStartsAt);
      }
      if (input.saleEndsAt !== undefined) {
        set.push(`sale_ends_at = $${i++}::timestamptz`);
        params.push(input.saleEndsAt);
      }
      if (input.isActive !== undefined) {
        set.push(`is_active = $${i++}`);
        params.push(input.isActive);
      }
      if (set.length > 0) {
        set.push(`updated_at = now()`);
        params.push(tierId);
        try {
          await tx.$executeRawUnsafe(
            `UPDATE evt_ticket_tiers SET ${set.join(', ')} WHERE id = $${i++}::uuid`,
            ...params,
          );
          if (input.quantity !== undefined) {
            await tx.$executeRawUnsafe(
              `UPDATE evt_events SET total_tier_quantity = (
                 SELECT COALESCE(SUM(quantity), 0)::int FROM evt_ticket_tiers WHERE event_id = $1::uuid
               ), updated_at = now() WHERE id = $1::uuid`,
              eventId,
            );
          }
        } catch (e: unknown) {
          const msg = String((e as Error).message ?? e);
          if (msg.includes('evt_events_venue_capacity_chk')) {
            throw new ConflictException(
              'Updating this tier would push total tier quantity past the event capacity.',
            );
          }
          throw e;
        }
      }
    });
    const rows = await this.events.loadTiers(eventId);
    const updated = rows.find((r) => r.id === tierId);
    if (!updated) throw new NotFoundException('Tier not found after update');
    return updated;
  }
}
