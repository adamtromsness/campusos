import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import type {
  AddCompEntryDto,
  CompCheckDto,
  CompCheckResultDto,
  CompEntryDto,
  CompType,
  CreateSeasonPassDto,
  CreateVolunteerDto,
  GateScanDto,
  GateScanResultDto,
  PassStatus,
  ScanResult,
  SeasonPassDto,
  SeasonPassGateCheckDto,
  SeasonPassGateCheckResultDto,
  UpdateVolunteerDto,
  VolunteerDto,
  VolunteerStatus,
} from './dto/events.dto';

interface SeasonPassRow {
  id: string;
  school_id: string;
  person_id: string;
  person_name: string | null;
  pass_type: string;
  events_included: string[] | null;
  price: string | number;
  purchased_at: string | null;
  stripe_payment_intent_id: string | null;
  status: string;
  academic_year: string;
  notes: string | null;
}

interface CompRow {
  id: string;
  event_id: string;
  comp_type: string;
  person_id: string;
  person_name: string | null;
  notes: string | null;
  added_by: string;
  added_by_name: string | null;
  added_at: string;
}

interface VolunteerRow {
  id: string;
  event_id: string;
  person_id: string;
  person_name: string | null;
  role: string | null;
  status: string;
  check_in_at: string | null;
  notes: string | null;
}

@Injectable()
export class GateScanService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async assertScanner(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'evt-001:write',
      'evt-001:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Gate scanning requires evt-001:write or admin scope.');
    }
  }

  /**
   * THE ATOMIC GATE SCAN KEYSTONE.
   *
   * Single UPDATE inside the tenant tx:
   *
   *   UPDATE evt_tickets SET status='USED', scanned_at=now()
   *   WHERE qr_code_token=$1 AND status='VALID' RETURNING id, tier_id, order_id, holder_name
   *
   * If RETURNING comes back empty, the ticket is either already
   * USED, CANCELLED, REFUNDED, or the token does not exist at all.
   * We distinguish ALREADY_SCANNED from INVALID by a follow-up
   * read against the same token. Either way, we log every attempt
   * to evt_ticket_scans for the gate audit trail.
   */
  async scan(input: GateScanDto, actor: ResolvedActor): Promise<GateScanResultDto> {
    await this.assertScanner(actor);
    const tenant = getCurrentTenant();
    const scannedAt = new Date().toISOString();
    let result: GateScanResultDto | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const updateRows = (await tx.$queryRawUnsafe(
        `UPDATE evt_tickets t
         SET status = 'USED', scanned_at = now(), updated_at = now()
         FROM evt_orders o JOIN evt_events e ON e.id = o.event_id
         WHERE t.order_id = o.id AND e.school_id = $1::uuid
           AND t.qr_code_token = $2 AND t.status = 'VALID'
         RETURNING t.id::text AS id, t.tier_id::text AS tier_id, t.holder_name,
                   e.id::text AS event_id, e.title AS event_title`,
        tenant.schoolId,
        input.qrCodeToken,
      )) as Array<{
        id: string;
        tier_id: string;
        holder_name: string | null;
        event_id: string;
        event_title: string;
      }>;
      let scanResult: ScanResult;
      let ticketId: string | null = null;
      let eventId: string | null = null;
      let eventTitle: string | null = null;
      let holderName: string | null = null;
      let tierName: string | null = null;
      let message: string;

      if (updateRows.length === 1) {
        const row = updateRows[0]!;
        scanResult = 'VALID';
        ticketId = row.id;
        eventId = row.event_id;
        eventTitle = row.event_title;
        holderName = row.holder_name;
        const tierRows = (await tx.$queryRawUnsafe(
          `SELECT name FROM evt_ticket_tiers WHERE id = $1::uuid`,
          row.tier_id,
        )) as Array<{ name: string }>;
        tierName = tierRows[0]?.name ?? null;
        message = 'Admit';
      } else {
        // 0 rows — either already scanned, or invalid token.
        const lookupRows = (await tx.$queryRawUnsafe(
          `SELECT t.id::text AS id, t.status, t.holder_name,
                  t.scanned_at::text AS scanned_at,
                  e.id::text AS event_id, e.title AS event_title
           FROM evt_tickets t
           JOIN evt_orders o ON o.id = t.order_id
           JOIN evt_events e ON e.id = o.event_id
           WHERE t.qr_code_token = $1 AND e.school_id = $2::uuid LIMIT 1`,
          input.qrCodeToken,
          tenant.schoolId,
        )) as Array<{
          id: string;
          status: string;
          holder_name: string | null;
          scanned_at: string | null;
          event_id: string;
          event_title: string;
        }>;
        if (lookupRows.length === 0) {
          scanResult = 'INVALID';
          message = 'Unknown ticket token.';
        } else {
          const found = lookupRows[0]!;
          ticketId = found.id;
          eventId = found.event_id;
          eventTitle = found.event_title;
          holderName = found.holder_name;
          if (found.status === 'USED') {
            scanResult = 'ALREADY_SCANNED';
            message = `Already scanned at ${found.scanned_at ?? 'unknown time'}.`;
          } else if (found.status === 'CANCELLED' || found.status === 'REFUNDED') {
            scanResult = 'EXPIRED';
            message = `Ticket is ${found.status}.`;
          } else {
            scanResult = 'INVALID';
            message = `Ticket status is ${found.status}.`;
          }
        }
      }

      // Always log the scan attempt — gate audit trail
      await tx.$executeRawUnsafe(
        `INSERT INTO evt_ticket_scans
         (id, ticket_id, qr_code_token, event_id, scanned_at, scanned_by, scan_result, scan_source)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now(), $5::uuid, $6, $7)`,
        generateId(),
        ticketId,
        input.qrCodeToken,
        eventId ?? input.eventId ?? null,
        actor.personId,
        scanResult,
        input.scanSource ?? null,
      );

      result = {
        scanResult,
        ticketId,
        holderName,
        tierName,
        eventTitle,
        scannedAt,
        message,
      };
    });
    if (!result) throw new Error('Gate scan: tx completed without result');
    return result;
  }
}

@Injectable()
export class SeasonPassService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
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

  private rowToDto(r: SeasonPassRow): SeasonPassDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      personId: r.person_id,
      personName: r.person_name,
      passType: r.pass_type,
      eventsIncluded: r.events_included,
      price: Number(r.price),
      purchasedAt: r.purchased_at,
      stripePaymentIntentId: r.stripe_payment_intent_id,
      status: r.status as PassStatus,
      academicYear: r.academic_year,
      notes: r.notes,
    };
  }

  async listForActor(actor: ResolvedActor): Promise<SeasonPassDto[]> {
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (!writer) {
      where.push(`person_id = $2::uuid`);
      params.push(actor.personId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, person_id::text AS person_id,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = person_id) AS person_name,
                pass_type, events_included::text[] AS events_included, price,
                purchased_at::text AS purchased_at, stripe_payment_intent_id, status, academic_year, notes
         FROM evt_season_passes WHERE ${where.join(' AND ')}
         ORDER BY purchased_at DESC NULLS LAST, id`,
        ...params,
      );
    })) as SeasonPassRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async create(input: CreateSeasonPassDto, actor: ResolvedActor): Promise<SeasonPassDto> {
    // A parent or staff can purchase a season pass for themselves or
    // their dependants. The Stripe step is stubbed in this cycle.
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    if (!writer && input.personId !== actor.personId) {
      throw new ForbiddenException(
        'Only admins or staff with evt-001:write can purchase a season pass on behalf of another person.',
      );
    }
    const id = generateId();
    const stripeIntent =
      input.stripePaymentIntentId ?? `pi_dev_evt_pass_${id.replace(/-/g, '').slice(0, 16)}`;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO evt_season_passes
         (id, school_id, person_id, pass_type, events_included, price, purchased_at,
          stripe_payment_intent_id, status, academic_year, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid[], $6, now(), $7, 'ACTIVE', $8, $9)`,
        id,
        tenant.schoolId,
        input.personId,
        input.passType,
        input.eventsIncluded ?? null,
        input.price,
        stripeIntent,
        input.academicYear,
        input.notes ?? null,
      );
    });
    const all = await this.listForActor(actor);
    const created = all.find((p) => p.id === id);
    if (!created) throw new NotFoundException('Season pass creation failed');
    return created;
  }

  async revoke(id: string, actor: ResolvedActor): Promise<SeasonPassDto> {
    const writer = await this.isWriter(actor);
    if (!writer) throw new ForbiddenException('Revoking a season pass is admin-only.');
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        `UPDATE evt_season_passes SET status = 'REVOKED', updated_at = now()
         WHERE id = $1::uuid AND school_id = $2::uuid AND status = 'ACTIVE'`,
        id,
        tenant.schoolId,
      );
    })) as number;
    if (rows === 0) {
      throw new BadRequestException('Pass already revoked or not found.');
    }
    const list = await this.listForActor(actor);
    const found = list.find((p) => p.id === id);
    if (!found) throw new NotFoundException('Pass not found after revoke');
    return found;
  }

  /**
   * Gate check at the venue: pass must be ACTIVE plus the target
   * event must (a) belong to the current school, (b) be in a live
   * status (ON_SALE/SOLD_OUT/COMPLETED), and (c) either appear in
   * the pass's events_included array OR match the pass's coverage
   * policy when events_included IS NULL (school-wide pass for the
   * matching academic year; PERFORMANCE/ATHLETIC/etc passes implicitly
   * cover their corresponding event_type for the year).
   *
   * REVIEW-P2C12 ROUND 1 BLOCKING 4 — the previous implementation
   * admitted any eventId when events_included IS NULL, which meant a
   * School A scanner could submit a foreign-school event UUID with a
   * valid School A pass and get admit=true. We now JOIN evt_events
   * with the tenant school predicate so a foreign or non-existent
   * eventId always denies. The academic-year overlap is enforced by
   * comparing the event_date year to the pass.academic_year window
   * (a "2025-2026" pass admits events 2025-08-01 → 2026-07-31).
   *
   * The GateScanService remains the gate-audit owner — this method
   * returns { admitted, reason } only and does not write a scan row
   * itself.
   */
  async gateCheck(
    input: SeasonPassGateCheckDto,
    actor: ResolvedActor,
  ): Promise<SeasonPassGateCheckResultDto> {
    if (!(await this.isWriter(actor))) {
      throw new ForbiddenException('Season pass gate check requires evt-001:write or admin scope.');
    }
    const tenant = getCurrentTenant();
    const passRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT status, events_included::text[] AS events_included,
                pass_type, academic_year
         FROM evt_season_passes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        input.passId,
        tenant.schoolId,
      );
    })) as Array<{
      status: string;
      events_included: string[] | null;
      pass_type: string;
      academic_year: string;
    }>;
    if (passRows.length === 0) {
      return { admitted: false, reason: 'Pass not found' };
    }
    const pass = passRows[0]!;
    if (pass.status !== 'ACTIVE') {
      return { admitted: false, reason: `Pass status is ${pass.status}` };
    }

    // REVIEW-P2C12 ROUND 1 BLOCKING 4 — validate the target event is
    // in the current school. School A scanner cannot admit a pass
    // against a School B event UUID. The status filter also gates out
    // DRAFT / CANCELLED events from admission attempts.
    const eventRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, event_type, event_date::text AS event_date, status
         FROM evt_events
         WHERE id = $1::uuid AND school_id = $2::uuid
           AND status IN ('ON_SALE', 'SOLD_OUT', 'COMPLETED')
         LIMIT 1`,
        input.eventId,
        tenant.schoolId,
      );
    })) as Array<{ id: string; event_type: string; event_date: string; status: string }>;
    if (eventRows.length === 0) {
      return { admitted: false, reason: 'Event not found in this school' };
    }
    const event = eventRows[0]!;

    // Explicit list: must include the event id.
    if (pass.events_included && pass.events_included.length > 0) {
      if (!pass.events_included.includes(input.eventId)) {
        return { admitted: false, reason: 'This event is not in the pass coverage list' };
      }
    } else {
      // events_included IS NULL — pass covers all events of its
      // pass_type for the academic year. Validate the event_date
      // falls inside the pass's academic_year window (e.g.
      // 2025-2026 → 2025-08-01 to 2026-07-31).
      const yearMatch = /^(\d{4})-(\d{4})$/.exec(pass.academic_year);
      if (!yearMatch) {
        return {
          admitted: false,
          reason: `Pass academic_year shape "${pass.academic_year}" is malformed`,
        };
      }
      const yearStart = `${yearMatch[1]}-08-01`;
      const yearEnd = `${yearMatch[2]}-07-31`;
      if (event.event_date < yearStart || event.event_date > yearEnd) {
        return {
          admitted: false,
          reason: `Event date ${event.event_date} falls outside the ${pass.academic_year} pass window`,
        };
      }

      // pass_type → event_type coverage. The pass_type is free-text
      // so the matching is heuristic — strings containing 'ATHLETIC'
      // or 'SPORTS' admit ATHLETIC_GAME; 'THEATRE' or 'PERFORMANCE'
      // admit PERFORMANCE; 'ALL' admits any event_type. Unknown
      // pass_type values restrict to the literal match (uppercase
      // form against event_type). Schools can author custom
      // pass_types and they default to deny-unless-matching-name.
      const passTypeUpper = pass.pass_type.toUpperCase();
      const passCovers = (eventType: string): boolean => {
        // Sport-specific qualifier wins first so "All Sports" / "All
        // Athletic Events" pins to ATHLETIC_GAME, not to every type.
        if (passTypeUpper.includes('ATHLETIC') || passTypeUpper.includes('SPORTS')) {
          return eventType === 'ATHLETIC_GAME';
        }
        if (
          passTypeUpper.includes('THEATRE') ||
          passTypeUpper.includes('PERFORMANCE') ||
          passTypeUpper.includes('ARTS')
        ) {
          return eventType === 'PERFORMANCE';
        }
        if (passTypeUpper.includes('DANCE')) return eventType === 'DANCE';
        if (passTypeUpper.includes('FUNDRAISER')) return eventType === 'FUNDRAISER';
        // Universal coverage only when the pass_type explicitly says
        // "ALL EVENTS" / "ALL ACCESS" / "EVERY EVENT". A bare "ALL"
        // matches nothing — too ambiguous to admit cross-category.
        if (
          passTypeUpper.includes('ALL EVENTS') ||
          passTypeUpper.includes('ALL ACCESS') ||
          passTypeUpper.includes('EVERY EVENT')
        ) {
          return true;
        }
        // Literal match against the canonical event_type token.
        if (passTypeUpper === eventType) return true;
        return false;
      };
      if (!passCovers(event.event_type)) {
        return {
          admitted: false,
          reason: `Pass type "${pass.pass_type}" does not cover ${event.event_type} events`,
        };
      }
    }
    return { admitted: true, reason: 'Admit' };
  }
}

@Injectable()
export class CompListService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async assertWriter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'evt-001:write',
      'evt-001:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Comp list edit requires evt-001:write or admin scope.');
    }
  }

  private rowToDto(r: CompRow): CompEntryDto {
    return {
      id: r.id,
      eventId: r.event_id,
      compType: r.comp_type as CompType,
      personId: r.person_id,
      personName: r.person_name,
      notes: r.notes,
      addedBy: r.added_by,
      addedByName: r.added_by_name,
      addedAt: r.added_at,
    };
  }

  async listForEvent(eventId: string, actor: ResolvedActor): Promise<CompEntryDto[]> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT c.id::text AS id, c.event_id::text AS event_id, c.comp_type,
                c.person_id::text AS person_id,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = c.person_id) AS person_name,
                c.notes, c.added_by::text AS added_by,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = c.added_by) AS added_by_name,
                c.added_at::text AS added_at
         FROM evt_comp_lists c
         JOIN evt_events e ON e.id = c.event_id
         WHERE c.event_id = $1::uuid AND e.school_id = $2::uuid
         ORDER BY c.added_at DESC`,
        eventId,
        tenant.schoolId,
      );
    })) as CompRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * REVIEW-P2C12 ROUND 1 BLOCKING 5 — validate the supplied
   * personId is affiliated with the current school per the requested
   * comp_type. Without this an admin could pass any platform.iam_person
   * UUID and insert a foreign-school person onto the comp list — the
   * migration COMMENT promised request-path validation but the
   * service did not perform it.
   *
   * Resolution rules:
   *   - STUDENT / ATHLETE → sis_students.platform_student_id →
   *                        platform.platform_students.person_id =
   *                        input.personId AND sis_students.school_id =
   *                        $tenant.schoolId
   *   - STAFF / COACH    → hr_employees.person_id = input.personId
   *                        AND hr_employees.school_id =
   *                        $tenant.schoolId
   *   - OFFICIAL         → platform.platform_official_profiles.person_id =
   *                        input.personId (platform-tier records are
   *                        cross-school by design per ADR-063; the
   *                        comp entry's event ownership predicate is
   *                        the school-side gate)
   *   - MEDIA / VIP /
   *     OTHER            → require ANY current-tenant projection
   *                        (sis_students OR sis_guardians OR
   *                        hr_employees) so a comp pass for an external
   *                        guest at least has a tenant footprint
   *
   * Throws BadRequestException on miss with a friendly message.
   */
  private async assertCompPersonAffiliated(
    client: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    personId: string,
    compType: CompType,
    schoolId: string,
  ): Promise<void> {
    let rows: Array<{ ok: number }>;
    if (compType === 'STUDENT' || compType === 'ATHLETE') {
      rows = (await client.$queryRawUnsafe(
        `SELECT 1 AS ok FROM sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1`,
        personId,
        schoolId,
      )) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new BadRequestException(
          `personId does not match a ${compType.toLowerCase()} enrolled at this school`,
        );
      }
      return;
    }
    if (compType === 'STAFF' || compType === 'COACH') {
      rows = (await client.$queryRawUnsafe(
        `SELECT 1 AS ok FROM hr_employees
         WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        personId,
        schoolId,
      )) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new BadRequestException(`personId does not match an employee of this school`);
      }
      return;
    }
    if (compType === 'OFFICIAL') {
      rows = (await client.$queryRawUnsafe(
        `SELECT 1 AS ok FROM platform.platform_official_profiles
         WHERE person_id = $1::uuid LIMIT 1`,
        personId,
      )) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new BadRequestException(`personId does not match a platform official profile`);
      }
      return;
    }
    // MEDIA / VIP / OTHER — require ANY current-tenant footprint so
    // an external guest still has to be reachable through this school.
    rows = (await client.$queryRawUnsafe(
      `SELECT 1 AS ok FROM (
         SELECT person_id::text AS person_id, school_id::text AS school_id FROM hr_employees
         UNION ALL
         SELECT ps.person_id::text AS person_id, s.school_id::text AS school_id
           FROM sis_students s
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         UNION ALL
         SELECT person_id::text AS person_id, school_id::text AS school_id FROM sis_guardians
       ) p
       WHERE p.person_id = $1::uuid AND p.school_id = $2::uuid LIMIT 1`,
      personId,
      schoolId,
    )) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `personId is not affiliated with this school (must have a sis_students, sis_guardians, or hr_employees projection)`,
      );
    }
  }

  async add(eventId: string, input: AddCompEntryDto, actor: ResolvedActor): Promise<CompEntryDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        // Validate event ownership
        const eventRows = (await client.$queryRawUnsafe(
          `SELECT id FROM evt_events WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
          eventId,
          tenant.schoolId,
        )) as Array<{ id: string }>;
        if (eventRows.length === 0) throw new NotFoundException('Event not found');

        // REVIEW-P2C12 ROUND 1 BLOCKING 5 — validate the supplied
        // personId against the current tenant's affiliated population
        // per the comp_type. School A admin cannot drop a School B
        // person onto a School A event's comp list.
        await this.assertCompPersonAffiliated(
          client,
          input.personId,
          input.compType,
          tenant.schoolId,
        );

        await client.$executeRawUnsafe(
          `INSERT INTO evt_comp_lists (id, event_id, comp_type, person_id, notes, added_by)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::uuid)`,
          id,
          eventId,
          input.compType,
          input.personId,
          input.notes ?? null,
          actor.personId,
        );
      });
    } catch (e: unknown) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes('evt_comp_uq')) {
        throw new ConflictException(
          'This person is already on the comp list under the same comp type.',
        );
      }
      throw e;
    }
    const list = await this.listForEvent(eventId, actor);
    const found = list.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Comp entry not found after insert');
    return found;
  }

  async remove(eventId: string, entryId: string, actor: ResolvedActor): Promise<void> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const removed = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        `DELETE FROM evt_comp_lists c USING evt_events e
         WHERE c.event_id = e.id AND c.id = $1::uuid
           AND c.event_id = $2::uuid AND e.school_id = $3::uuid`,
        entryId,
        eventId,
        tenant.schoolId,
      );
    })) as number;
    if (removed === 0) throw new NotFoundException('Comp entry not found');
  }

  /**
   * Gate check for comp entry. Returns admitted=true if the (event,
   * person) pair exists under any comp_type, else false.
   */
  async gateCheck(input: CompCheckDto, actor: ResolvedActor): Promise<CompCheckResultDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT c.comp_type,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = c.person_id) AS person_name
         FROM evt_comp_lists c
         JOIN evt_events e ON e.id = c.event_id
         WHERE c.event_id = $1::uuid AND c.person_id = $2::uuid AND e.school_id = $3::uuid
         LIMIT 1`,
        input.eventId,
        input.personId,
        tenant.schoolId,
      );
    })) as Array<{ comp_type: string; person_name: string | null }>;
    if (rows.length === 0) {
      return { admitted: false, compType: null, personName: null };
    }
    return {
      admitted: true,
      compType: rows[0]!.comp_type as CompType,
      personName: rows[0]!.person_name,
    };
  }
}

@Injectable()
export class VolunteerService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
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

  private rowToDto(r: VolunteerRow): VolunteerDto {
    return {
      id: r.id,
      eventId: r.event_id,
      personId: r.person_id,
      personName: r.person_name,
      role: r.role,
      status: r.status as VolunteerStatus,
      checkInAt: r.check_in_at,
      notes: r.notes,
    };
  }

  async listForEvent(eventId: string): Promise<VolunteerDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT v.id::text AS id, v.event_id::text AS event_id, v.person_id::text AS person_id,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = v.person_id) AS person_name,
                v.role, v.status, v.check_in_at::text AS check_in_at, v.notes
         FROM evt_volunteers v
         JOIN evt_events e ON e.id = v.event_id
         WHERE v.event_id = $1::uuid AND e.school_id = $2::uuid
         ORDER BY v.created_at ASC`,
        eventId,
        tenant.schoolId,
      );
    })) as VolunteerRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Volunteer sign-up. Self-service for any authenticated person.
   * Admin can sign someone else up by supplying a different personId;
   * non-admin actors must sign themselves up.
   */
  async signUp(
    eventId: string,
    input: CreateVolunteerDto,
    actor: ResolvedActor,
  ): Promise<VolunteerDto> {
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    if (!writer && input.personId !== actor.personId) {
      throw new ForbiddenException('You can only sign yourself up as a volunteer.');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        const eventRows = (await client.$queryRawUnsafe(
          `SELECT id FROM evt_events WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
          eventId,
          tenant.schoolId,
        )) as Array<{ id: string }>;
        if (eventRows.length === 0) throw new NotFoundException('Event not found');
        await client.$executeRawUnsafe(
          `INSERT INTO evt_volunteers (id, event_id, person_id, role, status, notes)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'SIGNED_UP', $5)`,
          id,
          eventId,
          input.personId,
          input.role ?? null,
          input.notes ?? null,
        );
      });
    } catch (e: unknown) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes('evt_vol_uq')) {
        throw new ConflictException('This person is already signed up for this event.');
      }
      throw e;
    }
    const list = await this.listForEvent(eventId);
    const found = list.find((v) => v.id === id);
    if (!found) throw new NotFoundException('Volunteer not found after insert');
    return found;
  }

  async patch(
    volunteerId: string,
    input: UpdateVolunteerDto,
    actor: ResolvedActor,
  ): Promise<VolunteerDto> {
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    let eventId = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT v.event_id::text AS event_id, v.person_id::text AS person_id, v.status
         FROM evt_volunteers v JOIN evt_events e ON e.id = v.event_id
         WHERE v.id = $1::uuid AND e.school_id = $2::uuid FOR UPDATE OF v`,
        volunteerId,
        tenant.schoolId,
      )) as Array<{ event_id: string; person_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Volunteer not found');
      eventId = rows[0]!.event_id;
      const personId = rows[0]!.person_id;
      // Non-writers can only cancel their own sign-up. Status changes
      // to CONFIRMED or check-in are admin/staff-side actions.
      if (!writer && personId !== actor.personId) {
        throw new ForbiddenException('You can only update your own volunteer sign-up.');
      }
      if (!writer && input.status && input.status !== 'CANCELLED') {
        throw new ForbiddenException('Non-admin volunteers can only cancel their own sign-up.');
      }
      const set: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.status !== undefined) {
        set.push(`status = $${i++}`);
        params.push(input.status);
      }
      if (input.role !== undefined) {
        set.push(`role = $${i++}`);
        params.push(input.role);
      }
      if (input.checkIn) {
        set.push(`check_in_at = now()`);
      }
      if (set.length > 0) {
        set.push(`updated_at = now()`);
        params.push(volunteerId);
        await tx.$executeRawUnsafe(
          `UPDATE evt_volunteers SET ${set.join(', ')} WHERE id = $${i++}::uuid`,
          ...params,
        );
      }
    });
    const list = await this.listForEvent(eventId);
    const found = list.find((v) => v.id === volunteerId);
    if (!found) throw new NotFoundException('Volunteer vanished after patch');
    return found;
  }
}
