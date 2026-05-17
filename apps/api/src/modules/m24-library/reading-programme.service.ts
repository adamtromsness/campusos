import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CreateReadingProgrammeDto,
  ReadingProgrammeAudienceType,
  ReadingProgrammeLeaderboardEntryDto,
  ReadingProgrammeProgressDto,
  ReadingProgrammeResponseDto,
  UpdateReadingProgrammeDto,
} from './dto/library.dto';

interface ProgrammeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  academic_year_id: string | null;
  target_books: number | null;
  target_pages: number | null;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  target_audience_type: string;
  target_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
  programme_id: string;
  student_id: string;
  books_read: number;
  pages_read: number;
  is_complete: boolean;
  last_updated_at: string | null;
}

interface LeaderboardRow {
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  books_read: number;
  pages_read: number;
  is_complete: boolean;
}

const SELECT_PROGRAMME_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
  'academic_year_id::text AS academic_year_id, target_books, target_pages, ' +
  "TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date, " +
  'is_active, target_audience_type, target_id::text AS target_id, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_reading_programmes ';

function rowToProgrammeDto(r: ProgrammeRow): ReadingProgrammeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    academicYearId: r.academic_year_id,
    targetBooks: r.target_books,
    targetPages: r.target_pages,
    startDate: r.start_date,
    endDate: r.end_date,
    isActive: r.is_active,
    targetAudienceType: r.target_audience_type as ReadingProgrammeAudienceType,
    targetId: r.target_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToProgressDto(r: ProgressRow): ReadingProgrammeProgressDto {
  return {
    programmeId: r.programme_id,
    studentId: r.student_id,
    booksRead: r.books_read,
    pagesRead: r.pages_read,
    isComplete: r.is_complete,
    lastUpdatedAt: r.last_updated_at,
  };
}

@Injectable()
export class ReadingProgrammeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Librarian / teacher scope: admin OR (non-student STAFF holding
   * lib-003:write). Students hold lib-003:write per the IAM seed (so
   * they can self-service log reading + write reviews) but they are
   * NOT authors of reading programmes — the personType guard is the
   * actual gate. Without it, a student would pass the IAM check and
   * create a programme, which is wrong.
   */
  private async hasWriterScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType === 'STUDENT') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-003:write',
    ]);
  }

  /**
   * Resolve the calling student's sis_students.id via
   * actor.personId → platform_students → sis_students. Used to
   * inline the calling student's myProgress on programme reads.
   */
  private async resolveCallerStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid',
        actor.personId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) return null;
      return rows[0]!.id;
    });
  }

  async list(
    actor: ResolvedActor,
    args: { includeInactive?: boolean },
  ): Promise<ReadingProgrammeResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_PROGRAMME_BASE, 'WHERE school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (!args.includeInactive) sql.push('AND is_active = true ');
    sql.push('ORDER BY created_at DESC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgrammeRow[]>(sql.join(''), ...params);
    });
    const programmes = rows.map(rowToProgrammeDto);

    // For STUDENT callers, inline myProgress per programme.
    const callerStudentId = await this.resolveCallerStudentId(actor);
    if (!callerStudentId || programmes.length === 0) return programmes;

    const progressRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        'SELECT programme_id::text AS programme_id, student_id::text AS student_id, ' +
          'books_read, pages_read, is_complete, ' +
          'TO_CHAR(last_updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS last_updated_at ' +
          'FROM lib_programme_progress WHERE student_id = $1::uuid',
        callerStudentId,
      );
    });
    const progressByProgramme = new Map<string, ReadingProgrammeProgressDto>();
    for (const r of progressRows) {
      progressByProgramme.set(r.programme_id, rowToProgressDto(r));
    }
    return programmes.map((p) => ({ ...p, myProgress: progressByProgramme.get(p.id) ?? null }));
  }

  async getById(id: string, actor: ResolvedActor): Promise<ReadingProgrammeResponseDto> {
    const programme = await this.loadOrFail(id);
    const callerStudentId = await this.resolveCallerStudentId(actor);
    if (!callerStudentId) return programme;
    const progressRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        'SELECT programme_id::text AS programme_id, student_id::text AS student_id, ' +
          'books_read, pages_read, is_complete, ' +
          'TO_CHAR(last_updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS last_updated_at ' +
          'FROM lib_programme_progress WHERE programme_id = $1::uuid AND student_id = $2::uuid',
        id,
        callerStudentId,
      );
    });
    return {
      ...programme,
      myProgress: progressRows.length > 0 ? rowToProgressDto(progressRows[0]!) : null,
    };
  }

  async getLeaderboard(id: string, limit = 25): Promise<ReadingProgrammeLeaderboardEntryDto[]> {
    await this.loadOrFail(id);
    const cap = Math.min(Math.max(limit, 1), 200);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<LeaderboardRow[]>(
        'SELECT pg.student_id::text AS student_id, ' +
          'p.first_name AS student_first, p.last_name AS student_last, ' +
          'pg.books_read, pg.pages_read, pg.is_complete ' +
          'FROM lib_programme_progress pg ' +
          'JOIN sis_students s ON s.id = pg.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person p ON p.id = ps.person_id ' +
          'WHERE pg.programme_id = $1::uuid ' +
          'ORDER BY pg.books_read DESC, pg.pages_read DESC, pg.last_updated_at ASC NULLS LAST ' +
          'LIMIT ' +
          cap,
        id,
      );
    });
    return rows.map((r) => ({
      studentId: r.student_id,
      studentName:
        r.student_first && r.student_last ? r.student_first + ' ' + r.student_last : null,
      booksRead: r.books_read,
      pagesRead: r.pages_read,
      isComplete: r.is_complete,
    }));
  }

  async create(
    input: CreateReadingProgrammeDto,
    actor: ResolvedActor,
  ): Promise<ReadingProgrammeResponseDto> {
    if (!(await this.hasWriterScope(actor))) {
      throw new ForbiddenException(
        'Only librarians, teachers, or admins can create reading programmes',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO lib_reading_programmes (id, school_id, name, description, academic_year_id, ' +
          'target_books, target_pages, start_date, end_date, target_audience_type, target_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8::date, $9::date, $10, $11::uuid)',
        id,
        tenant.schoolId,
        input.name,
        input.description ?? null,
        input.academicYearId ?? null,
        input.targetBooks ?? null,
        input.targetPages ?? null,
        input.startDate ?? null,
        input.endDate ?? null,
        input.targetAudienceType,
        input.targetId ?? null,
      );
    });
    return this.loadOrFail(id);
  }

  async patch(
    id: string,
    input: UpdateReadingProgrammeDto,
    actor: ResolvedActor,
  ): Promise<ReadingProgrammeResponseDto> {
    if (!(await this.hasWriterScope(actor))) {
      throw new ForbiddenException(
        'Only librarians, teachers, or admins can update reading programmes',
      );
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM lib_reading_programmes WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Reading programme ' + id);
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      const set = (col: string, val: unknown) => {
        updates.push(col + ' = $' + idx);
        params.push(val);
        idx++;
      };
      if (input.name !== undefined) set('name', input.name);
      if (input.description !== undefined) set('description', input.description);
      if (input.targetBooks !== undefined) set('target_books', input.targetBooks);
      if (input.targetPages !== undefined) set('target_pages', input.targetPages);
      if (input.startDate !== undefined) set('start_date', input.startDate);
      if (input.endDate !== undefined) set('end_date', input.endDate);
      if (input.isActive !== undefined) set('is_active', input.isActive);
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE lib_reading_programmes SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
    });
    return this.loadOrFail(id);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ReadingProgrammeResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgrammeRow[]>(
        SELECT_PROGRAMME_BASE + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Reading programme ' + id);
    return rowToProgrammeDto(rows[0]!);
  }
}
