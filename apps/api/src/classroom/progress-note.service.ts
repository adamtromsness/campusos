import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { AssignmentService } from './assignment.service';
import { ProgressNoteResponseDto, UpsertProgressNoteDto } from './dto/progress-note.dto';

interface ProgressNoteRow {
  id: string;
  class_id: string;
  student_id: string;
  term_id: string;
  author_id: string;
  note_text: string;
  overall_effort_rating: string | null;
  is_parent_visible: boolean;
  is_student_visible: boolean;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(r: ProgressNoteRow): ProgressNoteResponseDto {
  return {
    id: r.id,
    classId: r.class_id,
    studentId: r.student_id,
    termId: r.term_id,
    authorId: r.author_id,
    noteText: r.note_text,
    overallEffortRating: r.overall_effort_rating,
    isParentVisible: r.is_parent_visible,
    isStudentVisible: r.is_student_visible,
    publishedAt: toIso(r.published_at),
    createdAt: toIso(r.created_at) || '',
    updatedAt: toIso(r.updated_at) || '',
  };
}

@Injectable()
export class ProgressNoteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly assignments: AssignmentService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Teacher writes a per-(class, student, term) progress note. Unique on the
   * triple, so re-posting overwrites the existing row (single source of
   * truth — there's no conversation history). Always published on write.
   *
   * Validates that the student is enrolled in the class (404 otherwise) and
   * the term exists (404 otherwise).
   *
   * Emits cls.progress_note.published so future notification consumers can
   * fan out to parent / student.
   */
  async upsert(
    classId: string,
    body: UpsertProgressNoteDto,
    actor: ResolvedActor,
  ): Promise<ProgressNoteResponseDto> {
    await this.assignments.assertCanWriteClass(classId, actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees can author progress notes. The calling user has no hr_employees record.',
      );
    }

    var enrollRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_enrollments ' +
          "WHERE class_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE'",
        classId,
        body.studentId,
      );
    });
    if (enrollRows.length === 0) {
      throw new NotFoundException(
        'Student ' + body.studentId + ' is not enrolled in class ' + classId,
      );
    }
    var termRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_terms WHERE id = $1::uuid',
        body.termId,
      );
    });
    if (termRows.length === 0) {
      throw new NotFoundException('Term ' + body.termId + ' not found');
    }

    var isParentVisible = body.isParentVisible !== false;
    var isStudentVisible = body.isStudentVisible !== false;

    var noteId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM cls_student_progress_notes ' +
          'WHERE class_id = $1::uuid AND student_id = $2::uuid AND term_id = $3::uuid',
        classId,
        body.studentId,
        body.termId,
      );
      if (existing.length > 0) {
        var id = existing[0]!.id;
        await tx.$executeRawUnsafe(
          'UPDATE cls_student_progress_notes SET ' +
            'author_id = $1::uuid, ' +
            'note_text = $2, ' +
            'overall_effort_rating = $3, ' +
            'is_parent_visible = $4, ' +
            'is_student_visible = $5, ' +
            'published_at = now(), ' +
            'updated_at = now() ' +
            'WHERE id = $6::uuid',
          actor.employeeId,
          body.noteText,
          body.overallEffortRating ?? null,
          isParentVisible,
          isStudentVisible,
          id,
        );
        return id;
      }
      var newId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_student_progress_notes ' +
          '(id, class_id, student_id, term_id, author_id, note_text, overall_effort_rating, ' +
          'is_parent_visible, is_student_visible, published_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, now())',
        newId,
        classId,
        body.studentId,
        body.termId,
        actor.employeeId,
        body.noteText,
        body.overallEffortRating ?? null,
        isParentVisible,
        isStudentVisible,
      );
      return newId;
    });

    var publishedAt = new Date().toISOString();
    void this.kafka.emit({
      topic: 'cls.progress_note.published',
      key: body.studentId,
      sourceModule: 'classroom',
      occurredAt: publishedAt,
      payload: {
        noteId: noteId,
        classId: classId,
        studentId: body.studentId,
        termId: body.termId,
        isParentVisible: isParentVisible,
        isStudentVisible: isStudentVisible,
        authorId: actor.employeeId,
        publishedAt: publishedAt,
      },
    });

    return this.getById(noteId);
  }

  /**
   * List the progress notes for a student.
   *
   * Visibility:
   *  - Admin → all rows (regardless of is_*_visible).
   *  - Teacher → rows where the teacher teaches the (class) tied to the note.
   *  - Student (self) → published rows where is_student_visible.
   *  - Guardian (linked) → published rows where is_parent_visible.
   *
   * Throws 404 if the actor can't see the student at all.
   */
  async listForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<ProgressNoteResponseDto[]> {
    await this.assertCanViewStudent(studentId, actor);

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql =
        'SELECT id, class_id, student_id, term_id, author_id, note_text, overall_effort_rating, ' +
        'is_parent_visible, is_student_visible, published_at, created_at, updated_at ' +
        'FROM cls_student_progress_notes WHERE student_id = $1::uuid ';
      var params: any[] = [studentId];

      if (actor.isSchoolAdmin) {
        sql += 'ORDER BY published_at DESC NULLS LAST, created_at DESC';
        return client.$queryRawUnsafe<ProgressNoteRow[]>(sql, ...params);
      }
      switch (actor.personType) {
        case 'STAFF':
          if (!actor.employeeId) return [];
          sql +=
            'AND class_id IN (' +
            'SELECT class_id FROM sis_class_teachers WHERE teacher_employee_id = $2::uuid' +
            ') ' +
            'ORDER BY published_at DESC NULLS LAST, created_at DESC';
          params.push(actor.employeeId);
          return client.$queryRawUnsafe<ProgressNoteRow[]>(sql, ...params);
        case 'STUDENT':
          sql +=
            'AND is_student_visible = true AND published_at IS NOT NULL ' +
            'ORDER BY published_at DESC';
          return client.$queryRawUnsafe<ProgressNoteRow[]>(sql, ...params);
        case 'GUARDIAN':
          sql +=
            'AND is_parent_visible = true AND published_at IS NOT NULL ' +
            'ORDER BY published_at DESC';
          return client.$queryRawUnsafe<ProgressNoteRow[]>(sql, ...params);
        default:
          return [];
      }
    });
    return rows.map(rowToDto);
  }

  private async getById(id: string): Promise<ProgressNoteResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressNoteRow[]>(
        'SELECT id, class_id, student_id, term_id, author_id, note_text, overall_effort_rating, ' +
          'is_parent_visible, is_student_visible, published_at, created_at, updated_at ' +
          'FROM cls_student_progress_notes WHERE id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Progress note ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  private async assertCanViewStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    var existsRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid',
        studentId,
      );
    });
    if (existsRows.length === 0) {
      throw new NotFoundException('Student ' + studentId + ' not found');
    }
    if (actor.isSchoolAdmin) return;
    var visible = await this.tenantPrisma.executeInTenantContext(async (client) => {
      switch (actor.personType) {
        case 'STUDENT': {
          var rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_students s ' +
              'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
              'WHERE s.id = $1::uuid AND ps.person_id = $2::uuid',
            studentId,
            actor.personId,
          );
          return rows.length > 0;
        }
        case 'GUARDIAN': {
          var rows2 = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_student_guardians sg ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
            studentId,
            actor.personId,
          );
          return rows2.length > 0;
        }
        case 'STAFF': {
          if (!actor.employeeId) return false;
          var rows3 = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_enrollments e ' +
              'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
              "WHERE e.student_id = $1::uuid AND e.status = 'ACTIVE' " +
              'AND ct.teacher_employee_id = $2::uuid',
            studentId,
            actor.employeeId,
          );
          return rows3.length > 0;
        }
        default:
          return false;
      }
    });
    if (!visible) {
      throw new NotFoundException('Student ' + studentId + ' not found');
    }
  }
}
