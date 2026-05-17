import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { CreateReadingLogDto, ReadingLogResponseDto, UpdateReadingLogDto } from './dto/library.dto';

interface ReadingLogRow {
  id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  catalogue_item_id: string;
  item_title: string | null;
  item_author: string | null;
  started_date: string | null;
  completed_date: string | null;
  pages_read: number | null;
  rating: number | null;
  review_text: string | null;
  created_at: string;
  updated_at: string;
}

interface ProgrammeRow {
  id: string;
  target_audience_type: string;
  target_id: string | null;
  target_books: number | null;
  target_pages: number | null;
}

const SELECT_LOG_BASE =
  'SELECT l.id::text AS id, l.student_id::text AS student_id, ' +
  'p.first_name AS student_first, p.last_name AS student_last, ' +
  'l.catalogue_item_id::text AS catalogue_item_id, ' +
  'i.title AS item_title, i.author AS item_author, ' +
  "TO_CHAR(l.started_date, 'YYYY-MM-DD') AS started_date, " +
  "TO_CHAR(l.completed_date, 'YYYY-MM-DD') AS completed_date, " +
  'l.pages_read, l.rating, l.review_text, ' +
  'TO_CHAR(l.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(l.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_reading_logs l ' +
  'LEFT JOIN lib_catalogue_items i ON i.id = l.catalogue_item_id ' +
  'LEFT JOIN sis_students s ON s.id = l.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = ps.person_id ';

function rowToDto(r: ReadingLogRow): ReadingLogResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_first && r.student_last ? r.student_first + ' ' + r.student_last : null,
    catalogueItemId: r.catalogue_item_id,
    itemTitle: r.item_title,
    itemAuthor: r.item_author,
    startedDate: r.started_date,
    completedDate: r.completed_date,
    pagesRead: r.pages_read,
    rating: r.rating,
    reviewText: r.review_text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ReadingLogService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Resolve the calling student's sis_students.id. Returns null for
   * non-STUDENT actors. The Step 7 service-layer auth model is:
   * STUDENT writes own logs; STAFF/ADMIN can read any student's log
   * via the `studentId` query parameter for the librarian dashboard.
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

  /**
   * STUDENT-FACING list. The student sees their own log only;
   * staff / admin can read any student's log via the studentId
   * argument (used by the librarian student-detail view).
   */
  async list(actor: ResolvedActor, args: { studentId?: string }): Promise<ReadingLogResponseDto[]> {
    let targetStudentId: string | null = null;
    if (actor.personType === 'STUDENT') {
      targetStudentId = await this.resolveCallerStudentId(actor);
      if (!targetStudentId) return [];
    } else if (actor.isSchoolAdmin || actor.personType === 'STAFF') {
      targetStudentId = args.studentId ?? null;
      if (!targetStudentId) {
        throw new BadRequestException(
          'Staff readers must specify ?studentId=<uuid>; the reading log is per-student.',
        );
      }
    } else {
      throw new ForbiddenException('Only students, staff, and admins can read the reading log');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReadingLogRow[]>(
        SELECT_LOG_BASE +
          'WHERE l.student_id = $1::uuid ORDER BY l.completed_date DESC NULLS LAST, l.created_at DESC LIMIT 200',
        targetStudentId,
      );
    });
    return rows.map(rowToDto);
  }

  /**
   * STUDENT-INPUT KEYSTONE. The student logs a book. Inside one
   * tenant transaction:
   *   1) Validate the catalogue item exists in this tenant.
   *   2) INSERT the log row.
   *   3) IF completed_date is set AND pages_read is set, walk the
   *      active reading programmes and upsert lib_programme_progress
   *      (books_read += 1, pages_read += pagesRead, last_updated_at =
   *      now(), is_complete recalculated against programme targets).
   *
   * Programme audience matching:
   *   - SCHOOL_WIDE → every student is in scope.
   *   - CLASS → student must be ACTIVE in sis_enrollments.class_id =
   *     programme.target_id.
   *   - YEAR_GROUP → student.grade_level matches a label encoded in
   *     target_id (deferred — schema accepts but seed doesn't use).
   *   - CUSTOM → external resolver (deferred this cycle).
   */
  async log(input: CreateReadingLogDto, actor: ResolvedActor): Promise<ReadingLogResponseDto> {
    if (actor.personType !== 'STUDENT') {
      throw new ForbiddenException('Only students can log their own reading entries');
    }
    const studentId = await this.resolveCallerStudentId(actor);
    if (!studentId) {
      throw new ForbiddenException(
        'Calling actor has no sis_students row in this school — the reading log is student-only',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate the catalogue item exists in this tenant.
      const itemRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM lib_catalogue_items WHERE id = $1::uuid AND school_id = $2::uuid',
        input.catalogueItemId,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (itemRows.length === 0) {
        throw new NotFoundException('Catalogue item ' + input.catalogueItemId);
      }

      // Insert the log row.
      await tx.$executeRawUnsafe(
        'INSERT INTO lib_reading_logs (id, student_id, catalogue_item_id, started_date, completed_date, pages_read, rating, review_text) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6, $7, $8)',
        id,
        studentId,
        input.catalogueItemId,
        input.startedDate ?? null,
        input.completedDate ?? null,
        input.pagesRead ?? null,
        input.rating ?? null,
        input.reviewText ?? null,
      );

      // Programme-progress auto-upsert when the student completes a read.
      if (input.completedDate) {
        await this.upsertProgrammeProgress(tx, studentId, input.pagesRead ?? 0);
      }
    });

    return this.loadOrFail(id);
  }

  async patch(
    id: string,
    input: UpdateReadingLogDto,
    actor: ResolvedActor,
  ): Promise<ReadingLogResponseDto> {
    if (actor.personType !== 'STUDENT') {
      throw new ForbiddenException('Only students can update their own reading log entries');
    }
    const studentId = await this.resolveCallerStudentId(actor);
    if (!studentId) {
      throw new ForbiddenException('Calling actor has no sis_students row in this school');
    }
    let didJustComplete = false;
    let bumpedPages = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id, completed_date FROM lib_reading_logs WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; student_id: string; completed_date: Date | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Reading log ' + id);
      if (lockRows[0]!.student_id !== studentId) {
        throw new ForbiddenException('You can only edit your own reading log entries');
      }
      const previouslyCompleted = lockRows[0]!.completed_date !== null;

      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      const set = (col: string, val: unknown) => {
        updates.push(col + ' = $' + idx);
        params.push(val);
        idx++;
      };
      if (input.startedDate !== undefined) set('started_date', input.startedDate);
      if (input.completedDate !== undefined) set('completed_date', input.completedDate);
      if (input.pagesRead !== undefined) set('pages_read', input.pagesRead);
      if (input.rating !== undefined) set('rating', input.rating);
      if (input.reviewText !== undefined) set('review_text', input.reviewText);
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE lib_reading_logs SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );

      // If this PATCH transitions the log from in-progress to completed,
      // upsert the programme progress for this student.
      if (
        !previouslyCompleted &&
        input.completedDate !== undefined &&
        input.completedDate !== null
      ) {
        didJustComplete = true;
        bumpedPages = input.pagesRead ?? 0;
        await this.upsertProgrammeProgress(tx, studentId, bumpedPages);
      }
    });
    void didJustComplete;
    return this.loadOrFail(id);
  }

  async getById(id: string, actor: ResolvedActor): Promise<ReadingLogResponseDto> {
    const log = await this.loadOrFail(id);
    if (
      actor.personType === 'STUDENT' &&
      log.studentId !== (await this.resolveCallerStudentId(actor))
    ) {
      // Don't-leak-existence row scope for STUDENT non-owner.
      throw new NotFoundException('Reading log ' + id);
    }
    return log;
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ReadingLogResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReadingLogRow[]>(SELECT_LOG_BASE + 'WHERE l.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Reading log ' + id);
    return rowToDto(rows[0]!);
  }

  /**
   * Programme-progress auto-upsert. Walks every active reading
   * programme for the school + checks audience match for the
   * student. For each match: INSERT-or-UPDATE the lib_programme_progress
   * row with books_read += 1 + pages_read += bumpedPages, and re-
   * compute is_complete against the programme targets.
   *
   * Audience-matching SQL is one round-trip — lib_reading_programmes
   * filtered to is_active=true, joined to sis_enrollments for CLASS,
   * with the SCHOOL_WIDE branch as a UNION ALL. Accepts (classId
   * IN enrolled set) for CLASS membership; YEAR_GROUP + CUSTOM
   * branches are left for a future iteration.
   */
  private async upsertProgrammeProgress(
    tx: {
      $queryRawUnsafe: <T = unknown>(sql: string, ...args: unknown[]) => Promise<T>;
      $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
    },
    studentId: string,
    bumpedPages: number,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const matchedProgrammes = (await tx.$queryRawUnsafe(
      // SCHOOL_WIDE branch — every student in this school is in scope.
      'SELECT id::text AS id, target_audience_type, target_id::text AS target_id, ' +
        'target_books, target_pages ' +
        'FROM lib_reading_programmes ' +
        "WHERE school_id = $1::uuid AND is_active = true AND target_audience_type = 'SCHOOL_WIDE' " +
        'UNION ALL ' +
        // CLASS branch — student must be ACTIVE in the target class.
        'SELECT p.id::text AS id, p.target_audience_type, p.target_id::text AS target_id, ' +
        'p.target_books, p.target_pages ' +
        'FROM lib_reading_programmes p ' +
        'WHERE p.school_id = $1::uuid AND p.is_active = true ' +
        "AND p.target_audience_type = 'CLASS' " +
        'AND EXISTS (SELECT 1 FROM sis_enrollments e ' +
        "WHERE e.student_id = $2::uuid AND e.class_id = p.target_id AND e.status = 'ACTIVE')",
      tenant.schoolId,
      studentId,
    )) as ProgrammeRow[];

    for (const prog of matchedProgrammes) {
      // Upsert via INSERT … ON CONFLICT
      const progressId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO lib_programme_progress (id, programme_id, student_id, books_read, pages_read, last_updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, now()) ' +
          'ON CONFLICT (programme_id, student_id) DO UPDATE SET ' +
          'books_read = lib_programme_progress.books_read + 1, ' +
          'pages_read = lib_programme_progress.pages_read + EXCLUDED.pages_read, ' +
          'last_updated_at = now(), updated_at = now()',
        progressId,
        prog.id,
        studentId,
        bumpedPages,
      );

      // Recalculate is_complete against the programme targets (book + page).
      // is_complete=true when EITHER (target_books set AND books_read >= target_books)
      // OR (target_pages set AND pages_read >= target_pages); both targets
      // can fire independently. If neither target is set, is_complete stays
      // false (programme has no completion criteria).
      await tx.$executeRawUnsafe(
        'UPDATE lib_programme_progress SET is_complete = (' +
          '(' +
          (prog.target_books === null ? 'false' : 'books_read >= ' + Number(prog.target_books)) +
          ') OR (' +
          (prog.target_pages === null ? 'false' : 'pages_read >= ' + Number(prog.target_pages)) +
          ')) WHERE programme_id = $1::uuid AND student_id = $2::uuid',
        prog.id,
        studentId,
      );
    }
  }
}
