import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { WorkflowEngineService } from '@modules/m02-workflows';
import {
  AdhocTripPurpose,
  AdhocTripResponseDto,
  AdhocTripStatus,
  AssignAdhocTripDto,
  CancelAdhocTripDto,
  CreateAdhocTripDto,
} from './dto/route-generation.dto';

interface AdhocTripRow {
  id: string;
  school_id: string;
  requested_by: string;
  requested_by_name: string | null;
  trip_purpose: string;
  trip_date: Date;
  departure_time: string | null;
  return_time: string | null;
  pickup_location: string;
  destination: string;
  estimated_passengers: number;
  special_requirements: string | null;
  linked_event_id: string | null;
  assigned_vehicle_id: string | null;
  assigned_vehicle_name: string | null;
  assigned_driver_id: string | null;
  assigned_driver_name: string | null;
  status: string;
  linked_approval_id: string | null;
  approval_notes: string | null;
  cancellation_reason: string | null;
  scheduled_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_BASE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, ' +
  't.requested_by::text AS requested_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = t.requested_by) AS requested_by_name, ' +
  't.trip_purpose, t.trip_date, ' +
  "TO_CHAR(t.departure_time, 'HH24:MI:SS') AS departure_time, " +
  "TO_CHAR(t.return_time, 'HH24:MI:SS') AS return_time, " +
  't.pickup_location, t.destination, t.estimated_passengers, ' +
  't.special_requirements, t.linked_event_id::text AS linked_event_id, ' +
  't.assigned_vehicle_id::text AS assigned_vehicle_id, ' +
  '(SELECT registration FROM trn_vehicles WHERE id = t.assigned_vehicle_id) AS assigned_vehicle_name, ' +
  't.assigned_driver_id::text AS assigned_driver_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN hr_employees e ON e.person_id = ip.id WHERE e.id = t.assigned_driver_id) AS assigned_driver_name, ' +
  't.status, t.linked_approval_id::text AS linked_approval_id, ' +
  't.approval_notes, t.cancellation_reason, t.scheduled_at, t.completed_at, ' +
  't.created_at, t.updated_at ' +
  'FROM trn_adhoc_trip_requests t ';

function rowToDto(r: AdhocTripRow): AdhocTripResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    tripPurpose: r.trip_purpose as AdhocTripPurpose,
    tripDate: r.trip_date.toISOString().slice(0, 10),
    departureTime: r.departure_time,
    returnTime: r.return_time,
    pickupLocation: r.pickup_location,
    destination: r.destination,
    estimatedPassengers: r.estimated_passengers,
    specialRequirements: r.special_requirements,
    linkedEventId: r.linked_event_id,
    assignedVehicleId: r.assigned_vehicle_id,
    assignedVehicleName: r.assigned_vehicle_name,
    assignedDriverId: r.assigned_driver_id,
    assignedDriverName: r.assigned_driver_name,
    status: r.status as AdhocTripStatus,
    linkedApprovalId: r.linked_approval_id,
    approvalNotes: r.approval_notes,
    cancellationReason: r.cancellation_reason,
    scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * AdhocTripService — one-off trip requests routed through the Cycle 7
 * workflow engine.
 *
 * On submit, the service writes the trn_adhoc_trip_requests row first
 * (so the workflow engine's reference-row existence check finds it)
 * and then asks WorkflowEngineService.submit to spin up a fresh
 * wsk_approval_requests chain. The returned approval id is stamped
 * back onto trn_adhoc_trip_requests.linked_approval_id so the TC can
 * navigate from the trip card to the approval queue in one click.
 *
 * Approval state-machine lives in wsk_approval_requests +
 * wsk_approval_steps. When the approval resolves APPROVED, the TC
 * flips the trip from REQUESTED to APPROVED via PATCH /trips/:id
 * (admin only). Vehicle + driver assignment is a separate flip from
 * APPROVED to SCHEDULED — the assignment cannot land while approval
 * is still pending.
 */
@Injectable()
export class AdhocTripService {
  private readonly logger = new Logger(AdhocTripService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly workflows: WorkflowEngineService,
  ) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage ad-hoc trip assignments',
    );
  }

  async list(
    actor: ResolvedActor,
    args: { status?: AdhocTripStatus; fromDate?: string; toDate?: string },
  ): Promise<AdhocTripResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['t.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];

    // Non-admin non-staff submitters see only their own requests.
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      params.push(actor.accountId);
      where.push('t.requested_by = $' + params.length + '::uuid');
    }

    if (args.status) {
      params.push(args.status);
      where.push('t.status = $' + params.length);
    }
    if (args.fromDate) {
      params.push(args.fromDate);
      where.push('t.trip_date >= $' + params.length + '::date');
    }
    if (args.toDate) {
      params.push(args.toDate);
      where.push('t.trip_date <= $' + params.length + '::date');
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY t.trip_date DESC, t.created_at DESC LIMIT 200',
        ...params,
      );
    })) as AdhocTripRow[];
    return rows.map(rowToDto);
  }

  async getById(tripId: string, actor: ResolvedActor): Promise<AdhocTripResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE t.school_id = $1::uuid AND t.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        tripId,
      );
    })) as AdhocTripRow[];
    if (rows.length === 0) throw new NotFoundException('Ad-hoc trip request not found');
    const dto = rowToDto(rows[0]!);
    // Row-scope for non-admin non-staff: only own requests
    if (
      !actor.isSchoolAdmin &&
      actor.personType !== 'STAFF' &&
      dto.requestedBy !== actor.accountId
    ) {
      throw new NotFoundException('Ad-hoc trip request not found');
    }
    return dto;
  }

  /**
   * Submit a new ad-hoc trip request. Writes the row first, then asks
   * the workflow engine to spin up the approval chain, then stamps
   * the resulting approval id back on the trip. If the workflow
   * template is not configured the trip row stays REQUESTED with a
   * NULL linked_approval_id and the TC can advance it manually via
   * PATCH.
   */
  async submit(input: CreateAdhocTripDto, actor: ResolvedActor): Promise<AdhocTripResponseDto> {
    const tenant = getCurrentTenant();

    // Validate trip_date is not in the past (allow same-day requests).
    const tripDate = new Date(input.tripDate + 'T00:00:00Z');
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    if (tripDate < today) {
      throw new BadRequestException('tripDate cannot be in the past');
    }

    // Validate departure < return at the DTO layer too — the schema
    // catches it but we surface a friendly error pre-INSERT.
    if (input.departureTime && input.returnTime && input.returnTime <= input.departureTime) {
      throw new BadRequestException('returnTime must be after departureTime');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_adhoc_trip_requests (id, school_id, requested_by, trip_purpose, trip_date, departure_time, return_time, pickup_location, destination, estimated_passengers, special_requirements, linked_event_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::time, $7::time, $8, $9, $10::int, $11, $12::uuid)',
        id,
        tenant.schoolId,
        actor.accountId,
        input.tripPurpose,
        input.tripDate,
        input.departureTime ?? null,
        input.returnTime ?? null,
        input.pickupLocation,
        input.destination,
        input.estimatedPassengers,
        input.specialRequirements ?? null,
        input.linkedEventId ?? null,
      );
    });

    // Route through the workflow engine. If no template is configured,
    // the engine throws BadRequestException — we swallow it so the trip
    // row lives and the TC can manage it manually.
    try {
      const approval = await this.workflows.submit(
        {
          requestType: 'TRN_ADHOC_TRIP',
          referenceId: id,
          referenceTable: 'trn_adhoc_trip_requests',
        },
        actor,
      );
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE trn_adhoc_trip_requests SET linked_approval_id = $1::uuid, updated_at = now() WHERE id = $2::uuid',
          approval.id,
          id,
        );
      });
    } catch (err) {
      this.logger.log('Ad-hoc trip ' + id + ' submitted without workflow chain: ' + String(err));
    }

    return this.getById(id, actor);
  }

  async approve(
    tripId: string,
    approvalNotes: string | null,
    actor: ResolvedActor,
  ): Promise<AdhocTripResponseDto> {
    this.assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT status FROM trn_adhoc_trip_requests WHERE id = $1::uuid FOR UPDATE',
        tripId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Ad-hoc trip request not found');
      if (rows[0]!.status !== 'REQUESTED') {
        throw new BadRequestException(
          'Trip is in status ' +
            rows[0]!.status +
            '; only REQUESTED trips can be approved (use /assign to move to SCHEDULED)',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE trn_adhoc_trip_requests SET status = 'APPROVED', approval_notes = $1, updated_at = now() WHERE id = $2::uuid",
        approvalNotes,
        tripId,
      );
    });
    return this.getById(tripId, actor);
  }

  /**
   * Assign vehicle + driver. Refuses to act on a non-APPROVED trip
   * because the schema's scheduled_chk pins assigned_vehicle_id to
   * NULL until the trip flips to SCHEDULED. Also re-validates the
   * supplied vehicle + driver exist in this tenant.
   */
  async assign(
    tripId: string,
    input: AssignAdhocTripDto,
    actor: ResolvedActor,
  ): Promise<AdhocTripResponseDto> {
    this.assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT status FROM trn_adhoc_trip_requests WHERE id = $1::uuid FOR UPDATE',
        tripId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Ad-hoc trip request not found');
      if (rows[0]!.status !== 'APPROVED' && rows[0]!.status !== 'SCHEDULED') {
        throw new BadRequestException(
          'Trip is in status ' +
            rows[0]!.status +
            '; only APPROVED or SCHEDULED trips can be assigned',
        );
      }
      const v = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM trn_vehicles WHERE id = $1::uuid LIMIT 1',
        input.vehicleId,
      )) as Array<{ ok: number }>;
      if (v.length === 0) {
        throw new BadRequestException('vehicleId does not match a vehicle in this school');
      }
      const d = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        input.driverId,
      )) as Array<{ ok: number }>;
      if (d.length === 0) {
        throw new BadRequestException('driverId does not match an employee in this school');
      }
      await tx.$executeRawUnsafe(
        "UPDATE trn_adhoc_trip_requests SET assigned_vehicle_id = $1::uuid, assigned_driver_id = $2::uuid, status = 'SCHEDULED', scheduled_at = COALESCE(scheduled_at, now()), approval_notes = COALESCE($3, approval_notes), updated_at = now() WHERE id = $4::uuid",
        input.vehicleId,
        input.driverId,
        input.approvalNotes ?? null,
        tripId,
      );
    });
    return this.getById(tripId, actor);
  }

  async complete(tripId: string, actor: ResolvedActor): Promise<AdhocTripResponseDto> {
    this.assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT status FROM trn_adhoc_trip_requests WHERE id = $1::uuid FOR UPDATE',
        tripId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Ad-hoc trip request not found');
      if (rows[0]!.status !== 'SCHEDULED') {
        throw new BadRequestException(
          'Trip is in status ' + rows[0]!.status + '; only SCHEDULED trips can be marked COMPLETED',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE trn_adhoc_trip_requests SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $1::uuid",
        tripId,
      );
    });
    return this.getById(tripId, actor);
  }

  /**
   * Cancel — both requester and admin can cancel REQUESTED trips. Only
   * admin can cancel APPROVED + SCHEDULED trips (non-terminal).
   * Schema's multi-column cancelled_chk requires a cancellation_reason
   * — DTO validation already enforces non-empty.
   */
  async cancel(
    tripId: string,
    input: CancelAdhocTripDto,
    actor: ResolvedActor,
  ): Promise<AdhocTripResponseDto> {
    const trip = await this.getById(tripId, actor);
    if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') {
      throw new BadRequestException('Trip is in status ' + trip.status + '; cannot cancel');
    }
    // Only admin or staff or requester can cancel
    const isManager = actor.isSchoolAdmin || actor.personType === 'STAFF';
    if (!isManager && trip.requestedBy !== actor.accountId) {
      throw new ForbiddenException('Only the requester or a manager can cancel this trip');
    }
    // Non-manager cannot cancel beyond REQUESTED
    if (!isManager && trip.status !== 'REQUESTED') {
      throw new ForbiddenException('Only managers can cancel a trip past the REQUESTED state');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "UPDATE trn_adhoc_trip_requests SET status = 'CANCELLED', cancellation_reason = $1, updated_at = now() WHERE id = $2::uuid AND status NOT IN ('COMPLETED', 'CANCELLED')",
        input.cancellationReason,
        tripId,
      );
    });
    return this.getById(tripId, actor);
  }
}
