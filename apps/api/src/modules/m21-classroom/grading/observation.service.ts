import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateObservationDto,
  ObservationResponseDto,
  type ObservationType,
  UpdateObservationDto,
} from './dto/observation.dto';

interface ObservationRow {
  id: string;
  class_id: string;
  class_name: string | null;
  student_id: string;
  student_name: string | null;
  teacher_id: string;
  teacher_name: string | null;
  note_text: string;
  note_type: ObservationType;
  is_shared_with_parent: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(row: ObservationRow): ObservationResponseDto {
  return {
    id: row.id,
    classId: row.class_id,
    className: row.class_name,
    studentId: row.student_id,
    studentName: row.student_name,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    noteText: row.note_text,
    noteType: row.note_type,
    isSharedWithParent: row.is_shared_with_parent,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_BASE =
  'SELECT o.id, o.class_id, ' +
  "(co.name || ' (' || c.section_code || ')') AS class_name, " +
  'o.student_id, ' +
  "(ip_s.first_name || ' ' || ip_s.last_name) AS student_name, " +
  'o.teacher_id, ' +
  "(ip_t.first_name || ' ' || ip_t.last_name) AS teacher_name, " +
  'o.note_text, o.note_type, o.is_shared_with_parent, o.created_at, o.updated_at ' +
  'FROM cls_student_observations o ' +
  'LEFT JOIN sis_classes c ON c.id = o.class_id ' +
  'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
  'LEFT JOIN sis_students s ON s.id = o.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_s ON ip_s.id = ps.person_id ' +
  'LEFT JOIN hr_employees he ON he.id = o.teacher_id ' +
  'LEFT JOIN platform.iam_person ip_t ON ip_t.id = he.person_id ';

@Injectable()
export class ObservationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireEmployee(actor: ResolvedActor): string {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can author observations. The calling user has no hr_employees record.',
      );
    }
    return actor.employeeId;
  }

  /** Verify the actor teaches the class. Admins bypass. */
  private async assertCanWriteClass(classId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) {
      const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
      });
      if (exists.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can author observations. The calling user has no hr_employees record.',
      );
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ' +
          'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.employeeId,
      );
    });
    if (rows.length === 0) {
      throw new ForbiddenException(
        'You are not assigned to class ' + classId + ' and cannot author observations for it.',
      );
    }
  }

  /** Resolve sis_students.id for a STUDENT actor. */
  private async resolveStudentSelfId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid',
        actor.personId,
      );
    });
    return rows[0]?.id ?? null;
  }

  /**
   * GET /classroom/students/:studentId/observations — visibility:
   * - admin / staff: all observations for the student.
   * - guardian linked to the student via sis_student_guardians: only
   *   is_shared_with_parent=true rows.
   * - student: 404 (observations are staff-side notes about them).
   */
  async listForStudent(studentId: string, actor: ResolvedActor): Promise<ObservationResponseDto[]> {
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<ObservationRow[]>(
          SELECT_BASE + ' WHERE o.student_id = $1::uuid ORDER BY o.created_at DESC',
          studentId,
        );
      });
      return rows.map(rowToDto);
    }
    if (actor.personType === 'GUARDIAN') {
      // Guardian must be linked to this student via sis_student_guardians
      const linked = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
          studentId,
          actor.personId,
        );
      });
      if (linked.length === 0) return [];
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<ObservationRow[]>(
          SELECT_BASE +
            ' WHERE o.student_id = $1::uuid AND o.is_shared_with_parent = true ORDER BY o.created_at DESC',
          studentId,
        );
      });
      return rows.map(rowToDto);
    }
    // Students do not see observations about themselves
    return [];
  }

  /** GET /classroom/observations/:id */
  async getById(id: string, actor: ResolvedActor): Promise<ObservationResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ObservationRow[]>(SELECT_BASE + ' WHERE o.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Observation ' + id + ' not found');
    const row = rows[0]!;

    // Reuse the row-scope filter from listForStudent for non-admin reads
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      if (actor.personType === 'GUARDIAN') {
        if (!row.is_shared_with_parent) {
          throw new NotFoundException('Observation ' + id + ' not found');
        }
        const linked = await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_student_guardians sg ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
            row.student_id,
            actor.personId,
          );
        });
        if (linked.length === 0) {
          throw new NotFoundException('Observation ' + id + ' not found');
        }
      } else {
        // Students never see their own observations
        const studentId = await this.resolveStudentSelfId(actor);
        if (studentId !== null && row.student_id === studentId) {
          throw new NotFoundException('Observation ' + id + ' not found');
        }
        throw new NotFoundException('Observation ' + id + ' not found');
      }
    }
    return rowToDto(row);
  }

  /** POST /classroom/observations — teacher logs an observation. */
  async create(input: CreateObservationDto, actor: ResolvedActor): Promise<ObservationResponseDto> {
    const employeeId = this.requireEmployee(actor);
    await this.assertCanWriteClass(input.classId, actor);

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_student_observations ' +
          '(id, class_id, student_id, teacher_id, note_text, note_type, is_shared_with_parent) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)',
        id,
        input.classId,
        input.studentId,
        employeeId,
        input.noteText,
        input.noteType,
        input.isSharedWithParent ?? false,
      );
    });
    return this.getById(id, actor);
  }

  /** PATCH /classroom/observations/:id — author or admin only. */
  async update(
    id: string,
    input: UpdateObservationDto,
    actor: ResolvedActor,
  ): Promise<ObservationResponseDto> {
    this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ teacher_id: string }>>(
        'SELECT teacher_id::text AS teacher_id FROM cls_student_observations WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Observation ' + id + ' not found');
      if (!actor.isSchoolAdmin && rows[0]!.teacher_id !== actor.employeeId) {
        throw new ForbiddenException(
          'Only the authoring teacher or an admin can update an observation.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.noteText !== undefined) {
        sets.push('note_text = $' + i++);
        params.push(input.noteText);
      }
      if (input.noteType !== undefined) {
        sets.push('note_type = $' + i++);
        params.push(input.noteType);
      }
      if (input.isSharedWithParent !== undefined) {
        sets.push('is_shared_with_parent = $' + i++);
        params.push(input.isSharedWithParent);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE cls_student_observations SET ' + sets.join(', ') + ' WHERE id = $' + i + '::uuid',
        ...params,
      );
    });
    return this.getById(id, actor);
  }

  /** DELETE /classroom/observations/:id — author or admin only. */
  async delete(id: string, actor: ResolvedActor): Promise<void> {
    this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ teacher_id: string }>>(
        'SELECT teacher_id::text AS teacher_id FROM cls_student_observations WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Observation ' + id + ' not found');
      if (!actor.isSchoolAdmin && rows[0]!.teacher_id !== actor.employeeId) {
        throw new ForbiddenException(
          'Only the authoring teacher or an admin can delete an observation.',
        );
      }
      await tx.$executeRawUnsafe('DELETE FROM cls_student_observations WHERE id = $1::uuid', id);
    });
  }
}
