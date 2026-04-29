import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  EmergencyContactDto,
  GuardianEmploymentDto,
  HouseholdSummaryDto,
  ProfileResponseDto,
  StudentDemographicsDto,
  UpdateAdminProfileDto,
  UpdateEmergencyContactDto,
  UpdateMyProfileDto,
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
  primary_phone: string | null;
  secondary_phone: string | null;
  work_phone: string | null;
  phone_type_primary: 'MOBILE' | 'HOME' | 'WORK' | null;
  phone_type_secondary: 'MOBILE' | 'HOME' | 'WORK' | null;
  preferred_language: string;
  personal_email: string | null;
  notes: string | null;
  profile_updated_at: string | null;
  person_type: string | null;
  account_id: string | null;
  login_email: string | null;
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
   * PATCH /profile/:personId — admin override. Adds first_name,
   * last_name, date_of_birth, and the gender / ethnicity / etc.
   * demographic fields to the allow-list.
   */
  async updateAdminProfile(
    personId: string,
    dto: UpdateAdminProfileDto,
  ): Promise<ProfileResponseDto> {
    return this.applyUpdate(personId, dto, { isAdmin: true });
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async applyUpdate(
    personId: string,
    dto: UpdateAdminProfileDto,
    opts: { isAdmin: boolean },
  ): Promise<ProfileResponseDto> {
    const personRow = await this.loadIamPerson(personId);
    if (!personRow) throw new NotFoundException('Person not found');

    // Section 1 — iam_person (platform tx). Build the SET clause
    // dynamically against the allow-list relevant to the caller.
    const personPatch = this.buildIamPersonPatch(dto, personRow, opts.isAdmin);
    if (Object.keys(personPatch).length > 0) {
      personPatch.profileUpdatedAt = new Date();
      await this.platform.iamPerson.update({ where: { id: personId }, data: personPatch });
    }

    // Section 2 — tenant-side writes wrapped in one tenant tx so the
    // demographics + guardian + emergency contact mutations either all
    // commit together against the right schema or all roll back.
    await this.tenant.executeInTenantTransaction(async (tx) => {
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
    current: IamPersonRow,
    isAdmin: boolean,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    // Always-allowed (self + admin) personal fields.
    const alwaysAllowed: Array<keyof UpdateAdminProfileDto> = [
      'middleName',
      'preferredName',
      'suffix',
      'previousNames',
      'primaryPhone',
      'phoneTypePrimary',
      'secondaryPhone',
      'phoneTypeSecondary',
      'workPhone',
      'personalEmail',
      'preferredLanguage',
      'notes',
    ];
    for (const k of alwaysAllowed) {
      if (dto[k] !== undefined) out[k as string] = dto[k];
    }

    // Admin-only identity fields. Self-service rejects with 400.
    if (dto.firstName !== undefined) {
      if (!isAdmin) {
        throw new BadRequestException(
          'first_name is admin-only. Contact your school administrator to change it.',
        );
      }
      out.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined) {
      if (!isAdmin) {
        throw new BadRequestException(
          'last_name is admin-only. Contact your school administrator to change it.',
        );
      }
      out.lastName = dto.lastName;
    }
    if (dto.dateOfBirth !== undefined) {
      // Post-set self edits rejected; admin can edit anytime.
      if (!isAdmin && current.date_of_birth) {
        throw new BadRequestException(
          'date_of_birth is admin-only after initial set. Contact your school administrator to change it.',
        );
      }
      out.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
    }

    return out;
  }

  private async loadIamPerson(personId: string): Promise<IamPersonRow | null> {
    const rows = await this.platform.$queryRawUnsafe<IamPersonRow[]>(
      'SELECT p.id::text AS id, p.first_name, p.last_name, p.middle_name, p.preferred_name, ' +
        'p.suffix, p.previous_names, p.date_of_birth::text AS date_of_birth, ' +
        'p.primary_phone, p.secondary_phone, p.work_phone, ' +
        'p.phone_type_primary, p.phone_type_secondary, ' +
        'p.preferred_language, p.personal_email, p.notes, ' +
        'p.profile_updated_at::text AS profile_updated_at, ' +
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
    const adminOnly = ['gender', 'ethnicity', 'birthCountry', 'citizenship', 'medicalAlertNotes'];
    for (const k of adminOnly) {
      if (!isAdmin && (dto as Record<string, unknown>)[k] !== undefined) {
        throw new BadRequestException(k + ' is admin-only on demographics');
      }
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
      const empRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM hr_employees WHERE person_id = $1::uuid LIMIT 1',
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
      return;
    }
    if (personType === 'STUDENT') {
      const studentRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
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
      loginEmail: person.login_email,
      personalEmail: person.personal_email,
      primaryPhone: person.primary_phone,
      phoneTypePrimary: person.phone_type_primary,
      secondaryPhone: person.secondary_phone,
      phoneTypeSecondary: person.phone_type_secondary,
      workPhone: person.work_phone,
      preferredLanguage: person.preferred_language,
      notes: person.notes,
      profileUpdatedAt: person.profile_updated_at,
      household: householdDto,
      emergencyContact: emergencyDto,
      demographics: demographicsDto,
      employment: employmentDto,
    };
  }
}
