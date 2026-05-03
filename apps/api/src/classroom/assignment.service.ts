import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AssignmentResponseDto,
  CreateAssignmentDto,
  ListAssignmentsQueryDto,
  UpdateAssignmentDto,
} from './dto/assignment.dto';

interface AssignmentRow {
  id: string;
  class_id: string;
  title: string;
  instructions: string | null;
  due_date: Date | string | null;
  max_points: string;
  is_ai_grading_enabled: boolean;
  is_extra_credit: boolean;
  is_published: boolean;
  grading_scale_id: string | null;
  type_id: string;
  type_name: string;
  type_category: string;
  category_id: string | null;
  category_name: string | null;
  category_weight: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(row: AssignmentRow): AssignmentResponseDto {
  return {
    id: row.id,
    classId: row.class_id,
    title: row.title,
    instructions: row.instructions,
    assignmentType: {
      id: row.type_id,
      name: row.type_name,
      category: row.type_category,
    },
    category:
      row.category_id !== null
        ? {
            id: row.category_id,
            name: row.category_name!,
            weight: Number(row.category_weight),
          }
        : null,
    gradingScaleId: row.grading_scale_id,
    dueDate: toIso(row.due_date),
    maxPoints: Number(row.max_points),
    isAiGradingEnabled: row.is_ai_grading_enabled,
    isExtraCredit: row.is_extra_credit,
    isPublished: row.is_published,
    createdAt: toIso(row.created_at) || '',
    updatedAt: toIso(row.updated_at) || '',
  };
}

var SELECT_ASSIGNMENT_BASE =
  'SELECT a.id, a.class_id, a.title, a.instructions, a.due_date, a.max_points, ' +
  'a.is_ai_grading_enabled, a.is_extra_credit, a.is_published, a.grading_scale_id, ' +
  'a.created_at, a.updated_at, ' +
  't.id AS type_id, t.name AS type_name, t.category AS type_category, ' +
  'c.id AS category_id, c.name AS category_name, c.weight AS category_weight ' +
  'FROM cls_assignments a ' +
  'JOIN cls_assignment_types t ON t.id = a.assignment_type_id ' +
  'LEFT JOIN cls_assignment_categories c ON c.id = a.category_id ';

@Injectable()
export class AssignmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Emit cls.assignment.posted whenever an assignment row lands with
   * is_published=true (either on create or on a publish-toggling update).
   * Cycle 7 Step 4's TaskWorker subscribes to this topic to auto-create
   * a TODO task on every enrolled student's to-do list.
   */
  private emitPosted(assignment: AssignmentResponseDto, classRow: { sectionCode: string; courseName: string | null }): void {
    if (!assignment.isPublished) return;
    var tenant = getCurrentTenant();
    void this.kafka.emit({
      topic: 'cls.assignment.posted',
      key: assignment.id,
      sourceModule: 'classroom',
      payload: {
        assignmentId: assignment.id,
        classId: assignment.classId,
        title: assignment.title,
        assignment_title: assignment.title,
        section_code: classRow.sectionCode,
        class_name: classRow.courseName ? classRow.courseName + ' (' + classRow.sectionCode + ')' : classRow.sectionCode,
        dueDate: assignment.dueDate,
        due_date: assignment.dueDate,
        maxPoints: assignment.maxPoints,
        isPublished: true,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
  }

  private async loadClassDescriptor(classId: string): Promise<{ sectionCode: string; courseName: string | null }> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ section_code: string; course_name: string | null }>>(
        'SELECT c.section_code, co.name AS course_name FROM sis_classes c ' +
          'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
          'WHERE c.id = $1::uuid',
        classId,
      );
    });
    if (rows.length === 0) return { sectionCode: '', courseName: null };
    return { sectionCode: rows[0]!.section_code, courseName: rows[0]!.course_name };
  }

  /**
   * Verify the caller can READ the given class. Used by all GET endpoints
   * that take a class_id from the URL — admins bypass; teachers must appear
   * in sis_class_teachers; students must have an active enrollment; parents
   * must have at least one linked child with an active enrollment in the class.
   *
   * Throws NotFound (deliberately not Forbidden) so the API can't be used to
   * probe for class ids the caller has no access to.
   */
  async assertCanReadClass(classId: string, actor: ResolvedActor): Promise<void> {
    var visible = await this.canReadClass(classId, actor);
    if (!visible) throw new NotFoundException('Class ' + classId + ' not found');
  }

  /**
   * Verify the caller can WRITE to the given class. Admins bypass; otherwise
   * the caller's iam_person.id must appear in sis_class_teachers for this
   * class. Mirrors AttendanceService.assertCanWriteClassAttendance.
   *
   * 403 over 404: the caller already passed `tch-002:write` on the tenant
   * via PermissionGuard — what's missing is the per-class assignment.
   */
  async assertCanWriteClass(classId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) {
      // Existence check still required so admins can't write to a phantom class id.
      var exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
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
        'You are not assigned to class ' + classId + ' and cannot manage its assignments',
      );
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ' +
          'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.employeeId,
      );
    });
    if (rows.length === 0) {
      throw new ForbiddenException(
        'You are not assigned to class ' + classId + ' and cannot manage its assignments',
      );
    }
  }

  private async canReadClass(classId: string, actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) {
      var exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
      });
      return exists.length > 0;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      switch (actor.personType) {
        case 'STAFF': {
          if (!actor.employeeId) return false;
          var rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_class_teachers ' +
              'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
            classId,
            actor.employeeId,
          );
          return rows.length > 0;
        }
        case 'STUDENT': {
          var rows2 = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_enrollments e ' +
              'JOIN sis_students s ON s.id = e.student_id ' +
              'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
              "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' AND ps.person_id = $2::uuid",
            classId,
            actor.personId,
          );
          return rows2.length > 0;
        }
        case 'GUARDIAN': {
          var rows3 = await client.$queryRawUnsafe<Array<{ ok: number }>>(
            'SELECT 1 AS ok FROM sis_enrollments e ' +
              'JOIN sis_student_guardians sg ON sg.student_id = e.student_id ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' AND g.person_id = $2::uuid",
            classId,
            actor.personId,
          );
          return rows3.length > 0;
        }
        default:
          return false;
      }
    });
  }

  /**
   * Whether the caller is a "manager" of the class — teacher-of-class or
   * admin. Managers see drafts and soft-deleted-but-recently-modified state;
   * students and parents only see published, non-deleted rows.
   */
  private async isClassManager(classId: string, actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    if (!actor.employeeId) return false;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ' +
          'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.employeeId,
      );
    });
    return rows.length > 0;
  }

  /**
   * List the school-scoped assignment types (Homework, Quiz, Test, …). Used
   * by the create-assignment UI to populate the type dropdown. Tenant
   * search_path scopes rows to the current school; no per-class auth needed
   * because types are non-sensitive school-wide config and every persona
   * holding `tch-002:read` already sees the assignments that reference them.
   */
  async listAssignmentTypes(): Promise<
    Array<{ id: string; name: string; category: string; weightInCategory: number }>
  > {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{ id: string; name: string; category: string; weight_in_category: string }>
      >(
        'SELECT id, name, category, weight_in_category::text AS weight_in_category ' +
          'FROM cls_assignment_types WHERE is_active = true ORDER BY name',
      );
    });
    return rows.map(function (r) {
      return {
        id: r.id,
        name: r.name,
        category: r.category,
        weightInCategory: Number(r.weight_in_category),
      };
    });
  }

  async list(
    classId: string,
    filters: ListAssignmentsQueryDto,
    actor: ResolvedActor,
  ): Promise<AssignmentResponseDto[]> {
    await this.assertCanReadClass(classId, actor);
    var manager = await this.isClassManager(classId, actor);
    var includeUnpublished = manager && filters.includeUnpublished === true;

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql =
        SELECT_ASSIGNMENT_BASE +
        'WHERE a.class_id = $1::uuid AND a.deleted_at IS NULL ' +
        (includeUnpublished ? '' : 'AND a.is_published = true ') +
        'ORDER BY a.due_date NULLS LAST, a.created_at DESC';
      return client.$queryRawUnsafe<AssignmentRow[]>(sql, classId);
    });
    return rows.map(rowToDto);
  }

  async getById(assignmentId: string, actor: ResolvedActor): Promise<AssignmentResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AssignmentRow[]>(
        SELECT_ASSIGNMENT_BASE + 'WHERE a.id = $1::uuid AND a.deleted_at IS NULL',
        assignmentId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    var row = rows[0]!;

    var manager = await this.isClassManager(row.class_id, actor);
    if (!manager) {
      // Students / parents → must be a class member AND the assignment must be published.
      var visible = await this.canReadClass(row.class_id, actor);
      if (!visible || !row.is_published) {
        throw new NotFoundException('Assignment ' + assignmentId + ' not found');
      }
    }
    return rowToDto(row);
  }

  async create(
    classId: string,
    input: CreateAssignmentDto,
    actor: ResolvedActor,
  ): Promise<AssignmentResponseDto> {
    await this.assertCanWriteClass(classId, actor);

    var assignmentId = generateId();
    var maxPoints = input.maxPoints !== undefined ? input.maxPoints : 100;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate assignment_type_id belongs to this school (avoid cross-school FK confusion).
      var typeRows = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM cls_assignment_types t ' +
          'JOIN sis_classes c ON c.school_id = t.school_id ' +
          'WHERE t.id = $1::uuid AND c.id = $2::uuid',
        input.assignmentTypeId,
        classId,
      );
      if (typeRows.length === 0) {
        throw new BadRequestException(
          'assignmentTypeId ' + input.assignmentTypeId + ' is not configured for this school',
        );
      }
      // Validate category_id belongs to the class.
      if (input.categoryId !== undefined) {
        var catRows = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM cls_assignment_categories WHERE id = $1::uuid AND class_id = $2::uuid',
          input.categoryId,
          classId,
        );
        if (catRows.length === 0) {
          throw new BadRequestException(
            'categoryId ' + input.categoryId + ' does not belong to class ' + classId,
          );
        }
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_assignments ' +
          '(id, class_id, assignment_type_id, category_id, grading_scale_id, title, instructions, ' +
          'due_date, max_points, is_ai_grading_enabled, is_extra_credit, is_published) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, ' +
          '$8::timestamptz, $9::numeric, $10, $11, $12)',
        assignmentId,
        classId,
        input.assignmentTypeId,
        input.categoryId ?? null,
        input.gradingScaleId ?? null,
        input.title,
        input.instructions ?? null,
        input.dueDate ?? null,
        maxPoints.toFixed(2),
        input.isAiGradingEnabled ?? false,
        input.isExtraCredit ?? false,
        input.isPublished ?? false,
      );
    });

    var dto = await this.getById(assignmentId, actor);
    if (dto.isPublished) {
      var classDescriptor = await this.loadClassDescriptor(classId);
      this.emitPosted(dto, classDescriptor);
    }
    return dto;
  }

  async update(
    assignmentId: string,
    input: UpdateAssignmentDto,
    actor: ResolvedActor,
  ): Promise<AssignmentResponseDto> {
    var classId = await this.getOwningClassId(assignmentId);
    await this.assertCanWriteClass(classId, actor);

    var sets: string[] = [];
    var params: any[] = [];
    var i = 1;

    if (input.title !== undefined) {
      sets.push('title = $' + i++);
      params.push(input.title);
    }
    if (input.instructions !== undefined) {
      sets.push('instructions = $' + i++);
      params.push(input.instructions);
    }
    if (input.assignmentTypeId !== undefined) {
      sets.push('assignment_type_id = $' + i++ + '::uuid');
      params.push(input.assignmentTypeId);
    }
    if (input.categoryId !== undefined) {
      sets.push('category_id = $' + i++ + '::uuid');
      params.push(input.categoryId);
    }
    if (input.gradingScaleId !== undefined) {
      sets.push('grading_scale_id = $' + i++ + '::uuid');
      params.push(input.gradingScaleId);
    }
    if (input.dueDate !== undefined) {
      sets.push('due_date = $' + i++ + '::timestamptz');
      params.push(input.dueDate);
    }
    if (input.maxPoints !== undefined) {
      sets.push('max_points = $' + i++ + '::numeric');
      params.push(input.maxPoints.toFixed(2));
    }
    if (input.isAiGradingEnabled !== undefined) {
      sets.push('is_ai_grading_enabled = $' + i++);
      params.push(input.isAiGradingEnabled);
    }
    if (input.isExtraCredit !== undefined) {
      sets.push('is_extra_credit = $' + i++);
      params.push(input.isExtraCredit);
    }
    if (input.isPublished !== undefined) {
      sets.push('is_published = $' + i++);
      params.push(input.isPublished);
    }

    if (sets.length === 0) {
      throw new BadRequestException('No fields to update');
    }
    sets.push('updated_at = now()');
    params.push(assignmentId);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate categoryId belongs to the assignment's class.
      if (input.categoryId !== undefined) {
        var catRows = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM cls_assignment_categories WHERE id = $1::uuid AND class_id = $2::uuid',
          input.categoryId,
          classId,
        );
        if (catRows.length === 0) {
          throw new BadRequestException(
            'categoryId ' + input.categoryId + ' does not belong to class ' + classId,
          );
        }
      }
      await tx.$executeRawUnsafe(
        'UPDATE cls_assignments SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          i +
          '::uuid AND deleted_at IS NULL',
        ...params,
      );
    });

    var dto = await this.getById(assignmentId, actor);
    // Emit on every PATCH that lands isPublished=true. The TaskWorker
    // dedups per-(owner, source_ref_id) via Redis SET NX, so re-emitting
    // for already-existing tasks is a harmless no-op.
    if (dto.isPublished) {
      var classDescriptor = await this.loadClassDescriptor(dto.classId);
      this.emitPosted(dto, classDescriptor);
    }
    return dto;
  }

  /**
   * Soft delete: sets `deleted_at = now()`. The row stays in the table so
   * existing grades and submissions retain their FK target. List endpoints
   * filter out deleted rows; getById returns 404 for them.
   */
  async softDelete(assignmentId: string, actor: ResolvedActor): Promise<void> {
    var classId = await this.getOwningClassId(assignmentId);
    await this.assertCanWriteClass(classId, actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE cls_assignments SET deleted_at = now(), updated_at = now() ' +
          'WHERE id = $1::uuid AND deleted_at IS NULL',
        assignmentId,
      );
    });
  }

  /**
   * Resolve the class_id for an assignment. Throws 404 if missing or
   * already soft-deleted — write paths can't "wake up" a deleted row.
   */
  private async getOwningClassId(assignmentId: string): Promise<string> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ class_id: string }>>(
        'SELECT class_id FROM cls_assignments WHERE id = $1::uuid AND deleted_at IS NULL',
        assignmentId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    return rows[0]!.class_id;
  }
}
