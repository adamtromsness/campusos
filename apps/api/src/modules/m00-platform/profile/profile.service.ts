import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '@shared/tenant';
import {
  AddPersonEmailDto,
  AddPersonPhoneDto,
  AdultAllergyEntry,
  AdultConditionEntry,
  AdultMedicalInfoDto,
  AdultMedicationEntry,
  EmergencyContactDto,
  GuardianEmploymentDto,
  HouseholdSummaryDto,
  PersonEmailDto,
  PersonEmailType,
  PersonPhoneDto,
  PersonPhoneType,
  ProfileResponseDto,
  StudentDemographicsDto,
  UpdateAdminProfileDto,
  UpdateAdultMedicalInfoDto,
  UpdateEmergencyContactDto,
  UpdateMyProfileDto,
  UpdatePersonEmailDto,
  UpdatePersonPhoneDto,
} from './dto/profile.dto';

interface IamPersonRow {
  id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
  preferred_name: string | null;
  suffix: string | null;
  previous_names: string[] | null;
  date_of_birth: string | null;
  // Self-editable, platform-wide. Distinct from
  // sis_student_demographics.gender (admin-managed, per-tenant).
  gender: string | null;
  primary_phone: string | null;
  secondary_phone: string | null;
  phone_type_primary: 'MOBILE' | 'HOME' | 'WORK' | null;
  phone_type_secondary: 'MOBILE' | 'HOME' | 'WORK' | null;
  preferred_language: string;
  personal_email: string | null;
  notes: string | null;
  profile_updated_at: string | null;
  created_at: string;
  person_type: string | null;
  account_id: string | null;
  login_email: string | null;
  // Contact-tab additions.
  address_source: string;
  custom_address_line1: string | null;
  custom_address_line2: string | null;
  custom_city: string | null;
  custom_state: string | null;
  custom_postal_code: string | null;
  custom_country: string | null;
  mailing_same_as_home: boolean;
  custom_mailing_line1: string | null;
  custom_mailing_line2: string | null;
  custom_mailing_city: string | null;
  custom_mailing_state: string | null;
  custom_mailing_postal_code: string | null;
  custom_mailing_country: string | null;
  employer: string | null;
  job_title: string | null;
  employment_status: string | null;
  industry: string | null;
  work_address_line1: string | null;
  work_address_line2: string | null;
  work_city: string | null;
  work_state: string | null;
  work_postal_code: string | null;
  work_country: string | null;
  work_location_type: 'OFFICE' | 'REMOTE' | 'HYBRID' | null;
  occupation_notes: string | null;
  bio: string | null;
  interests: unknown;
  languages: unknown;
}

interface HouseholdRow {
  family_id: string;
  family_name: string | null;
  member_role: string;
  is_primary_contact: boolean;
}

interface DemographicsRow {
  gender: string | null;
  ethnicity: string | null;
  primary_language: string | null;
  birth_country: string | null;
  citizenship: string | null;
  medical_alert_notes: string | null;
}

interface GuardianRow {
  id: string;
  employer: string | null;
  employer_phone: string | null;
  occupation: string | null;
  work_address: string | null;
}

interface EmergencyContactRow {
  id: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Robust UNIQUE-violation detector for raw Prisma queries.
 *
 * Prisma's `$executeRawUnsafe` wraps the underlying Postgres error
 * differently depending on driver version. We check three signals:
 *  1. err.code === 'P2010' (raw query failed — Prisma 5+).
 *  2. err.meta?.code === '23505' (Postgres SQLSTATE — most reliable).
 *  3. /unique constraint/i.test(message) (final fallback).
 *
 * REVIEW-CYCLE6.1 MAJOR 7: was previously checking only (1) + (3).
 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010') return true;
  if (e.meta?.code === '23505') return true;
  return /unique constraint/i.test(String(err));
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly tenant: TenantPrismaService,
  ) {}

  /**
   * Read a person's full profile shape. Composes platform iam_person +
   * household membership (always platform) with persona-specific tenant
   * data (sis_student_demographics for STUDENT, sis_guardians employment
   * for GUARDIAN, hr_emergency_contacts for STAFF, sis_emergency_contacts
   * for STUDENT).
   *
   * Emergency contacts: STAFF (employeeId nonnull) reads hr_emergency_
   * contacts keyed on employee_id; STUDENT reads sis_emergency_contacts
   * keyed on sis_students.id (resolved via platform_students.person_id).
   * Other personas (GUARDIAN, ALUMNI, EXTERNAL) have no current schema
   * home for emergency contacts and return null. The UI surfaces this
   * as an empty Emergency Contact tab.
   */
  async getProfile(personId: string): Promise<ProfileResponseDto> {
    const personRow = await this.loadIamPerson(personId);
    if (!personRow) throw new NotFoundException('Person not found');

    const household = await this.loadHousehold(personId);

    const tenantBundle = await this.tenant.executeInTenantContext(async (tx) => {
      const [demographics, employment, emergency] = await Promise.all([
        this.loadDemographics(tx, personId, personRow.person_type),
        this.loadGuardianEmployment(tx, personId, personRow.person_type),
        this.loadEmergencyContact(tx, personId, personRow.person_type),
      ]);
      return { demographics, employment, emergency };
    });

    return this.toResponse(personRow, household, tenantBundle);
  }

  /**
   * PATCH /profile/me — self-service. Identity fields (first_name,
   * last_name, login email, date_of_birth post-set) are NOT in the
   * allow-list per ADR-055. Returns the freshly-composed profile.
   */
  async updateMyProfile(personId: string, dto: UpdateMyProfileDto): Promise<ProfileResponseDto> {
    return this.applyUpdate(personId, dto, { isAdmin: false });
  }

  /**
   * GET /profile/:personId — admin override read. The endpoint guard
   * requires `usr-001:admin` in the current tenant scope chain; this
   * service-layer assert additionally verifies the target person
   * belongs to the current tenant (REVIEW-CYCLE6.1 BLOCKING 1) so a
   * school-admin from school A cannot read iam_person rows belonging
   * to school B by guessing UUIDs.
   */
  async getAdminProfile(personId: string): Promise<ProfileResponseDto> {
    await this.assertTargetInCurrentTenant(personId);
    return this.getProfile(personId);
  }

  /**
   * PATCH /profile/:personId — admin override. Adds first_name,
   * last_name, date_of_birth, and the gender / ethnicity / etc.
   * demographic fields to the allow-list. Tenant-scoped per the
   * BLOCKING-1 fix above.
   */
  async updateAdminProfile(
    personId: string,
    dto: UpdateAdminProfileDto,
  ): Promise<ProfileResponseDto> {
    await this.assertTargetInCurrentTenant(personId);
    return this.applyUpdate(personId, dto, { isAdmin: true });
  }

  /**
   * Tenant-scope guard for admin profile endpoints. The target person
   * must have at least one of: a sis_students row in the current
   * tenant, a sis_guardians row, or an hr_employees row. If none of
   * these exist, the target is not in this tenant and we 404 to avoid
   * leaking the existence of platform-side iam_person rows.
   *
   * REVIEW-CYCLE6.1 BLOCKING 1 — closed by replacing the missing
   * tenant-membership check.
   */
  private async assertTargetInCurrentTenant(personId: string): Promise<void> {
    const rows = await this.tenant.executeInTenantContext(async (tx) => {
      return tx.$queryRawUnsafe<{ found: number }[]>(
        'SELECT 1 AS found WHERE ' +
          'EXISTS (SELECT 1 FROM sis_students s ' +
          '        JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '        WHERE ps.person_id = $1::uuid) ' +
          'OR EXISTS (SELECT 1 FROM sis_guardians WHERE person_id = $1::uuid) ' +
          'OR EXISTS (SELECT 1 FROM hr_employees WHERE person_id = $1::uuid) LIMIT 1',
        personId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('Person not found');
    }
  }

  // ── Multi-phone list — /profile/me/phones ────────────────────────────

  /**
   * List the calling user's phones, primary first then by creation
   * time. Lazy-seeds a single CELL/primary row from
   * iam_person.primary_phone when:
   *   - no rows exist yet, AND
   *   - iam_person.primary_phone is non-null/non-empty.
   *
   * This handles brand-new /auth/register users whose iam_person row
   * was created with a phone but never wrote a platform_person_phones
   * row — the migration backfill caught existing rows, this catches
   * forward registrations until the registration service is updated
   * to write both.
   */
  async listMyPhones(personId: string): Promise<PersonPhoneDto[]> {
    let rows = await this.platform.platformPersonPhone.findMany({
      where: { personId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (rows.length === 0) {
      const person = await this.loadIamPerson(personId);
      if (person?.primary_phone) {
        try {
          await this.platform.platformPersonPhone.create({
            data: {
              id: randomUUID(),
              personId,
              number: person.primary_phone,
              type: 'CELL',
              textsAllowed: true,
              isPrimary: true,
            },
          });
        } catch {
          // Race condition with another tab/request seeding — re-read.
        }
        rows = await this.platform.platformPersonPhone.findMany({
          where: { personId },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        });
      }
    }
    return rows.map(this.toPhoneDto);
  }

  /**
   * Add a phone. If isPrimary is set OR no other rows exist (first
   * phone defaults to primary), demote any existing primary in the
   * same tx and sync iam_person.primary_phone to the new number so
   * downstream surfaces stay consistent.
   */
  async addMyPhone(personId: string, dto: AddPersonPhoneDto): Promise<PersonPhoneDto> {
    const existing = await this.platform.platformPersonPhone.findMany({
      where: { personId },
      select: { id: true, isPrimary: true },
    });
    const shouldBePrimary = dto.isPrimary === true || existing.length === 0;

    const id = randomUUID();
    await this.platform.$transaction(async (tx) => {
      if (shouldBePrimary) {
        await tx.platformPersonPhone.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      await tx.platformPersonPhone.create({
        data: {
          id,
          personId,
          number: dto.number,
          type: dto.type ?? 'CELL',
          textsAllowed: dto.textsAllowed ?? false,
          isPrimary: shouldBePrimary,
        },
      });
      if (shouldBePrimary) {
        await tx.iamPerson.update({
          where: { id: personId },
          data: { primaryPhone: dto.number },
        });
      }
    });
    const created = await this.platform.platformPersonPhone.findUniqueOrThrow({
      where: { id },
    });
    return this.toPhoneDto(created);
  }

  async updateMyPhone(
    personId: string,
    phoneId: string,
    dto: UpdatePersonPhoneDto,
  ): Promise<PersonPhoneDto> {
    const existing = await this.platform.platformPersonPhone.findUnique({
      where: { id: phoneId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Phone not found');
    }

    const willBePrimary = dto.isPrimary === true && !existing.isPrimary;
    const losesPrimary = dto.isPrimary === false && existing.isPrimary;

    await this.platform.$transaction(async (tx) => {
      if (willBePrimary) {
        await tx.platformPersonPhone.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      const updated = await tx.platformPersonPhone.update({
        where: { id: phoneId },
        data: {
          number: dto.number ?? undefined,
          type: dto.type ?? undefined,
          textsAllowed: dto.textsAllowed ?? undefined,
          isPrimary: dto.isPrimary ?? undefined,
          updatedAt: new Date(),
        },
      });
      // Sync iam_person.primary_phone when the primary row's number
      // changes OR when a different row becomes primary OR when the
      // primary is explicitly cleared.
      if (updated.isPrimary) {
        await tx.iamPerson.update({
          where: { id: personId },
          data: { primaryPhone: updated.number },
        });
      } else if (losesPrimary) {
        // Was primary, no longer is. Find a new primary if any rows
        // remain — first-by-created-at — and promote it.
        const next = await tx.platformPersonPhone.findFirst({
          where: { personId, isPrimary: true },
        });
        const fallback = next
          ? next.number
          : (
              await tx.platformPersonPhone.findFirst({
                where: { personId },
                orderBy: { createdAt: 'asc' },
              })
            )?.number ?? null;
        await tx.iamPerson.update({
          where: { id: personId },
          data: { primaryPhone: fallback },
        });
      }
    });

    const refreshed = await this.platform.platformPersonPhone.findUniqueOrThrow({
      where: { id: phoneId },
    });
    return this.toPhoneDto(refreshed);
  }

  /**
   * Delete a phone. If the deleted row was primary, the next-oldest
   * row gets promoted automatically (and iam_person.primary_phone is
   * synced to that new number, or null if the deleted row was the
   * only phone).
   */
  async deleteMyPhone(personId: string, phoneId: string): Promise<void> {
    const existing = await this.platform.platformPersonPhone.findUnique({
      where: { id: phoneId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Phone not found');
    }

    await this.platform.$transaction(async (tx) => {
      await tx.platformPersonPhone.delete({ where: { id: phoneId } });
      if (existing.isPrimary) {
        const next = await tx.platformPersonPhone.findFirst({
          where: { personId },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.platformPersonPhone.update({
            where: { id: next.id },
            data: { isPrimary: true, updatedAt: new Date() },
          });
          await tx.iamPerson.update({
            where: { id: personId },
            data: { primaryPhone: next.number },
          });
        } else {
          await tx.iamPerson.update({
            where: { id: personId },
            data: { primaryPhone: null },
          });
        }
      }
    });
  }

  private toPhoneDto(row: {
    id: string;
    number: string;
    type: string;
    textsAllowed: boolean;
    isPrimary: boolean;
  }): PersonPhoneDto {
    return {
      id: row.id,
      number: row.number,
      type: (row.type === 'HOME' || row.type === 'WORK' || row.type === 'OTHER'
        ? row.type
        : 'CELL') as PersonPhoneType,
      textsAllowed: row.textsAllowed,
      isPrimary: row.isPrimary,
    };
  }

  // ── Multi-email list — /profile/me/emails ────────────────────────────

  /**
   * List the calling user's emails, primary first then by creation
   * time. Lazy-seeds a single PERSONAL/primary row from the auth
   * row's email (platform_users.email) when:
   *   - no rows exist yet, AND
   *   - the auth row has a non-empty, non-synthetic email.
   *
   * Same shape as listMyPhones: the migration backfill caught
   * existing rows, this catches forward registrations until the
   * registration service is updated to write both. Synthetic
   * `@external.invalid` addresses (createMemberAccount placeholders)
   * are intentionally skipped — those aren't real and shouldn't
   * become someone's contact email by accident.
   */
  async listMyEmails(personId: string): Promise<PersonEmailDto[]> {
    let rows = await this.platform.platformPersonEmail.findMany({
      where: { personId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (rows.length === 0) {
      const account = await this.platform.platformUser.findUnique({
        where: { personId },
        select: { email: true },
      });
      const seedEmail = account?.email?.trim();
      if (seedEmail && !seedEmail.endsWith('@external.invalid')) {
        try {
          await this.platform.platformPersonEmail.create({
            data: {
              id: randomUUID(),
              personId,
              email: seedEmail,
              type: 'PERSONAL',
              isPrimary: true,
              verified: true,
            },
          });
        } catch {
          // Race with another tab/request seeding — re-read.
        }
        rows = await this.platform.platformPersonEmail.findMany({
          where: { personId },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        });
      }
    }
    return rows.map(this.toEmailDto);
  }

  /**
   * Add an email. If isPrimary is set OR no other rows exist (first
   * email defaults to primary), demote any existing primary in the
   * same tx. Case-insensitive duplicate check throws 409.
   */
  async addMyEmail(personId: string, dto: AddPersonEmailDto): Promise<PersonEmailDto> {
    const normalised = dto.email.trim();
    if (!normalised) throw new BadRequestException('Email is required.');

    const existing = await this.platform.platformPersonEmail.findMany({
      where: { personId },
      select: { id: true, email: true, isPrimary: true },
    });
    const lower = normalised.toLowerCase();
    if (existing.some((r) => r.email.toLowerCase() === lower)) {
      throw new ConflictException('This email is already on your list.');
    }
    const shouldBePrimary = dto.isPrimary === true || existing.length === 0;

    const id = randomUUID();
    await this.platform.$transaction(async (tx) => {
      if (shouldBePrimary) {
        await tx.platformPersonEmail.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      await tx.platformPersonEmail.create({
        data: {
          id,
          personId,
          email: normalised,
          type: dto.type ?? 'PERSONAL',
          isPrimary: shouldBePrimary,
          verified: false,
        },
      });
    });

    const created = await this.platform.platformPersonEmail.findUniqueOrThrow({
      where: { id },
    });
    return this.toEmailDto(created);
  }

  /**
   * Update an email's type / isPrimary. Email address itself is
   * immutable — to change it the user deletes and re-adds. Promotes
   * the next-oldest row to primary if the caller explicitly demotes
   * the current primary, so the family / iam path always has *some*
   * primary email to read.
   */
  async updateMyEmail(
    personId: string,
    emailId: string,
    dto: UpdatePersonEmailDto,
  ): Promise<PersonEmailDto> {
    const existing = await this.platform.platformPersonEmail.findUnique({
      where: { id: emailId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Email not found');
    }

    const willBePrimary = dto.isPrimary === true && !existing.isPrimary;
    const losesPrimary = dto.isPrimary === false && existing.isPrimary;

    await this.platform.$transaction(async (tx) => {
      if (willBePrimary) {
        await tx.platformPersonEmail.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      await tx.platformPersonEmail.update({
        where: { id: emailId },
        data: {
          type: dto.type ?? undefined,
          isPrimary: dto.isPrimary ?? undefined,
          updatedAt: new Date(),
        },
      });
      if (losesPrimary) {
        // Demoted the current primary without a replacement. Promote
        // the next-oldest row so /family + completion checks always
        // see a primary address.
        const fallback = await tx.platformPersonEmail.findFirst({
          where: { personId, NOT: { id: emailId } },
          orderBy: { createdAt: 'asc' },
        });
        if (fallback) {
          await tx.platformPersonEmail.update({
            where: { id: fallback.id },
            data: { isPrimary: true, updatedAt: new Date() },
          });
        }
      }
    });

    const refreshed = await this.platform.platformPersonEmail.findUniqueOrThrow({
      where: { id: emailId },
    });
    return this.toEmailDto(refreshed);
  }

  /**
   * Delete an email. The last remaining email cannot be deleted —
   * a person must always have at least one contact email on file.
   * If the deleted row was primary, the next-oldest survivor is
   * promoted automatically.
   */
  async deleteMyEmail(personId: string, emailId: string): Promise<void> {
    const existing = await this.platform.platformPersonEmail.findUnique({
      where: { id: emailId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Email not found');
    }

    const total = await this.platform.platformPersonEmail.count({
      where: { personId },
    });
    if (total <= 1) {
      throw new BadRequestException(
        'You must have at least one email on file. Add another email before removing this one.',
      );
    }

    await this.platform.$transaction(async (tx) => {
      await tx.platformPersonEmail.delete({ where: { id: emailId } });
      if (existing.isPrimary) {
        const next = await tx.platformPersonEmail.findFirst({
          where: { personId },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.platformPersonEmail.update({
            where: { id: next.id },
            data: { isPrimary: true, updatedAt: new Date() },
          });
        }
      }
    });
  }

  private toEmailDto(row: {
    id: string;
    email: string;
    type: string;
    isPrimary: boolean;
    verified: boolean;
  }): PersonEmailDto {
    return {
      id: row.id,
      email: row.email,
      type: (row.type === 'WORK' || row.type === 'SCHOOL' || row.type === 'OTHER'
        ? row.type
        : 'PERSONAL') as PersonEmailType,
      isPrimary: row.isPrimary,
      verified: row.verified,
    };
  }

  // ── Adult medical info — /profile/me/medical ─────────────────────────

  /**
   * Read the calling user's adult medical info, joining the family
   * record's doctor + insurance fields when the source is FAMILY so
   * the wire shape always carries renderable values regardless of
   * which mode the user is in. Mirror of the child surface.
   *
   * Returns an empty / source=FAMILY shape on first read, with the
   * family record's doctor + insurance pre-filled — same behaviour
   * the child page relies on.
   */
  async getMyMedical(personId: string): Promise<AdultMedicalInfoDto> {
    const row = await this.platform.platformAdultMedicalInfo.findUnique({
      where: { personId },
    });
    const family = await this.loadFamilyDoctorInsuranceForPerson(personId);
    return this.toAdultMedicalDto(personId, row, family);
  }

  /**
   * UPSERT the row. Same COALESCE-per-column pattern as
   * platform_child_medical_info so a partial PATCH leaves untouched
   * columns alone.
   */
  async updateMyMedical(
    personId: string,
    dto: UpdateAdultMedicalInfoDto,
  ): Promise<AdultMedicalInfoDto> {
    const upsertId = randomUUID();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.platform_adult_medical_info
         (id, person_id, allergies, medications, conditions,
          medical_source, doctor_name, doctor_phone, doctor_clinic,
          insurance_provider, insurance_policy, insurance_group,
          blood_type, medical_notes)
       VALUES ($1::uuid, $2::uuid,
               COALESCE($3::jsonb, '[]'::jsonb),
               COALESCE($4::jsonb, '[]'::jsonb),
               COALESCE($5::jsonb, '[]'::jsonb),
               COALESCE($6, 'FAMILY'),
               $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (person_id) DO UPDATE SET
         allergies = COALESCE(EXCLUDED.allergies, platform_adult_medical_info.allergies),
         medications = COALESCE(EXCLUDED.medications, platform_adult_medical_info.medications),
         conditions = COALESCE(EXCLUDED.conditions, platform_adult_medical_info.conditions),
         medical_source = COALESCE($6, platform_adult_medical_info.medical_source),
         doctor_name = COALESCE($7, platform_adult_medical_info.doctor_name),
         doctor_phone = COALESCE($8, platform_adult_medical_info.doctor_phone),
         doctor_clinic = COALESCE($9, platform_adult_medical_info.doctor_clinic),
         insurance_provider = COALESCE($10, platform_adult_medical_info.insurance_provider),
         insurance_policy = COALESCE($11, platform_adult_medical_info.insurance_policy),
         insurance_group = COALESCE($12, platform_adult_medical_info.insurance_group),
         blood_type = COALESCE($13, platform_adult_medical_info.blood_type),
         medical_notes = COALESCE($14, platform_adult_medical_info.medical_notes),
         updated_at = now()`,
      upsertId,
      personId,
      dto.allergies !== undefined ? JSON.stringify(dto.allergies) : null,
      dto.medications !== undefined ? JSON.stringify(dto.medications) : null,
      dto.conditions !== undefined ? JSON.stringify(dto.conditions) : null,
      dto.medicalSource ?? null,
      dto.doctorName ?? null,
      dto.doctorPhone ?? null,
      dto.doctorClinic ?? null,
      dto.insuranceProvider ?? null,
      dto.insurancePolicy ?? null,
      dto.insuranceGroup ?? null,
      dto.bloodType ?? null,
      dto.medicalNotes ?? null,
    );
    return this.getMyMedical(personId);
  }

  private async loadFamilyDoctorInsuranceForPerson(personId: string): Promise<{
    doctorName: string | null;
    doctorPhone: string | null;
    doctorClinic: string | null;
    insuranceProvider: string | null;
    insurancePolicy: string | null;
    insuranceGroup: string | null;
  } | null> {
    const rows = await this.platform.$queryRawUnsafe<
      Array<{
        doctor_name: string | null;
        doctor_phone: string | null;
        doctor_clinic: string | null;
        insurance_provider: string | null;
        insurance_policy: string | null;
        insurance_group: string | null;
      }>
    >(
      `SELECT pf.doctor_name, pf.doctor_phone, pf.doctor_clinic,
              pf.insurance_provider, pf.insurance_policy, pf.insurance_group
       FROM platform.platform_families pf
       JOIN platform.platform_family_members pfm ON pfm.family_id = pf.id
       WHERE pfm.person_id = $1::uuid
       LIMIT 1`,
      personId,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      doctorName: r.doctor_name,
      doctorPhone: r.doctor_phone,
      doctorClinic: r.doctor_clinic,
      insuranceProvider: r.insurance_provider,
      insurancePolicy: r.insurance_policy,
      insuranceGroup: r.insurance_group,
    };
  }

  private toAdultMedicalDto(
    personId: string,
    row: {
      allergies: unknown;
      medications: unknown;
      conditions: unknown;
      medicalSource: string;
      doctorName: string | null;
      doctorPhone: string | null;
      doctorClinic: string | null;
      insuranceProvider: string | null;
      insurancePolicy: string | null;
      insuranceGroup: string | null;
      bloodType: string | null;
      medicalNotes: string | null;
    } | null,
    family: {
      doctorName: string | null;
      doctorPhone: string | null;
      doctorClinic: string | null;
      insuranceProvider: string | null;
      insurancePolicy: string | null;
      insuranceGroup: string | null;
    } | null,
  ): AdultMedicalInfoDto {
    if (!row) {
      return {
        personId,
        allergies: [],
        medications: [],
        conditions: [],
        medicalSource: 'FAMILY',
        doctorName: family?.doctorName ?? null,
        doctorPhone: family?.doctorPhone ?? null,
        doctorClinic: family?.doctorClinic ?? null,
        insuranceProvider: family?.insuranceProvider ?? null,
        insurancePolicy: family?.insurancePolicy ?? null,
        insuranceGroup: family?.insuranceGroup ?? null,
        bloodType: null,
        medicalNotes: null,
      };
    }
    const source = (row.medicalSource === 'CUSTOM' ? 'CUSTOM' : 'FAMILY') as 'FAMILY' | 'CUSTOM';
    const useFamily = source === 'FAMILY' && family !== null;
    return {
      personId,
      allergies: Array.isArray(row.allergies) ? (row.allergies as AdultAllergyEntry[]) : [],
      medications: Array.isArray(row.medications)
        ? (row.medications as AdultMedicationEntry[])
        : [],
      conditions: Array.isArray(row.conditions) ? (row.conditions as AdultConditionEntry[]) : [],
      medicalSource: source,
      doctorName: useFamily ? family!.doctorName : row.doctorName,
      doctorPhone: useFamily ? family!.doctorPhone : row.doctorPhone,
      doctorClinic: useFamily ? family!.doctorClinic : row.doctorClinic,
      insuranceProvider: useFamily ? family!.insuranceProvider : row.insuranceProvider,
      insurancePolicy: useFamily ? family!.insurancePolicy : row.insurancePolicy,
      insuranceGroup: useFamily ? family!.insuranceGroup : row.insuranceGroup,
      bloodType: row.bloodType,
      medicalNotes: row.medicalNotes,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async applyUpdate(
    personId: string,
    dto: UpdateAdminProfileDto,
    opts: { isAdmin: boolean },
  ): Promise<ProfileResponseDto> {
    const personRow = await this.loadIamPerson(personId);
    if (!personRow) throw new NotFoundException('Person not found');

    // REVIEW-CYCLE6.1 MAJOR 6 — atomic profile write across schemas.
    //
    // The previous shape ran the iam_person UPDATE in its own platform
    // tx then opened a separate tenant tx for the demographics +
    // guardian + emergency-contact writes. If section 2 failed after
    // section 1 had committed, the user saw a partial save while the
    // UI happily showed "Saved!" — a confusing failure mode flagged
    // in the architecture review.
    //
    // executeInTenantTransaction opens a Prisma $transaction on the
    // platform PrismaClient and runs `SET LOCAL search_path TO
    // tenant_X, platform, public` inside it. The same connection can
    // therefore write platform.iam_person AND tenant_X.sis_* in a
    // single atomic transaction. We move the iam_person.update inside
    // that callback so both schemas commit together or roll back
    // together.
    const personPatch = this.buildIamPersonPatch(dto, personRow, opts.isAdmin);
    await this.tenant.executeInTenantTransaction(async (tx) => {
      if (Object.keys(personPatch).length > 0) {
        personPatch.profileUpdatedAt = new Date();
        await tx.iamPerson.update({ where: { id: personId }, data: personPatch });
      }
      if (personRow.person_type === 'STUDENT') {
        await this.upsertDemographics(tx, personId, dto, opts.isAdmin);
      }
      if (personRow.person_type === 'GUARDIAN') {
        await this.upsertGuardianEmployment(tx, personId, dto);
      }
      if (dto.emergencyContact) {
        await this.upsertEmergencyContact(
          tx,
          personId,
          personRow.person_type,
          dto.emergencyContact,
        );
      }
    });

    return this.getProfile(personId);
  }

  private buildIamPersonPatch(
    dto: UpdateAdminProfileDto,
    _current: IamPersonRow,
    _isAdmin: boolean,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    // Identity + personal fields. Identity (first_name, last_name,
    // date_of_birth) is now self-editable — see the doc comment on
    // UpdateMyProfileDto. Login email is intentionally absent; that
    // change requires email verification that isn't built yet.
    const allowed: Array<keyof UpdateAdminProfileDto> = [
      'firstName',
      'lastName',
      'middleName',
      'preferredName',
      'suffix',
      'previousNames',
      'primaryPhone',
      'phoneTypePrimary',
      'secondaryPhone',
      'phoneTypeSecondary',
      'personalEmail',
      'preferredLanguage',
      'notes',
      // Self-editable on both /profile/me and /profile/:personId.
      // The admin DTO inherits this from UpdateMyProfileDto; the
      // admin DTO's own `gender` (under demographics) writes to
      // sis_student_demographics, not here.
      'gender',
      // Contact-tab fields. `employer` ALSO writes to
      // sis_guardian_employment via upsertGuardianEmployment for
      // backward compat with the legacy guardian-employment surface;
      // the iam_person column is the new platform-wide canonical.
      'addressSource',
      'customAddressLine1',
      'customAddressLine2',
      'customCity',
      'customState',
      'customPostalCode',
      'customCountry',
      'customMailingLine1',
      'customMailingLine2',
      'customMailingCity',
      'customMailingState',
      'customMailingPostalCode',
      'customMailingCountry',
      'employer',
      'jobTitle',
      // Occupation tab additions. Work phone / email moved to
      // platform_person_phones / platform_person_emails (type='WORK')
      // 2026-05-27; not editable here anymore.
      'employmentStatus',
      'industry',
      'workAddressLine1',
      'workAddressLine2',
      'workCity',
      'workState',
      'workPostalCode',
      'workCountry',
      'workLocationType',
      'occupationNotes',
      // About tab. bio is a string; interests/languages are arrays of
      // strings that Prisma persists as JSONB on the column side.
      'bio',
      'interests',
      'languages',
    ];
    for (const k of allowed) {
      if (dto[k] !== undefined) out[k as string] = dto[k];
    }

    if (dto.dateOfBirth !== undefined) {
      out.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
    }

    // Wire flips the sense: mailingAddressDifferent (positive) →
    // mailingSameAsHome (DB column, inverted). Same pattern that
    // platform_families uses for the family-side toggle.
    if (dto.mailingAddressDifferent !== undefined) {
      out.mailingSameAsHome = !dto.mailingAddressDifferent;
    }

    return out;
  }

  private async loadIamPerson(personId: string): Promise<IamPersonRow | null> {
    const rows = await this.platform.$queryRawUnsafe<IamPersonRow[]>(
      'SELECT p.id::text AS id, p.first_name, p.last_name, p.middle_name, p.preferred_name, ' +
        'p.suffix, p.previous_names, p.date_of_birth::text AS date_of_birth, ' +
        'p.gender, ' +
        'p.primary_phone, p.secondary_phone, ' +
        'p.phone_type_primary, p.phone_type_secondary, ' +
        'p.preferred_language, p.personal_email, p.notes, ' +
        'p.profile_updated_at::text AS profile_updated_at, ' +
        'p.created_at::text AS created_at, ' +
        'p.address_source, p.custom_address_line1, p.custom_address_line2, ' +
        'p.custom_city, p.custom_state, p.custom_postal_code, p.custom_country, ' +
        'p.mailing_same_as_home, ' +
        'p.custom_mailing_line1, p.custom_mailing_line2, p.custom_mailing_city, ' +
        'p.custom_mailing_state, p.custom_mailing_postal_code, p.custom_mailing_country, ' +
        'p.employer, p.job_title, ' +
        'p.employment_status, p.industry, ' +
        'p.work_address_line1, p.work_address_line2, p.work_city, p.work_state, ' +
        'p.work_postal_code, p.work_country, p.work_location_type, ' +
        'p.occupation_notes, ' +
        'p.bio, p.interests, p.languages, ' +
        'COALESCE(p.person_type::text, NULL) AS person_type, ' +
        'pu.id::text AS account_id, pu.email AS login_email ' +
        'FROM platform.iam_person p LEFT JOIN platform.platform_users pu ON pu.person_id = p.id ' +
        'WHERE p.id = $1::uuid',
      personId,
    );
    return rows[0] ?? null;
  }

  private async loadHousehold(personId: string): Promise<HouseholdRow | null> {
    const rows = await this.platform.$queryRawUnsafe<HouseholdRow[]>(
      'SELECT fm.family_id::text AS family_id, pf.name AS family_name, ' +
        'fm.member_role::text AS member_role, fm.is_primary_contact ' +
        'FROM platform.platform_family_members fm ' +
        'JOIN platform.platform_families pf ON pf.id = fm.family_id ' +
        'WHERE fm.person_id = $1::uuid LIMIT 1',
      personId,
    );
    return rows[0] ?? null;
  }

  private async loadDemographics(
    tx: PrismaClient,
    personId: string,
    personType: string | null,
  ): Promise<DemographicsRow | null> {
    if (personType !== 'STUDENT') return null;
    const rows = await tx.$queryRawUnsafe<DemographicsRow[]>(
      'SELECT d.gender, d.ethnicity, d.primary_language, d.birth_country, d.citizenship, d.medical_alert_notes ' +
        'FROM sis_student_demographics d ' +
        'JOIN sis_students s ON s.id = d.student_id ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'WHERE ps.person_id = $1::uuid LIMIT 1',
      personId,
    );
    return rows[0] ?? null;
  }

  private async loadGuardianEmployment(
    tx: PrismaClient,
    personId: string,
    personType: string | null,
  ): Promise<GuardianRow | null> {
    if (personType !== 'GUARDIAN') return null;
    const rows = await tx.$queryRawUnsafe<GuardianRow[]>(
      'SELECT id::text AS id, employer, employer_phone, occupation, work_address ' +
        'FROM sis_guardians WHERE person_id = $1::uuid LIMIT 1',
      personId,
    );
    return rows[0] ?? null;
  }

  /**
   * Dual-table emergency contact resolution per the Step 5 plan.
   *
   * STAFF persona — read hr_emergency_contacts where employee_id matches
   *   the calling person's hr_employees.id. ORDER BY is_primary DESC then
   *   sort_order ASC for a stable canonical "primary" pick.
   * STUDENT persona — read sis_emergency_contacts keyed on sis_students.id
   *   resolved via platform_students.person_id. Sort_order ASC.
   * Other personas (GUARDIAN, ALUMNI, EXTERNAL) — return null.
   *   sis_emergency_contacts is keyed on student_id, not person_id, so
   *   guardians have no current schema home for their own emergency
   *   contact. The UI surfaces this as "Not recorded".
   */
  private async loadEmergencyContact(
    tx: PrismaClient,
    personId: string,
    personType: string | null,
  ): Promise<(EmergencyContactRow & { source: 'STUDENT' | 'EMPLOYEE' }) | null> {
    if (personType === 'STAFF') {
      const rows = await tx.$queryRawUnsafe<EmergencyContactRow[]>(
        'SELECT ec.id::text AS id, ec.name, ec.relationship, ec.phone, ec.email ' +
          'FROM hr_emergency_contacts ec ' +
          'JOIN hr_employees e ON e.id = ec.employee_id ' +
          'WHERE e.person_id = $1::uuid ORDER BY ec.is_primary DESC, ec.sort_order ASC LIMIT 1',
        personId,
      );
      return rows[0] ? { ...rows[0], source: 'EMPLOYEE' } : null;
    }
    if (personType === 'STUDENT') {
      const rows = await tx.$queryRawUnsafe<EmergencyContactRow[]>(
        'SELECT ec.id::text AS id, ec.name, ec.relationship, ec.phone, NULL::text AS email ' +
          'FROM sis_emergency_contacts ec ' +
          'JOIN sis_students s ON s.id = ec.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid ORDER BY ec.sort_order ASC LIMIT 1',
        personId,
      );
      return rows[0] ? { ...rows[0], source: 'STUDENT' } : null;
    }
    return null;
  }

  private async upsertDemographics(
    tx: PrismaClient,
    personId: string,
    dto: UpdateAdminProfileDto,
    isAdmin: boolean,
  ): Promise<void> {
    // `gender` is now self-editable on iam_person (buildIamPersonPatch
    // handles that path); the demographics-side copy stays admin-only.
    // We no longer reject a non-admin who sends `gender` — the
    // demographics upsert below skips writing it when !isAdmin so the
    // admin-managed value stays untouched.
    const adminOnly = ['ethnicity', 'birthCountry', 'citizenship', 'medicalAlertNotes'];
    for (const k of adminOnly) {
      if (!isAdmin && (dto as Record<string, unknown>)[k] !== undefined) {
        throw new BadRequestException(k + ' is admin-only on demographics');
      }
    }
    // Self-edit students don't need a demographics row written when
    // they only sent gender — that value already landed on iam_person.
    const adminFieldsTouched =
      dto.gender !== undefined ||
      dto.ethnicity !== undefined ||
      dto.birthCountry !== undefined ||
      dto.citizenship !== undefined ||
      dto.medicalAlertNotes !== undefined;
    if (!isAdmin && !dto.primaryLanguage) {
      // No fields a non-admin can legitimately write here — skip.
      return;
    }
    if (
      dto.primaryLanguage === undefined &&
      dto.gender === undefined &&
      dto.ethnicity === undefined &&
      dto.birthCountry === undefined &&
      dto.citizenship === undefined &&
      dto.medicalAlertNotes === undefined
    ) {
      return;
    }
    // The variable is referenced by the SQL below via the existing
    // ternary `isAdmin ? dto.gender : null` — no further wiring needed.
    void adminFieldsTouched;
    const studentRows = await tx.$queryRawUnsafe<{ id: string }[]>(
      'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
      personId,
    );
    if (studentRows.length === 0) {
      throw new BadRequestException(
        'No sis_students row exists for this person; cannot edit demographics',
      );
    }
    await tx.$executeRawUnsafe(
      'INSERT INTO sis_student_demographics (id, student_id, gender, ethnicity, primary_language, birth_country, citizenship, medical_alert_notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8) ' +
        'ON CONFLICT (student_id) DO UPDATE SET ' +
        '  gender = COALESCE(EXCLUDED.gender, sis_student_demographics.gender), ' +
        '  ethnicity = COALESCE(EXCLUDED.ethnicity, sis_student_demographics.ethnicity), ' +
        '  primary_language = COALESCE(EXCLUDED.primary_language, sis_student_demographics.primary_language), ' +
        '  birth_country = COALESCE(EXCLUDED.birth_country, sis_student_demographics.birth_country), ' +
        '  citizenship = COALESCE(EXCLUDED.citizenship, sis_student_demographics.citizenship), ' +
        '  medical_alert_notes = COALESCE(EXCLUDED.medical_alert_notes, sis_student_demographics.medical_alert_notes), ' +
        '  updated_at = now()',
      randomUUID(),
      studentRows[0]!.id,
      isAdmin ? (dto.gender ?? null) : null,
      isAdmin ? (dto.ethnicity ?? null) : null,
      dto.primaryLanguage ?? null,
      isAdmin ? (dto.birthCountry ?? null) : null,
      isAdmin ? (dto.citizenship ?? null) : null,
      isAdmin ? (dto.medicalAlertNotes ?? null) : null,
    );
  }

  private async upsertGuardianEmployment(
    tx: PrismaClient,
    personId: string,
    dto: UpdateAdminProfileDto,
  ): Promise<void> {
    if (
      dto.employer === undefined &&
      dto.employerPhone === undefined &&
      dto.occupation === undefined &&
      dto.workAddress === undefined
    ) {
      return;
    }
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (dto.employer !== undefined) {
      setClauses.push('employer = $' + i++);
      values.push(dto.employer);
    }
    if (dto.employerPhone !== undefined) {
      setClauses.push('employer_phone = $' + i++);
      values.push(dto.employerPhone);
    }
    if (dto.occupation !== undefined) {
      setClauses.push('occupation = $' + i++);
      values.push(dto.occupation);
    }
    if (dto.workAddress !== undefined) {
      setClauses.push('work_address = $' + i++);
      values.push(dto.workAddress);
    }
    setClauses.push('updated_at = now()');
    values.push(personId);
    const sql =
      'UPDATE sis_guardians SET ' + setClauses.join(', ') + ' WHERE person_id = $' + i + '::uuid';
    const affected = await tx.$executeRawUnsafe(sql, ...values);
    if (affected === 0) {
      throw new BadRequestException(
        'No sis_guardians row exists for this person; cannot edit employment',
      );
    }
  }

  /**
   * Upsert into the right emergency contact table based on persona.
   * STAFF — hr_emergency_contacts keyed by hr_employees.id.
   * STUDENT — sis_emergency_contacts keyed by sis_students.id.
   * Other personas — refuse with a clear error rather than silently
   * dropping the data.
   */
  private async upsertEmergencyContact(
    tx: PrismaClient,
    personId: string,
    personType: string | null,
    dto: UpdateEmergencyContactDto,
  ): Promise<void> {
    if (personType === 'STAFF') {
      // REVIEW-CYCLE6.1 BLOCKING 3: lock the hr_employees parent row
      // FOR UPDATE before reading/mutating any hr_emergency_contacts
      // rows for that employee. Two concurrent PATCHes from the same
      // staff user (race tabs, double-click) now serialize on this
      // lock; the partial UNIQUE INDEX `(employee_id) WHERE is_primary
      // = true` is the schema-side belt-and-braces.
      const empRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM hr_employees WHERE person_id = $1::uuid LIMIT 1 FOR UPDATE',
        personId,
      );
      if (empRows.length === 0) {
        throw new BadRequestException('No hr_employees row for this person');
      }
      const employeeId = empRows[0]!.id;
      const isPrimary = dto.isPrimary ?? true;
      // If a primary already exists, demote it before inserting/updating
      // the new row — the schema has a partial UNIQUE INDEX on
      // (employee_id) WHERE is_primary = true.
      if (isPrimary) {
        await tx.$executeRawUnsafe(
          'UPDATE hr_emergency_contacts SET is_primary = false WHERE employee_id = $1::uuid AND is_primary = true',
          employeeId,
        );
      }
      const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM hr_emergency_contacts WHERE employee_id = $1::uuid ORDER BY sort_order ASC, created_at ASC LIMIT 1',
        employeeId,
      );
      try {
        if (existing.length > 0) {
          await tx.$executeRawUnsafe(
            'UPDATE hr_emergency_contacts SET name = $1, relationship = $2, phone = $3, email = $4, is_primary = $5, updated_at = now() WHERE id = $6::uuid',
            dto.name,
            dto.relationship ?? null,
            dto.phone ?? '',
            dto.email ?? null,
            isPrimary,
            existing[0]!.id,
          );
        } else {
          await tx.$executeRawUnsafe(
            'INSERT INTO hr_emergency_contacts (id, employee_id, name, relationship, phone, email, is_primary) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
            randomUUID(),
            employeeId,
            dto.name,
            dto.relationship ?? null,
            dto.phone ?? '',
            dto.email ?? null,
            isPrimary,
          );
        }
      } catch (err: unknown) {
        // Schema-side fallback: if the FOR UPDATE lock somehow misses
        // and the partial UNIQUE INDEX fires, surface a friendly 409.
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'Another emergency contact change is in progress. Try again in a moment.',
          );
        }
        throw err;
      }
      return;
    }
    if (personType === 'STUDENT') {
      // Same locking discipline for STUDENT: lock the sis_students
      // parent row before reading/mutating sis_emergency_contacts.
      const studentRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1 FOR UPDATE OF s',
        personId,
      );
      if (studentRows.length === 0) {
        throw new BadRequestException('No sis_students row for this person');
      }
      const studentId = studentRows[0]!.id;
      const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM sis_emergency_contacts WHERE student_id = $1::uuid ORDER BY sort_order ASC, created_at ASC LIMIT 1',
        studentId,
      );
      if (existing.length > 0) {
        await tx.$executeRawUnsafe(
          'UPDATE sis_emergency_contacts SET name = $1, relationship = $2, phone = $3, updated_at = now() WHERE id = $4::uuid',
          dto.name,
          dto.relationship ?? null,
          dto.phone ?? null,
          existing[0]!.id,
        );
      } else {
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_emergency_contacts (id, student_id, name, relationship, phone) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          randomUUID(),
          studentId,
          dto.name,
          dto.relationship ?? null,
          dto.phone ?? null,
        );
      }
      return;
    }
    throw new ForbiddenException(
      'Emergency contact storage is not yet wired for ' +
        (personType ?? 'this persona') +
        '. Only STAFF and STUDENT personas have an emergency contact table today.',
    );
  }

  // ── Response composition ─────────────────────────────────────────────

  private toResponse(
    person: IamPersonRow,
    household: HouseholdRow | null,
    bundle: {
      demographics: DemographicsRow | null;
      employment: GuardianRow | null;
      emergency: (EmergencyContactRow & { source: 'STUDENT' | 'EMPLOYEE' }) | null;
    },
  ): ProfileResponseDto {
    const emergencyDto: EmergencyContactDto | null = bundle.emergency
      ? {
          id: bundle.emergency.id,
          name: bundle.emergency.name,
          relationship: bundle.emergency.relationship,
          phone: bundle.emergency.phone,
          email: bundle.emergency.email,
          source: bundle.emergency.source,
        }
      : null;

    const demographicsDto: StudentDemographicsDto | null = bundle.demographics
      ? {
          gender: bundle.demographics.gender,
          ethnicity: bundle.demographics.ethnicity,
          primaryLanguage: bundle.demographics.primary_language,
          birthCountry: bundle.demographics.birth_country,
          citizenship: bundle.demographics.citizenship,
          medicalAlertNotes: bundle.demographics.medical_alert_notes,
        }
      : null;

    const employmentDto: GuardianEmploymentDto | null = bundle.employment
      ? {
          employer: bundle.employment.employer,
          employerPhone: bundle.employment.employer_phone,
          occupation: bundle.employment.occupation,
          workAddress: bundle.employment.work_address,
        }
      : null;

    const householdDto: HouseholdSummaryDto | null = household
      ? {
          id: household.family_id,
          name: household.family_name,
          role: household.member_role,
          isPrimaryContact: household.is_primary_contact,
        }
      : null;

    return {
      personId: person.id,
      accountId: person.account_id,
      personType: person.person_type,
      firstName: person.first_name,
      lastName: person.last_name,
      middleName: person.middle_name,
      preferredName: person.preferred_name,
      suffix: person.suffix,
      previousNames: person.previous_names ?? [],
      dateOfBirth: person.date_of_birth,
      gender: person.gender,
      loginEmail: person.login_email,
      personalEmail: person.personal_email,
      primaryPhone: person.primary_phone,
      phoneTypePrimary: person.phone_type_primary,
      secondaryPhone: person.secondary_phone,
      phoneTypeSecondary: person.phone_type_secondary,
      preferredLanguage: person.preferred_language,
      notes: person.notes,
      profileUpdatedAt: person.profile_updated_at,
      createdAt: person.created_at,
      addressSource: (person.address_source === 'CUSTOM' ? 'CUSTOM' : 'FAMILY') as
        | 'FAMILY'
        | 'CUSTOM',
      customAddressLine1: person.custom_address_line1,
      customAddressLine2: person.custom_address_line2,
      customCity: person.custom_city,
      customState: person.custom_state,
      customPostalCode: person.custom_postal_code,
      customCountry: person.custom_country,
      // DB column is the positive sense; wire format flips it.
      mailingAddressDifferent: !person.mailing_same_as_home,
      customMailingLine1: person.custom_mailing_line1,
      customMailingLine2: person.custom_mailing_line2,
      customMailingCity: person.custom_mailing_city,
      customMailingState: person.custom_mailing_state,
      customMailingPostalCode: person.custom_mailing_postal_code,
      customMailingCountry: person.custom_mailing_country,
      employer: person.employer,
      jobTitle: person.job_title,
      employmentStatus: person.employment_status,
      industry: person.industry,
      workAddressLine1: person.work_address_line1,
      workAddressLine2: person.work_address_line2,
      workCity: person.work_city,
      workState: person.work_state,
      workPostalCode: person.work_postal_code,
      workCountry: person.work_country,
      workLocationType: person.work_location_type,
      occupationNotes: person.occupation_notes,
      bio: person.bio,
      interests: Array.isArray(person.interests) ? (person.interests as string[]) : [],
      languages: Array.isArray(person.languages) ? (person.languages as string[]) : [],
      household: householdDto,
      emergencyContact: emergencyDto,
      demographics: demographicsDto,
      employment: employmentDto,
    };
  }
}
