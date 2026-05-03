import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';

export type ChildLinkRequestType = 'LINK_EXISTING' | 'ADD_NEW';
export type ChildLinkRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ChildSearchResultDto {
  studentId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  gradeLevel: string | null;
  schoolName: string | null;
  studentNumber: string | null;
}

export interface ChildLinkRequestDto {
  id: string;
  schoolId: string;
  requestingGuardianId: string;
  requestingGuardianName: string | null;
  requestType: ChildLinkRequestType;
  existingStudentId: string | null;
  existingStudentName: string | null;
  newChildFirstName: string | null;
  newChildLastName: string | null;
  newChildDateOfBirth: string | null;
  newChildGender: string | null;
  newChildGradeLevel: string | null;
  status: ChildLinkRequestStatus;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RequestRow {
  id: string;
  school_id: string;
  requesting_guardian_id: string;
  guardian_first_name: string | null;
  guardian_last_name: string | null;
  request_type: string;
  existing_student_id: string | null;
  existing_first_name: string | null;
  existing_last_name: string | null;
  new_child_first_name: string | null;
  new_child_last_name: string | null;
  new_child_date_of_birth: string | null;
  new_child_gender: string | null;
  new_child_grade_level: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_REQUEST_BASE =
  'SELECT r.id, r.school_id, r.requesting_guardian_id, ' +
  'g_ip.first_name AS guardian_first_name, g_ip.last_name AS guardian_last_name, ' +
  'r.request_type, r.existing_student_id, ' +
  's_ip.first_name AS existing_first_name, s_ip.last_name AS existing_last_name, ' +
  'r.new_child_first_name, r.new_child_last_name, ' +
  "TO_CHAR(r.new_child_date_of_birth, 'YYYY-MM-DD') AS new_child_date_of_birth, " +
  'r.new_child_gender, r.new_child_grade_level, ' +
  'r.status, r.reviewed_by, r.reviewed_at, r.reviewer_notes, ' +
  'r.created_at, r.updated_at ' +
  'FROM sis_child_link_requests r ' +
  'JOIN sis_guardians g ON g.id = r.requesting_guardian_id ' +
  'LEFT JOIN platform.iam_person g_ip ON g_ip.id = g.person_id ' +
  'LEFT JOIN sis_students st ON st.id = r.existing_student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
  'LEFT JOIN platform.iam_person s_ip ON s_ip.id = ps.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(row: RequestRow): ChildLinkRequestDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    requestingGuardianId: row.requesting_guardian_id,
    requestingGuardianName: fullName(row.guardian_first_name, row.guardian_last_name),
    requestType: row.request_type as ChildLinkRequestType,
    existingStudentId: row.existing_student_id,
    existingStudentName: fullName(row.existing_first_name, row.existing_last_name),
    newChildFirstName: row.new_child_first_name,
    newChildLastName: row.new_child_last_name,
    newChildDateOfBirth: row.new_child_date_of_birth,
    newChildGender: row.new_child_gender,
    newChildGradeLevel: row.new_child_grade_level,
    status: row.status as ChildLinkRequestStatus,
    reviewedById: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewerNotes: row.reviewer_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class ChildLinkRequestService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Search the current tenant's sis_students for matches on
   * (first_name, last_name, date_of_birth). Returns up to 25 rows. The DOB
   * comparison is exact since iam_person.date_of_birth is the canonical
   * field. Used by the parent-facing "Add Child" flow to surface existing
   * records and avoid duplicate student creation.
   */
  async searchExistingStudents(
    firstName: string,
    lastName: string,
    dateOfBirth: string,
    actor: ResolvedActor,
  ): Promise<ChildSearchResultDto[]> {
    if (actor.personType !== 'GUARDIAN' && !actor.isSchoolAdmin) {
      throw new ForbiddenException('Only guardians and admins can search students');
    }
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn || !ln || !dateOfBirth) {
      throw new BadRequestException('firstName, lastName, and dateOfBirth are all required');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          first_name: string;
          last_name: string;
          grade_level: string | null;
          student_number: string | null;
          school_name: string | null;
        }>
      >(
        'SELECT s.id, ip.first_name, ip.last_name, s.grade_level, s.student_number, ' +
          'sc.name AS school_name ' +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'LEFT JOIN platform.schools sc ON sc.id = s.school_id ' +
          'WHERE LOWER(ip.first_name) = LOWER($1) ' +
          'AND LOWER(ip.last_name) = LOWER($2) ' +
          'AND ip.date_of_birth = $3::date ' +
          'LIMIT 25',
        fn,
        ln,
        dateOfBirth,
      );
    });
    return rows.map((r) => ({
      studentId: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      fullName: r.first_name + ' ' + r.last_name,
      gradeLevel: r.grade_level,
      schoolName: r.school_name,
      studentNumber: r.student_number,
    }));
  }

  /**
   * Resolve the calling guardian's sis_guardians.id for the current tenant.
   * Throws if the actor is not a guardian or has no row in this tenant.
   */
  private async resolveGuardianId(actor: ResolvedActor): Promise<string> {
    if (actor.personType !== 'GUARDIAN') {
      throw new ForbiddenException('Only guardians can submit child link requests');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_guardians WHERE person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException(
        'No guardian record found for this account in this school. Contact the school office.',
      );
    }
    return rows[0]!.id;
  }

  /**
   * Submit a request to LINK an existing student to the guardian's account.
   */
  async submitLinkExisting(
    existingStudentId: string,
    actor: ResolvedActor,
  ): Promise<ChildLinkRequestDto> {
    const guardianId = await this.resolveGuardianId(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Confirm the target student exists in this tenant.
      const exists = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_students WHERE id = $1::uuid',
        existingStudentId,
      );
      if (exists.length === 0) {
        throw new NotFoundException('Student ' + existingStudentId);
      }
      // Refuse if the guardian is already linked to this student.
      const linked = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT sg.id FROM sis_student_guardians sg ' +
          'WHERE sg.student_id = $1::uuid AND sg.guardian_id = $2::uuid',
        existingStudentId,
        guardianId,
      );
      if (linked.length > 0) {
        throw new ConflictException('You are already linked to this student');
      }
      // Refuse if a PENDING request already exists for the same (guardian, student) pair.
      const dup = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_child_link_requests ' +
          "WHERE requesting_guardian_id = $1::uuid AND existing_student_id = $2::uuid AND status = 'PENDING'",
        guardianId,
        existingStudentId,
      );
      if (dup.length > 0) {
        throw new ConflictException('You already have a pending request for this student');
      }
      await client.$executeRawUnsafe(
        'INSERT INTO sis_child_link_requests (id, school_id, requesting_guardian_id, request_type, existing_student_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'LINK_EXISTING', $4::uuid)",
        id,
        tenant.schoolId,
        guardianId,
        existingStudentId,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Submit a request to ADD a new child to the guardian's account.
   */
  async submitAddNew(
    payload: {
      firstName: string;
      lastName: string;
      dateOfBirth: string;
      gender?: string;
      gradeLevel: string;
    },
    actor: ResolvedActor,
  ): Promise<ChildLinkRequestDto> {
    const guardianId = await this.resolveGuardianId(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sis_child_link_requests (id, school_id, requesting_guardian_id, request_type, ' +
          'new_child_first_name, new_child_last_name, new_child_date_of_birth, new_child_gender, new_child_grade_level) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ADD_NEW', $4, $5, $6::date, $7, $8)",
        id,
        tenant.schoolId,
        guardianId,
        payload.firstName.trim(),
        payload.lastName.trim(),
        payload.dateOfBirth,
        payload.gender ?? null,
        payload.gradeLevel,
      );
    });
    return this.getById(id, actor);
  }

  async getById(id: string, actor: ResolvedActor): Promise<ChildLinkRequestDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE r.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Child link request ' + id);
    const row = rows[0]!;
    if (!actor.isSchoolAdmin) {
      // Parents only see their own requests.
      const guardianId = await this.resolveGuardianId(actor);
      if (row.requesting_guardian_id !== guardianId) {
        throw new NotFoundException('Child link request ' + id);
      }
    }
    return rowToDto(row);
  }

  /**
   * List requests. Parents see only their own; admins see all (optionally
   * filtered by status).
   */
  async list(
    filter: { status?: ChildLinkRequestStatus },
    actor: ResolvedActor,
  ): Promise<ChildLinkRequestDto[]> {
    let sql: string;
    let params: any[];
    if (actor.isSchoolAdmin) {
      sql =
        SELECT_REQUEST_BASE +
        'WHERE ($1::text IS NULL OR r.status = $1::text) ' +
        'ORDER BY r.created_at DESC';
      params = [filter.status ?? null];
    } else {
      const guardianId = await this.resolveGuardianId(actor);
      sql =
        SELECT_REQUEST_BASE +
        'WHERE r.requesting_guardian_id = $1::uuid ' +
        'AND ($2::text IS NULL OR r.status = $2::text) ' +
        'ORDER BY r.created_at DESC';
      params = [guardianId, filter.status ?? null];
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RequestRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  /**
   * Admin: approve a PENDING request. Atomically writes the link rows for
   * LINK_EXISTING or creates the iam_person + platform_students +
   * sis_students + link rows for ADD_NEW. Emits iam.child.linked on success.
   */
  async approve(
    id: string,
    notes: string | undefined,
    actor: ResolvedActor,
  ): Promise<ChildLinkRequestDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can approve link requests');
    }
    const tenant = getCurrentTenant();
    let resultingStudentId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE r.id = $1::uuid FOR UPDATE OF r',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Child link request ' + id);
      const req = rows[0]!;
      if (req.status !== 'PENDING') {
        throw new BadRequestException('Only PENDING requests can be approved');
      }
      // Resolve the guardian's person + family.
      const gRows = await tx.$queryRawUnsafe<
        Array<{ person_id: string; family_id: string | null }>
      >(
        'SELECT person_id, family_id FROM sis_guardians WHERE id = $1::uuid',
        req.requesting_guardian_id,
      );
      const guardianPersonId = gRows[0]?.person_id;
      if (!guardianPersonId) {
        throw new NotFoundException('Guardian record was deleted');
      }
      // Find the platform_families row keyed via platform_family_members on
      // the guardian's person_id (the household + role model added in
      // Cycle 6.1). Fall back to null when the guardian isn't in a
      // household — the link still completes, just without a household
      // membership row.
      const famRows = (await tx.$queryRawUnsafe(
        'SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid LIMIT 1',
        guardianPersonId,
      )) as Array<{ family_id: string }>;
      const familyId = famRows.length > 0 ? famRows[0]!.family_id : null;

      let studentSisId: string;
      let studentPersonId: string;
      if (req.request_type === 'LINK_EXISTING') {
        if (!req.existing_student_id) throw new BadRequestException('Missing existing_student_id');
        studentSisId = req.existing_student_id;
        const sRows = await tx.$queryRawUnsafe<Array<{ person_id: string }>>(
          'SELECT ps.person_id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid',
          studentSisId,
        );
        if (sRows.length === 0) throw new NotFoundException('Student row was deleted');
        studentPersonId = sRows[0]!.person_id;
      } else {
        // ADD_NEW: create iam_person + platform_students + sis_students.
        const personId = generateId();
        const platformStudentId = generateId();
        const sisStudentId = generateId();
        const studentNumber = 'S-' + Date.now().toString(36).toUpperCase();
        await tx.iamPerson.create({
          data: {
            id: personId,
            firstName: req.new_child_first_name!,
            lastName: req.new_child_last_name!,
            dateOfBirth: req.new_child_date_of_birth ? new Date(req.new_child_date_of_birth) : null,
            personType: 'STUDENT',
            isActive: true,
          },
        });
        await tx.platformStudent.create({
          data: {
            id: platformStudentId,
            personId,
            firstName: req.new_child_first_name!,
            lastName: req.new_child_last_name!,
            dateOfBirth: req.new_child_date_of_birth ? new Date(req.new_child_date_of_birth) : null,
            isActive: true,
            dataSubjectIsSelf: false,
          },
        });
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ENROLLED')",
          sisStudentId,
          platformStudentId,
          tenant.schoolId,
          studentNumber,
          req.new_child_grade_level,
        );
        studentSisId = sisStudentId;
        studentPersonId = personId;
      }
      // Idempotently link the guardian to the student.
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_student_guardians (id, student_id, guardian_id, has_custody, is_emergency_contact, receives_reports, portal_access, portal_access_scope) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true, true, 'FULL') " +
          'ON CONFLICT (student_id, guardian_id) DO NOTHING',
        generateId(),
        studentSisId,
        req.requesting_guardian_id,
      );
      // Idempotently add the student to the guardian's household if one exists.
      if (familyId) {
        await tx.$executeRawUnsafe(
          'INSERT INTO platform.platform_family_members (id, family_id, person_id, member_role, is_primary_contact, joined_at, created_at, updated_at) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, 'CHILD', false, now(), now(), now()) " +
            'ON CONFLICT (person_id) DO NOTHING',
          generateId(),
          familyId,
          studentPersonId,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_child_link_requests SET ' +
          "status = 'APPROVED', reviewed_by = $1::uuid, reviewed_at = now(), reviewer_notes = $2, updated_at = now() " +
          'WHERE id = $3::uuid',
        actor.accountId,
        notes ?? null,
        id,
      );
      resultingStudentId = studentSisId;
    });

    void this.kafka.emit({
      topic: 'iam.child.linked',
      key: id,
      sourceModule: 'sis',
      payload: {
        requestId: id,
        studentId: resultingStudentId,
        approvedBy: actor.accountId,
      },
    });
    return this.getById(id, actor);
  }

  async reject(
    id: string,
    notes: string | undefined,
    actor: ResolvedActor,
  ): Promise<ChildLinkRequestDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can reject link requests');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE r.id = $1::uuid FOR UPDATE OF r',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Child link request ' + id);
      if (rows[0]!.status !== 'PENDING') {
        throw new BadRequestException('Only PENDING requests can be rejected');
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_child_link_requests SET ' +
          "status = 'REJECTED', reviewed_by = $1::uuid, reviewed_at = now(), reviewer_notes = $2, updated_at = now() " +
          'WHERE id = $3::uuid',
        actor.accountId,
        notes ?? null,
        id,
      );
    });
    return this.getById(id, actor);
  }
}
