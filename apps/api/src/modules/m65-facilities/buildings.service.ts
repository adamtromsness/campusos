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
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  BookingResponseDto,
  BookingStatus,
  BuildingResponseDto,
  ClosureResponseDto,
  CreateBookingDto,
  CreateBuildingDto,
  CreateClosureDto,
  CreateSpaceDto,
  SpaceResponseDto,
  SpaceType,
  UpdateBookingDto,
  UpdateBuildingDto,
  UpdateClosureDto,
  UpdateSpaceDto,
} from './dto/facilities.dto';

/**
 * Facilities Manager (FM) scope — admin-tier on FAC-001.
 *
 * Per REVIEW-CYCLE21 BLOCKING 1: management of buildings, spaces, and
 * closures is FM authority, not generic STAFF. Booking authority is
 * separate (assertCanBook below) and is held by every actor with
 * fac-001:write — including teachers.
 *
 * The check uses the hasAnyPermissionInTenant helper (matches the
 * Cycle 9 / Cycle 11 hasCounsellorScope pattern) so it follows the
 * standard scope-chain resolution and respects the everyFunction grant
 * on School Admin / Platform Admin.
 */
export async function assertCanManage(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  const hasFmScope = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'fac-001:admin',
  ]);
  if (hasFmScope) return;
  throw new ForbiddenException(
    'Only school admins or the Facilities Manager can manage buildings, spaces, and closures',
  );
}

function assertCanBook(actor: ResolvedActor): void {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'STAFF') return;
  // Teachers carry FAC-001:write per the IAM seed and can book spaces.
  if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
    throw new ForbiddenException('Only staff and teachers can book spaces');
  }
}

/**
 * REVIEW-CYCLE21 BLOCKING 3 — soft-reference tenant validation helpers.
 *
 * Cycle 21 carries soft FKs to sch_rooms (DISPLAY-ONLY), hr_employees,
 * tkt_tickets, tkt_vendors, and self-references to fac_work_orders.
 * Validating these at the service layer prevents accidental or
 * malicious cross-tenant writes.
 */
export async function assertRoomInCurrentTenant(
  tenantPrisma: TenantPrismaService,
  schRoomId: string,
): Promise<void> {
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM sch_rooms WHERE id = $1::uuid LIMIT 1',
      schRoomId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new BadRequestException('schRoomId does not match a room in this school');
  }
}

export async function assertEmployeeInCurrentTenant(
  tenantPrisma: TenantPrismaService,
  employeeId: string,
): Promise<void> {
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
      employeeId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new BadRequestException('employeeId does not match an employee in this school');
  }
}

export async function assertTicketInCurrentTenant(
  tenantPrisma: TenantPrismaService,
  ticketId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM tkt_tickets WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      ticketId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new BadRequestException('tktTicketId does not match a ticket in this school');
  }
}

export async function assertVendorInCurrentTenant(
  tenantPrisma: TenantPrismaService,
  vendorId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM tkt_vendors WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      vendorId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new BadRequestException('vendorId does not match a vendor in this school');
  }
}

export async function assertWorkOrderInCurrentTenant(
  tenantPrisma: TenantPrismaService,
  workOrderId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM fac_work_orders WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      workOrderId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new BadRequestException('workOrderId does not match a work order in this school');
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

function isExclusionViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23P01') return true;
  if (e.code === '23P01') return true;
  return typeof e.message === 'string' && e.message.includes('23P01');
}

@Injectable()
export class BuildingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(): Promise<BuildingResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT b.id::text AS id, b.school_id::text AS school_id, b.name, b.code, b.year_built, b.total_floors, b.address, b.is_active, ' +
          '(SELECT COUNT(*)::int FROM fac_spaces s WHERE s.building_id = b.id AND s.is_active = true) AS space_count, ' +
          "(SELECT COUNT(*)::int FROM fac_work_orders w WHERE w.building_id = b.id AND w.status IN ('OPEN', 'IN_PROGRESS', 'VENDOR_ASSIGNED', 'ON_HOLD')) AS open_wos " +
          'FROM fac_buildings b WHERE b.school_id = $1::uuid ORDER BY b.name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      code: string | null;
      year_built: number | null;
      total_floors: number | null;
      address: string | null;
      is_active: boolean;
      space_count: number;
      open_wos: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      code: r.code,
      yearBuilt: r.year_built,
      totalFloors: r.total_floors,
      address: r.address,
      isActive: r.is_active,
      spaceCount: r.space_count,
      openWorkOrders: r.open_wos,
    }));
  }

  async getById(id: string): Promise<BuildingResponseDto> {
    const all = await this.list();
    const found = all.find((b) => b.id === id);
    if (!found) throw new NotFoundException('Building not found');
    return found;
  }

  async create(input: CreateBuildingDto, actor: ResolvedActor): Promise<BuildingResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_buildings (id, school_id, name, code, year_built, total_floors, address) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.name,
          input.code ?? null,
          input.yearBuilt ?? null,
          input.totalFloors ?? null,
          input.address ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A building with this name already exists for this school');
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateBuildingDto,
    actor: ResolvedActor,
  ): Promise<BuildingResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.code !== undefined) {
      sets.push('code = $' + (params.length + 1));
      params.push(input.code);
    }
    if (input.yearBuilt !== undefined) {
      sets.push('year_built = $' + (params.length + 1));
      params.push(input.yearBuilt);
    }
    if (input.totalFloors !== undefined) {
      sets.push('total_floors = $' + (params.length + 1));
      params.push(input.totalFloors);
    }
    if (input.address !== undefined) {
      sets.push('address = $' + (params.length + 1));
      params.push(input.address);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_buildings SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }
}

@Injectable()
export class SpaceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listForBuilding(buildingId: string): Promise<SpaceResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.building_id::text AS building_id, s.name, s.floor, s.space_type, s.area_sqft, s.is_active, ' +
          's.sch_room_id::text AS sch_room_id, sr.name AS sch_room_name ' +
          'FROM fac_spaces s LEFT JOIN sch_rooms sr ON sr.id = s.sch_room_id ' +
          'WHERE s.building_id = $1::uuid ORDER BY s.floor, s.name',
        buildingId,
      );
    })) as Array<{
      id: string;
      building_id: string;
      name: string;
      floor: string | null;
      space_type: string;
      area_sqft: number | null;
      is_active: boolean;
      sch_room_id: string | null;
      sch_room_name: string | null;
    }>;
    return rows.map(spaceRowToDto);
  }

  async getById(id: string): Promise<SpaceResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.building_id::text AS building_id, s.name, s.floor, s.space_type, s.area_sqft, s.is_active, ' +
          's.sch_room_id::text AS sch_room_id, sr.name AS sch_room_name ' +
          'FROM fac_spaces s LEFT JOIN sch_rooms sr ON sr.id = s.sch_room_id WHERE s.id = $1::uuid LIMIT 1',
        id,
      );
    })) as Array<{
      id: string;
      building_id: string;
      name: string;
      floor: string | null;
      space_type: string;
      area_sqft: number | null;
      is_active: boolean;
      sch_room_id: string | null;
      sch_room_name: string | null;
    }>;
    if (rows.length === 0) throw new NotFoundException('Space not found');
    return spaceRowToDto(rows[0]!);
  }

  async create(
    buildingId: string,
    input: CreateSpaceDto,
    actor: ResolvedActor,
  ): Promise<SpaceResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (input.schRoomId) {
      await assertRoomInCurrentTenant(this.tenantPrisma, input.schRoomId);
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_spaces (id, building_id, name, floor, space_type, area_sqft, sch_room_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)',
          id,
          buildingId,
          input.name,
          input.floor ?? null,
          input.spaceType,
          input.areaSqft ?? null,
          input.schRoomId ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A space with this name already exists in this building');
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(id: string, input: UpdateSpaceDto, actor: ResolvedActor): Promise<SpaceResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (input.schRoomId !== undefined && input.schRoomId !== null) {
      await assertRoomInCurrentTenant(this.tenantPrisma, input.schRoomId);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.floor !== undefined) {
      sets.push('floor = $' + (params.length + 1));
      params.push(input.floor);
    }
    if (input.spaceType !== undefined) {
      sets.push('space_type = $' + (params.length + 1));
      params.push(input.spaceType);
    }
    if (input.areaSqft !== undefined) {
      sets.push('area_sqft = $' + (params.length + 1));
      params.push(input.areaSqft);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (input.schRoomId !== undefined) {
      sets.push('sch_room_id = $' + (params.length + 1) + '::uuid');
      params.push(input.schRoomId);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_spaces SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }
}

@Injectable()
export class BookingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * Per-actor identity strip on booking responses.
   *
   * REVIEW-CYCLE21 BLOCKING 2: parent-safe / teacher-safe projection —
   * a non-FM actor that did not place the booking sees availability
   * (title + window + status) but not the booker's identity.
   */
  private async stripIfNotOwnerOrFm(
    rows: BookingResponseDto[],
    actor: ResolvedActor,
  ): Promise<BookingResponseDto[]> {
    if (actor.isSchoolAdmin) return rows;
    const tenant = getCurrentTenant();
    const isFm = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'fac-001:admin',
    ]);
    if (isFm) return rows;
    return rows.map((r) =>
      r.bookedBy === actor.personId ? r : { ...r, bookedBy: '', bookedByName: null, notes: null },
    );
  }

  async listForSpace(
    spaceId: string,
    actor: ResolvedActor,
    args: { fromDate?: string; toDate?: string },
  ): Promise<BookingResponseDto[]> {
    const where: string[] = ['b.space_id = $1::uuid'];
    const params: unknown[] = [spaceId];
    if (args.fromDate) {
      where.push('b.starts_at >= $' + (params.length + 1) + '::timestamptz');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('b.ends_at <= $' + (params.length + 1) + '::timestamptz');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        BOOKING_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY b.starts_at ASC LIMIT 200',
        ...params,
      );
    })) as BookingRow[];
    return this.stripIfNotOwnerOrFm(rows.map(bookingRowToDto), actor);
  }

  async listMine(actor: ResolvedActor): Promise<BookingResponseDto[]> {
    if (!actor.personId) return [];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        BOOKING_SELECT + 'WHERE b.booked_by = $1::uuid ORDER BY b.starts_at DESC LIMIT 200',
        actor.personId,
      );
    })) as BookingRow[];
    return rows.map(bookingRowToDto);
  }

  async create(
    spaceId: string,
    input: CreateBookingDto,
    actor: ResolvedActor,
  ): Promise<BookingResponseDto> {
    assertCanBook(actor);
    if (!actor.personId) {
      throw new ForbiddenException('Booking requires an authenticated person');
    }
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_space_bookings (id, space_id, booked_by, title, starts_at, ends_at, status, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz, 'CONFIRMED', $7)",
          id,
          spaceId,
          actor.personId,
          input.title,
          input.startsAt,
          input.endsAt,
          input.notes ?? null,
        );
      });
    } catch (err: unknown) {
      if (isExclusionViolation(err)) {
        throw new ConflictException(
          'This space is already booked for an overlapping time window — pick a different time or cancel the existing booking',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async getById(id: string): Promise<BookingResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(BOOKING_SELECT + 'WHERE b.id = $1::uuid LIMIT 1', id);
    })) as BookingRow[];
    if (rows.length === 0) throw new NotFoundException('Booking not found');
    return bookingRowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateBookingDto,
    actor: ResolvedActor,
  ): Promise<BookingResponseDto> {
    // REVIEW-CYCLE21 BLOCKING 2 — booking lifecycle authority:
    //   * booking owner: may CANCEL their own booking (no other transitions)
    //   * FM / school admin: may CANCEL or COMPLETE any booking
    //   * other actors with fac-001:write (other teachers / staff): no
    //     mutation authority on someone else's booking
    const existing = await this.getById(id);
    const isOwner = !!actor.personId && existing.bookedBy === actor.personId;
    const tenant = getCurrentTenant();
    const isFm =
      actor.isSchoolAdmin ||
      (await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
        'fac-001:admin',
      ]));
    if (!isOwner && !isFm) {
      throw new ForbiddenException(
        'Only the booker or the Facilities Manager can edit this booking',
      );
    }
    if (input.status !== undefined && input.status !== 'CANCELLED' && !isFm) {
      throw new ForbiddenException(
        'Only the Facilities Manager can mark a booking COMPLETED. Booking owners can CANCEL only.',
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.status !== undefined) {
      sets.push('status = $' + (params.length + 1));
      params.push(input.status);
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + (params.length + 1));
      params.push(input.notes);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'UPDATE fac_space_bookings SET ' +
              sets.join(', ') +
              ' WHERE id = $' +
              params.length +
              '::uuid',
            ...params,
          );
        });
      } catch (err: unknown) {
        if (isExclusionViolation(err)) {
          throw new ConflictException(
            'Re-confirming would overlap an existing CONFIRMED booking on this space',
          );
        }
        throw err;
      }
    }
    return this.getById(id);
  }
}

@Injectable()
export class ClosureService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(args: { activeOnly?: boolean }): Promise<ClosureResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['c.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.activeOnly) {
      where.push('(c.ends_at IS NULL OR c.ends_at > now())');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT c.id::text AS id, c.space_id::text AS space_id, sp.name AS space_name, c.closure_reason, ' +
          'c.starts_at, c.ends_at, c.affects_scheduling, c.linked_work_order_id::text AS linked_work_order_id, ' +
          'c.created_by::text AS created_by ' +
          'FROM fac_space_closures c JOIN fac_spaces sp ON sp.id = c.space_id ' +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY c.starts_at DESC LIMIT 200',
        ...params,
      );
    })) as Array<{
      id: string;
      space_id: string;
      space_name: string;
      closure_reason: string;
      starts_at: Date;
      ends_at: Date | null;
      affects_scheduling: boolean;
      linked_work_order_id: string | null;
      created_by: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      spaceId: r.space_id,
      spaceName: r.space_name,
      closureReason: r.closure_reason,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at ? r.ends_at.toISOString() : null,
      affectsScheduling: r.affects_scheduling,
      linkedWorkOrderId: r.linked_work_order_id,
      createdBy: r.created_by,
    }));
  }

  async create(input: CreateClosureDto, actor: ResolvedActor): Promise<ClosureResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Closure requires an authenticated person');
    }
    if (input.linkedWorkOrderId) {
      await assertWorkOrderInCurrentTenant(this.tenantPrisma, input.linkedWorkOrderId);
    }
    if (input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fac_space_closures (id, school_id, space_id, closure_reason, starts_at, ends_at, affects_scheduling, linked_work_order_id, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz, $7, $8::uuid, $9::uuid)',
        id,
        tenant.schoolId,
        input.spaceId,
        input.closureReason,
        input.startsAt,
        input.endsAt ?? null,
        input.affectsScheduling ?? true,
        input.linkedWorkOrderId ?? null,
        actor.personId,
      );
    });
    const list = await this.list({});
    return list.find((c) => c.id === id)!;
  }

  async patch(
    id: string,
    input: UpdateClosureDto,
    actor: ResolvedActor,
  ): Promise<ClosureResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.endsAt !== undefined) {
      sets.push('ends_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.endsAt);
    }
    if (input.closureReason !== undefined) {
      sets.push('closure_reason = $' + (params.length + 1));
      params.push(input.closureReason);
    }
    if (input.affectsScheduling !== undefined) {
      sets.push('affects_scheduling = $' + (params.length + 1));
      params.push(input.affectsScheduling);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_space_closures SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    const list = await this.list({});
    const found = list.find((c) => c.id === id);
    if (!found) throw new NotFoundException('Closure not found');
    return found;
  }
}

interface BookingRow {
  id: string;
  space_id: string;
  space_name: string;
  booked_by: string;
  booked_by_name: string | null;
  title: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  notes: string | null;
}

const BOOKING_SELECT =
  'SELECT b.id::text AS id, b.space_id::text AS space_id, sp.name AS space_name, ' +
  'b.booked_by::text AS booked_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = b.booked_by) AS booked_by_name, " +
  'b.title, b.starts_at, b.ends_at, b.status, b.notes ' +
  'FROM fac_space_bookings b JOIN fac_spaces sp ON sp.id = b.space_id ';

function bookingRowToDto(r: BookingRow): BookingResponseDto {
  return {
    id: r.id,
    spaceId: r.space_id,
    spaceName: r.space_name,
    bookedBy: r.booked_by,
    bookedByName: r.booked_by_name,
    title: r.title,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    status: r.status as BookingStatus,
    notes: r.notes,
  };
}

function spaceRowToDto(r: {
  id: string;
  building_id: string;
  name: string;
  floor: string | null;
  space_type: string;
  area_sqft: number | null;
  is_active: boolean;
  sch_room_id: string | null;
  sch_room_name: string | null;
}): SpaceResponseDto {
  return {
    id: r.id,
    buildingId: r.building_id,
    name: r.name,
    floor: r.floor,
    spaceType: r.space_type as SpaceType,
    areaSqft: r.area_sqft !== null ? Number(r.area_sqft) : null,
    isActive: r.is_active,
    schRoomId: r.sch_room_id,
    schRoomName: r.sch_room_name,
  };
}
