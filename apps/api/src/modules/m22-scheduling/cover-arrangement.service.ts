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
import {
  AddCoverClassDto,
  AddCoverSplitStudentsDto,
  CoverArrangementClassResponseDto,
  CoverArrangementResponseDto,
  CoverSplitStudentResponseDto,
  CreateCoverArrangementDto,
  UpdateCoverArrangementStatusDto,
} from './dto/scheduling-advanced-b.dto';

/*
 * CoverArrangementService — P2-17b.
 *
 * Owns sch_cover_arrangements + sch_cover_arrangement_classes +
 * sch_cover_split_students. Higher-level coordination layer above the
 * Cycle 5 sch_coverage_requests table — that table is per-(slot date)
 * granular; this is per-(school absent_teacher date) and groups every
 * class the absent teacher would have taught under a single
 * arrangement with a per-class disposition.
 */

interface ArrangementRow {
  id: string;
  school_id: string;
  absent_teacher_id: string;
  cover_date: string;
  cover_type: string;
  sub_assignment_id: string | null;
  covering_teacher_id: string | null;
  status: string;
  completed_at: string | null;
  notes: string | null;
}

interface ClassRow {
  id: string;
  arrangement_id: string;
  affected_class_id: string;
  affected_slot_id: string;
  disposition: string;
  destination_room_id: string | null;
  supervising_teacher_id: string | null;
  notes: string | null;
}

interface SplitRow {
  id: string;
  arrangement_class_id: string;
  student_id: string;
  destination_class_label: string | null;
  destination_room_id: string | null;
  supervising_teacher_id: string | null;
  notes: string | null;
}

const SELECT_ARRANGEMENT_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, ' +
  'absent_teacher_id::text AS absent_teacher_id, ' +
  "to_char(cover_date, 'YYYY-MM-DD') AS cover_date, " +
  'cover_type, sub_assignment_id::text AS sub_assignment_id, ' +
  'covering_teacher_id::text AS covering_teacher_id, status, ' +
  'to_char(completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, notes ' +
  'FROM sch_cover_arrangements ';

const SELECT_CLASS_BASE =
  'SELECT id::text AS id, arrangement_id::text AS arrangement_id, ' +
  'affected_class_id::text AS affected_class_id, affected_slot_id::text AS affected_slot_id, ' +
  'disposition, destination_room_id::text AS destination_room_id, ' +
  'supervising_teacher_id::text AS supervising_teacher_id, notes ' +
  'FROM sch_cover_arrangement_classes ';

const SELECT_SPLIT_BASE =
  'SELECT id::text AS id, arrangement_class_id::text AS arrangement_class_id, ' +
  'student_id::text AS student_id, destination_class_label, ' +
  'destination_room_id::text AS destination_room_id, ' +
  'supervising_teacher_id::text AS supervising_teacher_id, notes ' +
  'FROM sch_cover_split_students ';

function splitRowToDto(row: SplitRow): CoverSplitStudentResponseDto {
  return {
    id: row.id,
    arrangementClassId: row.arrangement_class_id,
    studentId: row.student_id,
    destinationClassLabel: row.destination_class_label,
    destinationRoomId: row.destination_room_id,
    supervisingTeacherId: row.supervising_teacher_id,
    notes: row.notes,
  };
}

function classRowToDto(row: ClassRow, splits: SplitRow[]): CoverArrangementClassResponseDto {
  return {
    id: row.id,
    arrangementId: row.arrangement_id,
    affectedClassId: row.affected_class_id,
    affectedSlotId: row.affected_slot_id,
    disposition: row.disposition as CoverArrangementClassResponseDto['disposition'],
    destinationRoomId: row.destination_room_id,
    supervisingTeacherId: row.supervising_teacher_id,
    notes: row.notes,
    splitStudents: splits.map(splitRowToDto),
  };
}

function arrangementRowToDto(
  row: ArrangementRow,
  classes: CoverArrangementClassResponseDto[],
): CoverArrangementResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    absentTeacherId: row.absent_teacher_id,
    coverDate: row.cover_date,
    coverType: row.cover_type as CoverArrangementResponseDto['coverType'],
    subAssignmentId: row.sub_assignment_id,
    coveringTeacherId: row.covering_teacher_id,
    status: row.status as CoverArrangementResponseDto['status'],
    completedAt: row.completed_at,
    notes: row.notes,
    classes,
  };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string } };
  return err.code === 'P2010' || err.meta?.code === '23505';
}

@Injectable()
export class CoverArrangementService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCoverScope(actor: ResolvedActor): void {
    // sch-004:write is the coverage scope (mirrors Cycle 5 CoverageService).
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Cover arrangement writes require sch-004:write (school admin or cover coordinator).',
      );
    }
  }

  async listForDate(coverDate: string): Promise<CoverArrangementResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<ArrangementRow[]>(
        SELECT_ARRANGEMENT_BASE +
          'WHERE school_id = $1::uuid AND cover_date = $2::date ORDER BY status, created_at',
        tenant.schoolId,
        coverDate,
      );
      return Promise.all(rows.map((r) => this.hydrate(client, r)));
    });
  }

  async getById(id: string): Promise<CoverArrangementResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<ArrangementRow[]>(
        SELECT_ARRANGEMENT_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Cover arrangement not found');
      return this.hydrate(client, rows[0]!);
    });
  }

  async create(
    body: CreateCoverArrangementDto,
    actor: ResolvedActor,
  ): Promise<CoverArrangementResponseDto> {
    this.assertCoverScope(actor);
    const tenant = getCurrentTenant();

    // REVIEW-P2C17 BLOCKING 6 — validate the absent + covering teachers
    // and any linked sub_assignment all belong to the current school
    // BEFORE inserting the arrangement. sub_assignments has no direct
    // school_id column; school ownership is reached through
    // sub_job_postings.school_id (Cycle P2-9).
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const refs = await client.$queryRawUnsafe<
        Array<{ absent_ok: boolean; covering_ok: boolean; sub_ok: boolean }>
      >(
        'SELECT ' +
          '(EXISTS (SELECT 1 FROM hr_employees WHERE id = $1::uuid AND school_id = $4::uuid)) AS absent_ok, ' +
          '($2::uuid IS NULL OR EXISTS (SELECT 1 FROM hr_employees WHERE id = $2::uuid AND school_id = $4::uuid)) AS covering_ok, ' +
          '($3::uuid IS NULL OR EXISTS (SELECT 1 FROM sub_assignments sa JOIN sub_job_postings jp ON jp.id = sa.job_id WHERE sa.id = $3::uuid AND jp.school_id = $4::uuid)) AS sub_ok',
        body.absentTeacherId,
        body.coveringTeacherId ?? null,
        body.subAssignmentId ?? null,
        tenant.schoolId,
      );
      const r = refs[0]!;
      if (!r.absent_ok) {
        throw new BadRequestException('absentTeacherId does not match an employee in this school.');
      }
      if (!r.covering_ok) {
        throw new BadRequestException(
          'coveringTeacherId does not match an employee in this school.',
        );
      }
      if (!r.sub_ok) {
        throw new BadRequestException(
          'subAssignmentId does not match a sub assignment in this school.',
        );
      }
    });

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_cover_arrangements (id, school_id, absent_teacher_id, cover_date, cover_type, sub_assignment_id, covering_teacher_id, notes, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9::uuid)',
        id,
        tenant.schoolId,
        body.absentTeacherId,
        body.coverDate,
        body.coverType,
        body.subAssignmentId ?? null,
        body.coveringTeacherId ?? null,
        body.notes ?? null,
        actor.accountId,
      );
    });
    return this.getById(id);
  }

  async patchStatus(
    id: string,
    body: UpdateCoverArrangementStatusDto,
    actor: ResolvedActor,
  ): Promise<CoverArrangementResponseDto> {
    this.assertCoverScope(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ status: string }[]>(
        'SELECT status FROM sch_cover_arrangements WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Cover arrangement not found');
      const current = rows[0]!.status;
      if (current === 'COMPLETED' && body.status !== 'COMPLETED') {
        throw new BadRequestException('COMPLETED arrangements cannot be re-opened.');
      }
      const completedAt = body.status === 'COMPLETED' ? 'now()' : 'NULL';
      await tx.$executeRawUnsafe(
        'UPDATE sch_cover_arrangements SET status = $1, completed_at = ' +
          completedAt +
          ', notes = COALESCE($2, notes), updated_at = now() WHERE id = $3::uuid',
        body.status,
        body.notes ?? null,
        id,
      );
    });
    return this.getById(id);
  }

  async addClass(
    arrangementId: string,
    body: AddCoverClassDto,
    actor: ResolvedActor,
  ): Promise<CoverArrangementClassResponseDto> {
    this.assertCoverScope(actor);
    await this.assertArrangementExists(arrangementId);

    // REVIEW-P2C17 BLOCKING 6 — validate every child reference
    // belongs to the current school.
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const refs = await client.$queryRawUnsafe<
        Array<{
          class_ok: boolean;
          slot_ok: boolean;
          room_ok: boolean;
          teacher_ok: boolean;
        }>
      >(
        'SELECT ' +
          '(EXISTS (SELECT 1 FROM sis_classes WHERE id = $1::uuid AND school_id = $5::uuid)) AS class_ok, ' +
          '(EXISTS (SELECT 1 FROM sch_timetable_slots WHERE id = $2::uuid AND school_id = $5::uuid)) AS slot_ok, ' +
          '($3::uuid IS NULL OR EXISTS (SELECT 1 FROM sch_rooms WHERE id = $3::uuid AND school_id = $5::uuid)) AS room_ok, ' +
          '($4::uuid IS NULL OR EXISTS (SELECT 1 FROM hr_employees WHERE id = $4::uuid AND school_id = $5::uuid)) AS teacher_ok',
        body.affectedClassId,
        body.affectedSlotId,
        body.destinationRoomId ?? null,
        body.supervisingTeacherId ?? null,
        tenant.schoolId,
      );
      const r = refs[0]!;
      if (!r.class_ok) {
        throw new BadRequestException('affectedClassId does not match a class in this school.');
      }
      if (!r.slot_ok) {
        throw new BadRequestException(
          'affectedSlotId does not match a timetable slot in this school.',
        );
      }
      if (!r.room_ok) {
        throw new BadRequestException('destinationRoomId does not match a room in this school.');
      }
      if (!r.teacher_ok) {
        throw new BadRequestException(
          'supervisingTeacherId does not match an employee in this school.',
        );
      }
    });

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_cover_arrangement_classes (id, arrangement_id, affected_class_id, affected_slot_id, disposition, destination_room_id, supervising_teacher_id, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8)',
          id,
          arrangementId,
          body.affectedClassId,
          body.affectedSlotId,
          body.disposition,
          body.destinationRoomId ?? null,
          body.supervisingTeacherId ?? null,
          body.notes ?? null,
        );
      });
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          'A disposition for this (arrangement slot) already exists — edit that row instead.',
        );
      }
      throw e;
    }
    // REVIEW-P2C17 BLOCKING 6 — reload joins through the parent
    // arrangement school predicate so foreign-school child rows can
    // never surface even by direct ID.
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<ClassRow[]>(
        'SELECT cc.id::text AS id, cc.arrangement_id::text AS arrangement_id, ' +
          'cc.affected_class_id::text AS affected_class_id, cc.affected_slot_id::text AS affected_slot_id, ' +
          'cc.disposition, cc.destination_room_id::text AS destination_room_id, ' +
          'cc.supervising_teacher_id::text AS supervising_teacher_id, cc.notes ' +
          'FROM sch_cover_arrangement_classes cc ' +
          'JOIN sch_cover_arrangements a ON a.id = cc.arrangement_id ' +
          'WHERE cc.id = $1::uuid AND a.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
      return classRowToDto(rows[0]!, []);
    });
  }

  async addSplitStudents(
    arrangementClassId: string,
    body: AddCoverSplitStudentsDto,
    actor: ResolvedActor,
  ): Promise<CoverSplitStudentResponseDto[]> {
    this.assertCoverScope(actor);
    await this.assertArrangementClassExists(arrangementClassId);

    // REVIEW-P2C17 BLOCKING 6 — validate every student id + optional
    // room id + supervising teacher id belongs to the current school
    // BEFORE inserting. A School A coordinator who supplies a School
    // B student UUID now gets 400 here.
    const tenant = getCurrentTenant();
    const studentIds = body.students.map((s) => s.studentId);
    const roomIds = body.students
      .map((s) => s.destinationRoomId)
      .filter((x): x is string => x !== undefined);
    const teacherIds = body.students
      .map((s) => s.supervisingTeacherId)
      .filter((x): x is string => x !== undefined);

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Students.
      if (studentIds.length > 0) {
        const studentRows = await client.$queryRawUnsafe<Array<{ id: string }>>(
          "SELECT id::text AS id FROM sis_students WHERE school_id = $1::uuid AND id = ANY(string_to_array($2, ',')::uuid[])",
          tenant.schoolId,
          studentIds.join(','),
        );
        const knownStudents = new Set(studentRows.map((r) => r.id));
        for (const sid of studentIds) {
          if (!knownStudents.has(sid)) {
            throw new BadRequestException(
              'students[].studentId ' + sid + ' does not match a student in this school.',
            );
          }
        }
      }
      // Rooms (optional per row).
      if (roomIds.length > 0) {
        const roomRows = await client.$queryRawUnsafe<Array<{ id: string }>>(
          "SELECT id::text AS id FROM sch_rooms WHERE school_id = $1::uuid AND id = ANY(string_to_array($2, ',')::uuid[])",
          tenant.schoolId,
          roomIds.join(','),
        );
        const knownRooms = new Set(roomRows.map((r) => r.id));
        for (const rid of roomIds) {
          if (!knownRooms.has(rid)) {
            throw new BadRequestException(
              'students[].destinationRoomId ' + rid + ' does not match a room in this school.',
            );
          }
        }
      }
      // Supervising teachers (optional per row).
      if (teacherIds.length > 0) {
        const teacherRows = await client.$queryRawUnsafe<Array<{ id: string }>>(
          "SELECT id::text AS id FROM hr_employees WHERE school_id = $1::uuid AND id = ANY(string_to_array($2, ',')::uuid[])",
          tenant.schoolId,
          teacherIds.join(','),
        );
        const knownTeachers = new Set(teacherRows.map((r) => r.id));
        for (const tid of teacherIds) {
          if (!knownTeachers.has(tid)) {
            throw new BadRequestException(
              'students[].supervisingTeacherId ' +
                tid +
                ' does not match an employee in this school.',
            );
          }
        }
      }
    });

    const inserted: CoverSplitStudentResponseDto[] = [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      for (const s of body.students) {
        const id = generateId();
        try {
          await tx.$executeRawUnsafe(
            'INSERT INTO sch_cover_split_students (id, arrangement_class_id, student_id, destination_class_label, destination_room_id, supervising_teacher_id, notes) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, NULL)',
            id,
            arrangementClassId,
            s.studentId,
            s.destinationClassLabel ?? null,
            s.destinationRoomId ?? null,
            s.supervisingTeacherId ?? null,
          );
        } catch (e: unknown) {
          if (isUniqueViolation(e)) {
            throw new ConflictException(
              'Student ' +
                s.studentId +
                ' is already assigned to a split group in this arrangement — remove the existing assignment first.',
            );
          }
          throw e;
        }
        // REVIEW-P2C17 BLOCKING 6 — reload joins through parent
        // arrangement_class -> arrangement -> school so foreign-school
        // rows cannot leak even by direct ID.
        const rows = await tx.$queryRawUnsafe<SplitRow[]>(
          'SELECT ss.id::text AS id, ss.arrangement_class_id::text AS arrangement_class_id, ' +
            'ss.student_id::text AS student_id, ss.destination_class_label, ' +
            'ss.destination_room_id::text AS destination_room_id, ' +
            'ss.supervising_teacher_id::text AS supervising_teacher_id, ss.notes ' +
            'FROM sch_cover_split_students ss ' +
            'JOIN sch_cover_arrangement_classes cc ON cc.id = ss.arrangement_class_id ' +
            'JOIN sch_cover_arrangements a ON a.id = cc.arrangement_id ' +
            'WHERE ss.id = $1::uuid AND a.school_id = $2::uuid',
          id,
          tenant.schoolId,
        );
        inserted.push(splitRowToDto(rows[0]!));
      }
    });
    return inserted;
  }

  // ── Internal helpers ──────────────────────────────────────
  // hydrate takes a Prisma client (or transaction client). Typed as
  // any because Prisma's $queryRawUnsafe generic signature doesn't
  // unify cleanly with a structural narrowing here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async hydrate(
    client: any,
    arrangement: ArrangementRow,
  ): Promise<CoverArrangementResponseDto> {
    const classRows = (await client.$queryRawUnsafe(
      SELECT_CLASS_BASE + 'WHERE arrangement_id = $1::uuid ORDER BY created_at ASC',
      arrangement.id,
    )) as ClassRow[];
    const classIds = classRows.map((r) => r.id);
    const splits = classIds.length
      ? ((await client.$queryRawUnsafe(
          SELECT_SPLIT_BASE +
            "WHERE arrangement_class_id = ANY(string_to_array($1, ',')::uuid[]) ORDER BY destination_class_label NULLS LAST",
          classIds.join(','),
        )) as SplitRow[])
      : [];
    const splitsByClass = new Map<string, SplitRow[]>();
    for (const s of splits) {
      const arr = splitsByClass.get(s.arrangement_class_id) ?? [];
      arr.push(s);
      splitsByClass.set(s.arrangement_class_id, arr);
    }
    const classes = classRows.map((c) => classRowToDto(c, splitsByClass.get(c.id) ?? []));
    return arrangementRowToDto(arrangement, classes);
  }

  private async assertArrangementExists(arrangementId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM sch_cover_arrangements WHERE id = $1::uuid AND school_id = $2::uuid',
        arrangementId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Cover arrangement not found');
  }

  private async assertArrangementClassExists(arrangementClassId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT c.id::text AS id FROM sch_cover_arrangement_classes c ' +
          'JOIN sch_cover_arrangements a ON a.id = c.arrangement_id ' +
          'WHERE c.id = $1::uuid AND a.school_id = $2::uuid',
        arrangementClassId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Cover arrangement class not found');
  }
}
