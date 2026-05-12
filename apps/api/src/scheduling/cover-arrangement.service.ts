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
import type { ResolvedActor } from '../iam/actor-context.service';
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
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<ClassRow[]>(
        SELECT_CLASS_BASE + 'WHERE id = $1::uuid',
        id,
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
        const rows = await tx.$queryRawUnsafe<SplitRow[]>(
          SELECT_SPLIT_BASE + 'WHERE id = $1::uuid',
          id,
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
