import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { hasAdminScope } from './access';
import {
  AlumniEventDto,
  AlumniNewsDto,
  CreateAlumniEventDto,
  CreateAlumniNewsDto,
  CreateReunionGroupDto,
  NewsCategory,
  ReunionGroupDto,
  ReunionStatus,
  UpdateAlumniEventDto,
  UpdateAlumniNewsDto,
  UpdateReunionGroupDto,
} from './dto/alumni.dto';

interface NewsRow {
  id: string;
  school_id: string;
  author_id: string;
  author_name: string | null;
  title: string;
  body: string;
  category: string;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function newsRowToDto(r: NewsRow): AlumniNewsDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    authorId: r.author_id,
    authorName: r.author_name,
    title: r.title,
    body: r.body,
    category: r.category as NewsCategory,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_NEWS_BASE =
  `SELECT n.id::text AS id, n.school_id::text AS school_id, n.author_id::text AS author_id, ` +
  `(ip.first_name || ' ' || ip.last_name) AS author_name, n.title, n.body, n.category, ` +
  `n.published_at, n.created_at, n.updated_at ` +
  `FROM alm_alumni_news n LEFT JOIN platform.iam_person ip ON ip.id = n.author_id `;

@Injectable()
export class AlumniNewsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /** List news. Non-staff readers see published only, newest-first. */
  async list(
    actor: ResolvedActor,
    filters: { category?: NewsCategory; includeDrafts?: boolean } = {},
  ): Promise<AlumniNewsDto[]> {
    const tenant = getCurrentTenant();
    const isStaff = await hasAdminScope(this.permCheck, actor);
    const where: string[] = ['n.school_id = $1::uuid'];
    const args: unknown[] = [tenant.schoolId];
    if (!isStaff || !filters.includeDrafts) {
      where.push('n.published_at IS NOT NULL');
    }
    if (filters.category !== undefined) {
      where.push(`n.category = $${args.length + 1}`);
      args.push(filters.category);
    }
    const sql =
      SELECT_NEWS_BASE +
      'WHERE ' +
      where.join(' AND ') +
      ' ORDER BY COALESCE(n.published_at, n.created_at) DESC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as NewsRow[];
    return rows.map(newsRowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<AlumniNewsDto> {
    const tenant = getCurrentTenant();
    const isStaff = await hasAdminScope(this.permCheck, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_NEWS_BASE + 'WHERE n.id = $1::uuid AND n.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as NewsRow[];
    if (rows.length === 0) {
      throw new NotFoundException('News article not found');
    }
    if (!isStaff && rows[0]!.published_at === null) {
      throw new NotFoundException('News article not found');
    }
    return newsRowToDto(rows[0]!);
  }

  async create(input: CreateAlumniNewsDto, actor: ResolvedActor): Promise<AlumniNewsDto> {
    if (!(await hasAdminScope(this.permCheck, actor))) {
      throw new ForbiddenException('News management requires staff or admin scope');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    const publishStamp = input.publish === true ? 'now()' : 'NULL';
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO alm_alumni_news (id, school_id, author_id, title, body, category, published_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, ${publishStamp})`,
        id,
        tenant.schoolId,
        actor.personId,
        input.title,
        input.body,
        input.category,
      );
    });
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateAlumniNewsDto,
    actor: ResolvedActor,
  ): Promise<AlumniNewsDto> {
    if (!(await hasAdminScope(this.permCheck, actor))) {
      throw new ForbiddenException('News management requires staff or admin scope');
    }
    const tenant = getCurrentTenant();
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [];
    let i = 1;
    const add = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      args.push(val);
    };
    if (input.title !== undefined) add('title', input.title);
    if (input.body !== undefined) add('body', input.body);
    if (input.category !== undefined) add('category', input.category);
    if (input.publish === true) sets.push('published_at = COALESCE(published_at, now())');
    if (input.publish === false) sets.push('published_at = NULL');
    args.push(id);
    args.push(tenant.schoolId);
    // REVIEW-P2C22 BLOCKING 4 — every UPDATE carries the school
    // predicate so a stray cross-school UUID cannot mutate a sister
    // school's news article. The pre-flight getById in this method
    // already enforces school scope at read time; the predicate here
    // is defence-in-depth.
    const sql = `UPDATE alm_alumni_news SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(sql, ...args);
    });
    return this.getById(id, actor);
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    if (!(await hasAdminScope(this.permCheck, actor))) {
      throw new ForbiddenException('News management requires staff or admin scope');
    }
    const tenant = getCurrentTenant();
    // REVIEW-P2C22 BLOCKING 4 — DELETE carries the school predicate
    // so cross-school UUIDs cannot land here. Zero-row result raises
    // 404 (collapses "not found" + "not yours" to don't-leak-existence).
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM alm_alumni_news WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as unknown;
    if (typeof rows === 'number' && rows === 0) {
      throw new NotFoundException('News article not found');
    }
  }
}

interface ReunionRow {
  id: string;
  school_id: string;
  graduation_year: number;
  name: string;
  organiser_id: string;
  organiser_name: string | null;
  event_date: Date | null;
  rsvp_deadline: Date | null;
  status: string;
  description: string | null;
  venue: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_REUNION_BASE =
  `SELECT r.id::text AS id, r.school_id::text AS school_id, r.graduation_year, r.name, ` +
  `r.organiser_id::text AS organiser_id, ` +
  `(ip.first_name || ' ' || ip.last_name) AS organiser_name, ` +
  `r.event_date, r.rsvp_deadline, r.status, r.description, r.venue, r.created_at, r.updated_at ` +
  `FROM alm_reunion_groups r ` +
  `LEFT JOIN alm_alumni_profiles p ON p.id = r.organiser_id ` +
  `LEFT JOIN platform.iam_person ip ON ip.id = p.person_id `;

function reunionRowToDto(r: ReunionRow): ReunionGroupDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    graduationYear: r.graduation_year,
    name: r.name,
    organiserId: r.organiser_id,
    organiserName: r.organiser_name,
    eventDate: r.event_date ? r.event_date.toISOString().slice(0, 10) : null,
    rsvpDeadline: r.rsvp_deadline ? r.rsvp_deadline.toISOString().slice(0, 10) : null,
    status: r.status as ReunionStatus,
    description: r.description,
    venue: r.venue,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class ReunionGroupService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(
    _actor: ResolvedActor,
    filters: { graduationYear?: number; status?: ReunionStatus } = {},
  ): Promise<ReunionGroupDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['r.school_id = $1::uuid'];
    const args: unknown[] = [tenant.schoolId];
    if (filters.graduationYear !== undefined) {
      where.push(`r.graduation_year = $${args.length + 1}::int`);
      args.push(filters.graduationYear);
    }
    if (filters.status !== undefined) {
      where.push(`r.status = $${args.length + 1}`);
      args.push(filters.status);
    }
    const sql =
      SELECT_REUNION_BASE +
      'WHERE ' +
      where.join(' AND ') +
      ' ORDER BY r.graduation_year DESC, r.created_at DESC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as ReunionRow[];
    return rows.map(reunionRowToDto);
  }

  async getById(id: string, _actor: ResolvedActor): Promise<ReunionGroupDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REUNION_BASE + 'WHERE r.id = $1::uuid AND r.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as ReunionRow[];
    if (rows.length === 0) {
      throw new NotFoundException('Reunion group not found');
    }
    return reunionRowToDto(rows[0]!);
  }

  /**
   * Create a reunion group. Alumni may create reunions for which they
   * are the organiser; staff + admin may create for any alumnus.
   */
  async create(input: CreateReunionGroupDto, actor: ResolvedActor): Promise<ReunionGroupDto> {
    const tenant = getCurrentTenant();
    const isStaff = await hasAdminScope(this.permCheck, actor);
    if (!isStaff) {
      // Non-staff must be the organiser themselves.
      const ownRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT id::text AS id FROM alm_alumni_profiles WHERE person_id = $1::uuid LIMIT 1',
          actor.personId,
        );
      })) as Array<{ id: string }>;
      const ownId = ownRows[0]?.id;
      if (!ownId || ownId !== input.organiserId) {
        throw new ForbiddenException(
          'Alumni may only create reunion groups they themselves organise.',
        );
      }
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO alm_reunion_groups
           (id, school_id, graduation_year, name, organiser_id, event_date, rsvp_deadline,
            status, description, venue)
         VALUES ($1::uuid, $2::uuid, $3::int, $4, $5::uuid, $6::date, $7::date, 'PLANNING', $8, $9)`,
        id,
        tenant.schoolId,
        input.graduationYear,
        input.name,
        input.organiserId,
        input.eventDate ?? null,
        input.rsvpDeadline ?? null,
        input.description ?? null,
        input.venue ?? null,
      );
    });
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateReunionGroupDto,
    actor: ResolvedActor,
  ): Promise<ReunionGroupDto> {
    const tenant = getCurrentTenant();
    const current = await this.getById(id, actor);
    const isStaff = await hasAdminScope(this.permCheck, actor);
    if (!isStaff) {
      const ownRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT id::text AS id FROM alm_alumni_profiles WHERE person_id = $1::uuid LIMIT 1',
          actor.personId,
        );
      })) as Array<{ id: string }>;
      const ownId = ownRows[0]?.id;
      if (!ownId || ownId !== current.organiserId) {
        throw new ForbiddenException('Only the organiser or staff may update a reunion group.');
      }
    }
    // Refuse CONFIRMED without an event_date.
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [];
    let i = 1;
    const add = (col: string, val: unknown, cast = '') => {
      sets.push(`${col} = $${i++}${cast}`);
      args.push(val);
    };
    if (input.name !== undefined) add('name', input.name);
    if (input.eventDate !== undefined) add('event_date', input.eventDate, '::date');
    if (input.rsvpDeadline !== undefined) add('rsvp_deadline', input.rsvpDeadline, '::date');
    if (input.status !== undefined) {
      if (input.status === 'CONFIRMED') {
        const effectiveDate = input.eventDate ?? current.eventDate;
        if (!effectiveDate) {
          throw new BadRequestException('Cannot mark a reunion CONFIRMED without an event_date.');
        }
      }
      add('status', input.status);
    }
    if (input.description !== undefined) add('description', input.description);
    if (input.venue !== undefined) add('venue', input.venue);
    args.push(id);
    args.push(tenant.schoolId);
    // REVIEW-P2C22 BLOCKING 4 — UPDATE carries the school predicate
    // so cross-school UUIDs cannot mutate a sister school's reunion.
    // The pre-flight getById already enforces school scope at read.
    const sql = `UPDATE alm_reunion_groups SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(sql, ...args);
    });
    return this.getById(id, actor);
  }
}

interface EventRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  event_date: Date;
  venue: string | null;
  rsvp_url: string | null;
  evt_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function eventRowToDto(r: EventRow, ticketsAvailable: number | null = null): AlumniEventDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    title: r.title,
    description: r.description,
    eventDate: r.event_date.toISOString().slice(0, 10),
    venue: r.venue,
    rsvpUrl: r.rsvp_url,
    evtEventId: r.evt_event_id,
    ticketsAvailable,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class AlumniEventService {
  private readonly logger = new Logger(AlumniEventService.name);
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(
    _actor: ResolvedActor,
    filters: { fromDate?: string; toDate?: string } = {},
  ): Promise<AlumniEventDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['e.school_id = $1::uuid'];
    const args: unknown[] = [tenant.schoolId];
    if (filters.fromDate !== undefined) {
      where.push(`e.event_date >= $${args.length + 1}::date`);
      args.push(filters.fromDate);
    }
    if (filters.toDate !== undefined) {
      where.push(`e.event_date <= $${args.length + 1}::date`);
      args.push(filters.toDate);
    }
    const sql =
      `SELECT e.id::text AS id, e.school_id::text AS school_id, e.title, e.description, ` +
      `e.event_date, e.venue, e.rsvp_url, e.evt_event_id::text AS evt_event_id, ` +
      `e.created_at, e.updated_at ` +
      `FROM alm_events e WHERE ${where.join(' AND ')} ORDER BY e.event_date`;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as EventRow[];

    // Enrich each row with ticket data when evt_event_id resolves.
    const out: AlumniEventDto[] = [];
    for (const r of rows) {
      const tix = await this.resolveTicketsAvailable(r.evt_event_id);
      out.push(eventRowToDto(r, tix));
    }
    return out;
  }

  async getById(id: string, _actor: ResolvedActor): Promise<AlumniEventDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT e.id::text AS id, e.school_id::text AS school_id, e.title, e.description,
         e.event_date, e.venue, e.rsvp_url, e.evt_event_id::text AS evt_event_id,
         e.created_at, e.updated_at
         FROM alm_events e WHERE e.id = $1::uuid AND e.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as EventRow[];
    if (rows.length === 0) {
      throw new NotFoundException('Alumni event not found');
    }
    const tix = await this.resolveTicketsAvailable(rows[0]!.evt_event_id);
    return eventRowToDto(rows[0]!, tix);
  }

  async create(input: CreateAlumniEventDto, actor: ResolvedActor): Promise<AlumniEventDto> {
    if (!(await hasAdminScope(this.permCheck, actor))) {
      throw new ForbiddenException('Event management requires staff or admin scope');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO alm_events
           (id, school_id, title, description, event_date, venue, rsvp_url, evt_event_id)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8)`,
        id,
        tenant.schoolId,
        input.title,
        input.description ?? null,
        input.eventDate,
        input.venue ?? null,
        input.rsvpUrl ?? null,
        input.evtEventId ?? null,
      );
    });
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateAlumniEventDto,
    actor: ResolvedActor,
  ): Promise<AlumniEventDto> {
    if (!(await hasAdminScope(this.permCheck, actor))) {
      throw new ForbiddenException('Event management requires staff or admin scope');
    }
    // Pre-flight read enforces school scope at the loader.
    await this.getById(id, actor);
    const tenant = getCurrentTenant();
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [];
    let i = 1;
    const add = (col: string, val: unknown, cast = '') => {
      sets.push(`${col} = $${i++}${cast}`);
      args.push(val);
    };
    if (input.title !== undefined) add('title', input.title);
    if (input.description !== undefined) add('description', input.description);
    if (input.eventDate !== undefined) add('event_date', input.eventDate, '::date');
    if (input.venue !== undefined) add('venue', input.venue);
    if (input.rsvpUrl !== undefined) add('rsvp_url', input.rsvpUrl);
    if (input.evtEventId !== undefined) add('evt_event_id', input.evtEventId);
    args.push(id);
    args.push(tenant.schoolId);
    // REVIEW-P2C22 BLOCKING 4 — every UPDATE carries the school
    // predicate. The defence-in-depth fires even if a future code
    // path skips the pre-flight getById.
    const sql = `UPDATE alm_events SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(sql, ...args);
    });
    return this.getById(id, actor);
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    if (!(await hasAdminScope(this.permCheck, actor))) {
      throw new ForbiddenException('Event management requires staff or admin scope');
    }
    const tenant = getCurrentTenant();
    // REVIEW-P2C22 BLOCKING 4 — DELETE carries the school predicate
    // so cross-school UUIDs cannot land here. Zero-row result raises
    // 404 (collapses "not found" + "not yours" to don't-leak-existence).
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM alm_events WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as unknown;
    if (typeof rows === 'number' && rows === 0) {
      throw new NotFoundException('Alumni event not found');
    }
  }

  /**
   * Resolve ticket availability from the P2-12 Events module. The link
   * is DISPLAY-ONLY (no FK constraint) so this method ALWAYS handles
   * the no-data outcomes gracefully:
   *   - evtEventId is null → returns null (no link)
   *   - Events module not enabled / evt_events table missing → null
   *     (caller falls back to rsvp_url)
   *   - Events module enabled but the supplied id is not a real row
   *     IN THE CURRENT SCHOOL → null
   *   - The row exists in the current school → returns the computed
   *     remaining-capacity int
   *
   * REVIEW-P2C22 BLOCKING 5 — the WHERE now adds `e.school_id = $2`
   * so a stale `evt_event_id` pointing at a sister school's tickets
   * cannot leak counts into the current school's alumni event card.
   * Cross-school evt_event_id values resolve to null (treated as "no
   * link") and the UI falls back to the rsvp_url, which is the right
   * behaviour — the alumni event lives in this tenant, the linked
   * ticket cannot live elsewhere.
   *
   * Resolution method: a defensive raw query against tenant
   * `evt_events` joined to `evt_ticket_tiers` to sum (quantity -
   * quantity_sold) across all tiers. Any error (table missing, schema
   * different, etc.) is swallowed to null with a debug log line.
   */
  private async resolveTicketsAvailable(evtEventId: string | null): Promise<number | null> {
    if (!evtEventId) return null;
    const tenant = getCurrentTenant();
    try {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT COALESCE(SUM(t.quantity - t.quantity_sold), 0)::int AS available
           FROM evt_events e
           LEFT JOIN evt_ticket_tiers t ON t.event_id = e.id
           WHERE e.id = $1::uuid AND e.school_id = $2::uuid
           GROUP BY e.id`,
          evtEventId,
          tenant.schoolId,
        );
      })) as Array<{ available: number }>;
      if (rows.length === 0) return null;
      return rows[0]!.available;
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.logger.debug(
        `evt_event_id ${evtEventId} resolution failed (Events module probably not enabled): ${msg}`,
      );
      return null;
    }
  }
}
