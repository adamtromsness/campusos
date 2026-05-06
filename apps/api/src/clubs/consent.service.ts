import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { FieldTripConsentDto, SignConsentDto } from './dto/clubs.dto';

interface ConsentRow {
  id: string;
  field_trip_id: string;
  student_id: string;
  guardian_person_id: string;
  guardian_name: string | null;
  consent_given: boolean;
  signed_at: string;
  ip_address: string | null;
  emergency_contact_override: string | null;
  medical_notes_override: string | null;
  notes: string | null;
}

const SELECT_CONSENT =
  'SELECT c.id::text AS id, c.field_trip_id::text AS field_trip_id, ' +
  'c.student_id::text AS student_id, c.guardian_person_id::text AS guardian_person_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = c.guardian_person_id) AS guardian_name, " +
  'c.consent_given, ' +
  'TO_CHAR(c.signed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS signed_at, ' +
  'c.ip_address, c.emergency_contact_override, c.medical_notes_override, c.notes ' +
  'FROM ext_field_trip_consent_records c ';

function rowToDto(r: ConsentRow): FieldTripConsentDto {
  return {
    id: r.id,
    fieldTripId: r.field_trip_id,
    studentId: r.student_id,
    guardianPersonId: r.guardian_person_id,
    guardianName: r.guardian_name,
    consentGiven: r.consent_given,
    signedAt: r.signed_at,
    ipAddress: r.ip_address,
    emergencyContactOverride: r.emergency_contact_override,
    medicalNotesOverride: r.medical_notes_override,
    notes: r.notes,
  };
}

@Injectable()
export class ConsentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * PARENT CONSENT KEYSTONE.
   *
   * Validates the calling guardian has a sis_student_guardians link
   * to the supplied studentId. Stamps signed_at, ip_address, and
   * guardian_person_id from the request actor. UNIQUE(trip, student,
   * guardian) catches a duplicate signature with a friendly 400.
   * Emits ext.consent.received after the tx commits so downstream
   * consumers (notifications, audit) react to a real database row.
   */
  async sign(
    fieldTripId: string,
    input: SignConsentDto,
    ipAddress: string | null,
    actor: ResolvedActor,
  ): Promise<FieldTripConsentDto> {
    if (actor.personType !== 'GUARDIAN' || !actor.personId) {
      throw new ForbiddenException(
        'Only the guardian linked to the student can sign field trip consent',
      );
    }

    const tripExists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM ext_field_trips WHERE id = $1::uuid LIMIT 1',
        fieldTripId,
      );
    })) as Array<unknown>;
    if (tripExists.length === 0) throw new NotFoundException('Field trip not found');

    // Validate the calling guardian is linked to the student via
    // sis_student_guardians. Without this check a parent could sign
    // a consent for any other family's child by guessing a UUID.
    const link = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
        input.studentId,
        actor.personId,
      );
    })) as Array<unknown>;
    if (link.length === 0) {
      throw new ForbiddenException(
        'You are not the linked guardian for this student. Cannot sign consent.',
      );
    }

    // Verify the student is actually registered as a participant on
    // this trip — signing consent for a non-participant student would
    // be a no-op against the rest of the system.
    const partExists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM ext_field_trip_participants WHERE field_trip_id = $1::uuid AND student_id = $2::uuid LIMIT 1',
        fieldTripId,
        input.studentId,
      );
    })) as Array<unknown>;
    if (partExists.length === 0) {
      throw new BadRequestException(
        'Student is not a participant on this trip. Add the participant before signing consent.',
      );
    }

    const id = generateId();
    let createdRow: ConsentRow | null = null;
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO ext_field_trip_consent_records (id, field_trip_id, student_id, guardian_person_id, consent_given, signed_at, ip_address, emergency_contact_override, medical_notes_override, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now(), $6, $7, $8, $9)',
          id,
          fieldTripId,
          input.studentId,
          actor.personId,
          input.consentGiven,
          ipAddress,
          input.emergencyContactOverride ?? null,
          input.medicalNotesOverride ?? null,
          input.notes ?? null,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
        throw new BadRequestException(
          'You have already signed consent for this student on this trip',
        );
      }
      throw e;
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_CONSENT + 'WHERE c.id = $1::uuid', id);
    })) as ConsentRow[];
    createdRow = rows[0]!;

    // Emit AFTER tx commit
    try {
      await this.kafka.emit({
        topic: 'ext.consent.received',
        key: fieldTripId,
        sourceModule: 'clubs',
        payload: {
          consentRecordId: id,
          fieldTripId,
          studentId: input.studentId,
          guardianPersonId: actor.personId,
          consentGiven: input.consentGiven,
          signedAt: createdRow.signed_at,
          ipAddress,
        },
      });
    } catch {
      // best-effort emit
    }

    return rowToDto(createdRow);
  }

  async getMyConsent(
    fieldTripId: string,
    studentId: string,
    actor: ResolvedActor,
  ): Promise<FieldTripConsentDto | null> {
    if (actor.personType !== 'GUARDIAN' || !actor.personId) {
      throw new ForbiddenException('Only guardians can read their own consent record');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CONSENT +
          'WHERE c.field_trip_id = $1::uuid AND c.student_id = $2::uuid AND c.guardian_person_id = $3::uuid ORDER BY c.signed_at DESC LIMIT 1',
        fieldTripId,
        studentId,
        actor.personId,
      );
    })) as ConsentRow[];
    return rows.length === 0 ? null : rowToDto(rows[0]!);
  }
}
