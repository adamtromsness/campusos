import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  AttendanceStatus,
  AddTripParticipantDto,
  BackgroundCheckStatus,
  ChaperoneRole,
  CreateFieldTripDto,
  FieldTripParticipantDto,
  FieldTripResponseDto,
  TripStatus,
  UpdateFieldTripDto,
} from '../clubs/dto/clubs.dto';

interface TripRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  destination: string;
  trip_date: string;
  departure_time: string | null;
  return_time: string | null;
  grade_levels: string[] | null;
  max_participants: number | null;
  cost_per_student: string | null;
  organiser_id: string;
  organiser_name: string | null;
  status: string;
  consent_deadline: string | null;
  participant_count: number;
  consent_signed_count: number;
}

const SELECT_TRIP_BASE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, t.title, t.description, ' +
  "t.destination, TO_CHAR(t.trip_date, 'YYYY-MM-DD') AS trip_date, " +
  "TO_CHAR(t.departure_time, 'HH24:MI') AS departure_time, " +
  "TO_CHAR(t.return_time, 'HH24:MI') AS return_time, " +
  't.grade_levels, t.max_participants, t.cost_per_student::text AS cost_per_student, ' +
  't.organiser_id::text AS organiser_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees e " +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE e.id = t.organiser_id) AS organiser_name, ' +
  "t.status, TO_CHAR(t.consent_deadline, 'YYYY-MM-DD') AS consent_deadline, " +
  '(SELECT COUNT(*)::int FROM ext_field_trip_participants p WHERE p.field_trip_id = t.id) AS participant_count, ' +
  '(SELECT COUNT(DISTINCT cr.student_id)::int FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = t.id AND cr.consent_given = true) AS consent_signed_count ' +
  'FROM ext_field_trips t ';

function tripRowToDto(r: TripRow): FieldTripResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    title: r.title,
    description: r.description,
    destination: r.destination,
    tripDate: r.trip_date,
    departureTime: r.departure_time,
    returnTime: r.return_time,
    gradeLevels: r.grade_levels,
    maxParticipants: r.max_participants,
    costPerStudent: r.cost_per_student === null ? null : Number(r.cost_per_student),
    organiserId: r.organiser_id,
    organiserName: r.organiser_name,
    status: r.status as TripStatus,
    consentDeadline: r.consent_deadline,
    participantCount: r.participant_count,
    consentSignedCount: r.consent_signed_count,
  };
}

@Injectable()
export class FieldTripService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  /**
   * Row-scope: admin / Staff see every trip; guardians see only trips
   * where their own children are participants (matched on
   * sis_student_guardians.guardian_person_id = actor.personId);
   * everyone else sees nothing.
   */
  async list(actor: ResolvedActor): Promise<FieldTripResponseDto[]> {
    const tenant = getCurrentTenant();
    let sql: string;
    let params: unknown[];
    if (this.isManager(actor)) {
      sql = SELECT_TRIP_BASE + 'WHERE t.school_id = $1::uuid ORDER BY t.trip_date DESC';
      params = [tenant.schoolId];
    } else if (actor.personType === 'GUARDIAN' && actor.personId) {
      sql =
        SELECT_TRIP_BASE +
        'WHERE t.school_id = $1::uuid AND EXISTS (' +
        '  SELECT 1 FROM ext_field_trip_participants p ' +
        '  JOIN sis_student_guardians sg ON sg.student_id = p.student_id ' +
        '  JOIN sis_guardians g ON g.id = sg.guardian_id ' +
        '  WHERE p.field_trip_id = t.id AND g.person_id = $2::uuid' +
        ') ORDER BY t.trip_date DESC';
      params = [tenant.schoolId, actor.personId];
    } else {
      return [];
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...params);
    })) as TripRow[];
    return rows.map(tripRowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<FieldTripResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_TRIP_BASE + 'WHERE t.id = $1::uuid', id);
    })) as TripRow[];
    if (rows.length === 0) throw new NotFoundException('Field trip not found');

    if (!this.isManager(actor)) {
      if (actor.personType !== 'GUARDIAN' || !actor.personId) {
        throw new NotFoundException('Field trip not found');
      }
      const access = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM ext_field_trip_participants p ' +
            'JOIN sis_student_guardians sg ON sg.student_id = p.student_id ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE p.field_trip_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          id,
          actor.personId,
        );
      })) as Array<unknown>;
      if (access.length === 0) throw new NotFoundException('Field trip not found');
    }

    const dto = tripRowToDto(rows[0]!);
    const isManager = this.isManager(actor);

    // REVIEW-CYCLE17 BLOCKING 3 — guardians see only their own
    // children's participant rows. The full participant list and the
    // chaperone roster (with names + background-check status + role
    // + confirmation) stay staff-only.
    if (isManager) {
      const partRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT p.id::text AS id, p.field_trip_id::text AS field_trip_id, ' +
            'p.student_id::text AS student_id, ' +
            "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_students s " +
            '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
            '  WHERE s.id = p.student_id) AS student_name, ' +
            'p.attendance_status, ' +
            'EXISTS (SELECT 1 FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = p.field_trip_id AND cr.student_id = p.student_id) AS consent_signed, ' +
            '(SELECT cr.consent_given FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = p.field_trip_id AND cr.student_id = p.student_id ORDER BY cr.signed_at DESC LIMIT 1) AS consent_given ' +
            'FROM ext_field_trip_participants p WHERE p.field_trip_id = $1::uuid ORDER BY student_name',
          id,
        );
      })) as Array<{
        id: string;
        field_trip_id: string;
        student_id: string;
        student_name: string | null;
        attendance_status: string;
        consent_signed: boolean;
        consent_given: boolean | null;
      }>;
      dto.participants = partRows.map((p) => ({
        id: p.id,
        fieldTripId: p.field_trip_id,
        studentId: p.student_id,
        studentName: p.student_name,
        attendanceStatus: p.attendance_status as AttendanceStatus,
        consentSigned: p.consent_signed,
        consentGiven: p.consent_given,
      }));

      const chapRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT c.id::text AS id, c.field_trip_id::text AS field_trip_id, ' +
            'c.person_id::text AS person_id, ' +
            "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = c.person_id) AS person_name, " +
            'c.role, c.background_check_status, c.confirmed ' +
            'FROM ext_field_trip_chaperones c WHERE c.field_trip_id = $1::uuid ORDER BY c.role',
          id,
        );
      })) as Array<{
        id: string;
        field_trip_id: string;
        person_id: string;
        person_name: string | null;
        role: string;
        background_check_status: string;
        confirmed: boolean;
      }>;
      dto.chaperones = chapRows.map((c) => ({
        id: c.id,
        fieldTripId: c.field_trip_id,
        personId: c.person_id,
        personName: c.person_name,
        role: c.role as ChaperoneRole,
        backgroundCheckStatus: c.background_check_status as BackgroundCheckStatus,
        confirmed: c.confirmed,
      }));
    } else {
      // Guardian path. Participants list is filtered to children
      // linked to this guardian via sis_student_guardians; consent
      // status is reported as boolean only (whether the guardian
      // themselves has signed) so other guardians' decisions stay
      // private. Chaperones are NOT inlined — chaperone names plus
      // background-check status are staff-only data.
      const partRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT p.id::text AS id, p.field_trip_id::text AS field_trip_id, ' +
            'p.student_id::text AS student_id, ' +
            "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_students s " +
            '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
            '  WHERE s.id = p.student_id) AS student_name, ' +
            'p.attendance_status, ' +
            'EXISTS (SELECT 1 FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = p.field_trip_id AND cr.student_id = p.student_id AND cr.guardian_person_id = $2::uuid) AS consent_signed, ' +
            '(SELECT cr.consent_given FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = p.field_trip_id AND cr.student_id = p.student_id AND cr.guardian_person_id = $2::uuid ORDER BY cr.signed_at DESC LIMIT 1) AS consent_given ' +
            'FROM ext_field_trip_participants p ' +
            'JOIN sis_student_guardians sg ON sg.student_id = p.student_id ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE p.field_trip_id = $1::uuid AND g.person_id = $2::uuid ORDER BY student_name',
          id,
          actor.personId,
        );
      })) as Array<{
        id: string;
        field_trip_id: string;
        student_id: string;
        student_name: string | null;
        attendance_status: string;
        consent_signed: boolean;
        consent_given: boolean | null;
      }>;
      dto.participants = partRows.map((p) => ({
        id: p.id,
        fieldTripId: p.field_trip_id,
        studentId: p.student_id,
        studentName: p.student_name,
        attendanceStatus: p.attendance_status as AttendanceStatus,
        consentSigned: p.consent_signed,
        consentGiven: p.consent_given,
      }));
      // Strip chaperones for guardians — chaperone names + background
      // check status + confirmation state are staff-only data.
      dto.chaperones = [];
    }

    return dto;
  }

  async create(input: CreateFieldTripDto, actor: ResolvedActor): Promise<FieldTripResponseDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can plan field trips');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Trip organiser must be a staff employee');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Wave 7 fix: explicit ::time casts for departure_time / return_time
      // and ::date for consent_deadline — Prisma sends raw params as TEXT
      // and Postgres will not auto-coerce TEXT → TIME (42804) or
      // TEXT → DATE for nullable columns. Mirrors the trip_date cast
      // already in place a few columns earlier.
      await client.$executeRawUnsafe(
        'INSERT INTO ext_field_trips (id, school_id, title, description, destination, trip_date, departure_time, return_time, grade_levels, max_participants, cost_per_student, organiser_id, consent_deadline) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::time, $8::time, $9::text[], $10, $11, $12::uuid, $13::date)',
        id,
        tenant.schoolId,
        input.title,
        input.description ?? null,
        input.destination,
        input.tripDate,
        input.departureTime ?? null,
        input.returnTime ?? null,
        input.gradeLevels ?? null,
        input.maxParticipants ?? null,
        input.costPerStudent ?? null,
        actor.employeeId,
        input.consentDeadline ?? null,
      );
    });
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateFieldTripDto,
    actor: ResolvedActor,
  ): Promise<FieldTripResponseDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can update field trips');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.title !== undefined) {
      params.push(input.title);
      sets.push('title = $' + params.length);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push('description = $' + params.length);
    }
    if (input.destination !== undefined) {
      params.push(input.destination);
      sets.push('destination = $' + params.length);
    }
    if (input.tripDate !== undefined) {
      params.push(input.tripDate);
      sets.push('trip_date = $' + params.length + '::date');
    }
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push('status = $' + params.length);
    }
    if (input.maxParticipants !== undefined) {
      params.push(input.maxParticipants);
      sets.push('max_participants = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id, actor);
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ext_field_trips SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    if (updated === 0) throw new NotFoundException('Field trip not found');
    return this.getById(id, actor);
  }

  async addParticipant(
    tripId: string,
    input: AddTripParticipantDto,
    actor: ResolvedActor,
  ): Promise<FieldTripParticipantDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can add trip participants');
    }
    const id = generateId();
    // REVIEW-CYCLE17 MAJOR 7 — lock the trip row + count active
    // (non-WITHDRAWN) participants under the lock. Concurrent
    // POSTs serialise on the trip row, and the cap check sees the
    // freshest count. Mirrors the MembershipService.joinAsStudent
    // pattern for student self-registration.
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        const trip = (await tx.$queryRawUnsafe(
          'SELECT id, max_participants FROM ext_field_trips WHERE id = $1::uuid FOR UPDATE',
          tripId,
        )) as Array<{ id: string; max_participants: number | null }>;
        if (trip.length === 0) throw new NotFoundException('Field trip not found');
        const max = trip[0]!.max_participants;
        if (max !== null) {
          const countRows = (await tx.$queryRawUnsafe(
            "SELECT COUNT(*)::int AS c FROM ext_field_trip_participants WHERE field_trip_id = $1::uuid AND attendance_status <> 'WITHDRAWN'",
            tripId,
          )) as Array<{ c: number }>;
          if (countRows[0]!.c >= max) {
            throw new BadRequestException(
              'Field trip has reached its max_participants cap of ' + max,
            );
          }
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO ext_field_trip_participants (id, field_trip_id, student_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid)',
          id,
          tripId,
          input.studentId,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
        throw new BadRequestException('Student is already a participant on this trip');
      }
      throw e;
    }
    return {
      id,
      fieldTripId: tripId,
      studentId: input.studentId,
      attendanceStatus: 'REGISTERED',
    };
  }

  async getConsentStatus(
    tripId: string,
    actor: ResolvedActor,
  ): Promise<
    Array<{
      studentId: string;
      studentName: string | null;
      consentSigned: boolean;
      consentGiven: boolean | null;
      signedAt: string | null;
    }>
  > {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can read consent status');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT p.student_id::text AS student_id, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_students s " +
          '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          '  WHERE s.id = p.student_id) AS student_name, ' +
          'EXISTS (SELECT 1 FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = p.field_trip_id AND cr.student_id = p.student_id) AS consent_signed, ' +
          '(SELECT cr.consent_given FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = p.field_trip_id AND cr.student_id = p.student_id ORDER BY cr.signed_at DESC LIMIT 1) AS consent_given, ' +
          '(SELECT TO_CHAR(cr.signed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') FROM ext_field_trip_consent_records cr WHERE cr.field_trip_id = p.field_trip_id AND cr.student_id = p.student_id ORDER BY cr.signed_at DESC LIMIT 1) AS signed_at ' +
          'FROM ext_field_trip_participants p WHERE p.field_trip_id = $1::uuid ORDER BY student_name',
        tripId,
      );
    })) as Array<{
      student_id: string;
      student_name: string | null;
      consent_signed: boolean;
      consent_given: boolean | null;
      signed_at: string | null;
    }>;
    return rows.map((r) => ({
      studentId: r.student_id,
      studentName: r.student_name,
      consentSigned: r.consent_signed,
      consentGiven: r.consent_given,
      signedAt: r.signed_at,
    }));
  }
}
