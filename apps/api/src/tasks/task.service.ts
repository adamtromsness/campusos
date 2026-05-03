import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateTaskDto,
  ListTasksQueryDto,
  TASK_CATEGORIES,
  TaskCategory,
  TaskPriority,
  TaskResponseDto,
  TaskSource,
  TaskStatus,
  UpdateTaskDto,
} from './dto/task.dto';

interface TaskRow {
  id: string;
  school_id: string;
  owner_id: string;
  owner_first_name: string | null;
  owner_last_name: string | null;
  title: string;
  description: string | null;
  source: string;
  source_ref_id: string | null;
  priority: string;
  status: string;
  due_at: string | null;
  task_category: string;
  acknowledgement_id: string | null;
  created_for_id: string | null;
  created_for_first_name: string | null;
  created_for_last_name: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(row: TaskRow): TaskResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    ownerId: row.owner_id,
    ownerName: fullName(row.owner_first_name, row.owner_last_name),
    title: row.title,
    description: row.description,
    source: row.source as TaskSource,
    sourceRefId: row.source_ref_id,
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    dueAt: row.due_at,
    taskCategory: row.task_category as TaskCategory,
    acknowledgementId: row.acknowledgement_id,
    createdForId: row.created_for_id,
    createdForName: fullName(row.created_for_first_name, row.created_for_last_name),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_TASK_BASE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, t.owner_id::text AS owner_id, ' +
  'op.first_name AS owner_first_name, op.last_name AS owner_last_name, ' +
  't.title, t.description, t.source, t.source_ref_id::text AS source_ref_id, ' +
  't.priority, t.status, ' +
  'TO_CHAR(t.due_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS due_at, ' +
  't.task_category, t.acknowledgement_id::text AS acknowledgement_id, ' +
  't.created_for_id::text AS created_for_id, ' +
  'cf.first_name AS created_for_first_name, cf.last_name AS created_for_last_name, ' +
  'TO_CHAR(t.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'TO_CHAR(t.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(t.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM tsk_tasks t ' +
  'LEFT JOIN platform.platform_users opu ON opu.id = t.owner_id ' +
  'LEFT JOIN platform.iam_person op ON op.id = opu.person_id ' +
  'LEFT JOIN platform.platform_users cfu ON cfu.id = t.created_for_id ' +
  'LEFT JOIN platform.iam_person cf ON cf.id = cfu.person_id ';

@Injectable()
export class TaskService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * List tasks the caller can see. Default scope is the caller's own
   * to-do list — owner_id = actor OR created_for_id = actor (so a task
   * delegated to me lands here). Admins see every task in the tenant.
   * The DONE / CANCELLED rows are excluded by default for the to-do
   * surface; pass includeCompleted=true to get the completed history.
   */
  async list(query: ListTasksQueryDto, actor: ResolvedActor): Promise<TaskResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 200);
    const sql: string[] = [SELECT_TASK_BASE, 'WHERE 1=1 '];
    const params: any[] = [];
    let idx = 1;

    if (!actor.isSchoolAdmin) {
      sql.push('AND (t.owner_id = $' + idx + '::uuid OR t.created_for_id = $' + idx + '::uuid) ');
      params.push(actor.accountId);
      idx++;
    }
    if (query.status) {
      sql.push('AND t.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    } else if (!query.includeCompleted) {
      sql.push("AND t.status IN ('TODO', 'IN_PROGRESS') ");
    }
    if (query.taskCategory) {
      sql.push('AND t.task_category = $' + idx + ' ');
      params.push(query.taskCategory);
      idx++;
    }
    if (query.priority) {
      sql.push('AND t.priority = $' + idx + ' ');
      params.push(query.priority);
      idx++;
    }
    if (query.dueAfter) {
      sql.push('AND t.due_at >= $' + idx + '::timestamptz ');
      params.push(query.dueAfter);
      idx++;
    }
    if (query.dueBefore) {
      sql.push('AND t.due_at <= $' + idx + '::timestamptz ');
      params.push(query.dueBefore);
      idx++;
    }
    sql.push(
      // Overdue rows first (due_at NULLS LAST so undated tasks land at the
      // bottom), then by priority urgency, then created_at as tiebreak.
      'ORDER BY t.due_at NULLS LAST, ' +
        "CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, " +
        't.created_at DESC ',
    );
    sql.push('LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TaskRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  /**
   * Tasks delegated TO me by another user — created_for_id = actor AND
   * owner_id != actor. The "inbox" view of work others have asked me to
   * do.
   */
  async listAssigned(actor: ResolvedActor): Promise<TaskResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TaskRow[]>(
        SELECT_TASK_BASE +
          'WHERE t.created_for_id = $1::uuid AND t.owner_id <> $1::uuid ' +
          'ORDER BY t.due_at NULLS LAST, t.created_at DESC LIMIT 200',
        actor.accountId,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<TaskResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TaskRow[]>(SELECT_TASK_BASE + 'WHERE t.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Task ' + id);
    const row = rows[0]!;
    if (!actor.isSchoolAdmin) {
      if (row.owner_id !== actor.accountId && row.created_for_id !== actor.accountId) {
        // Fail closed without leaking existence.
        throw new NotFoundException('Task ' + id);
      }
    }
    return rowToDto(row);
  }

  /**
   * Create a manual task. source=MANUAL. When assigneeAccountId is set
   * and different from the caller, the task lands on the assignee's list
   * (owner_id = assignee, created_for_id = caller) — the delegation
   * pattern. Otherwise it lands on the caller's own list.
   */
  async create(input: CreateTaskDto, actor: ResolvedActor): Promise<TaskResponseDto> {
    const tenant = getCurrentTenant();
    const taskId = generateId();
    const isDelegation = !!input.assigneeAccountId && input.assigneeAccountId !== actor.accountId;
    const ownerId = isDelegation ? input.assigneeAccountId! : actor.accountId;
    const createdForId = isDelegation ? actor.accountId : null;
    const priority = input.priority ?? 'NORMAL';
    const taskCategory = input.taskCategory ?? 'PERSONAL';
    if (!TASK_CATEGORIES.includes(taskCategory)) {
      throw new BadRequestException('Invalid taskCategory: ' + taskCategory);
    }
    // Self-service users cannot create tasks with task_category=ACKNOWLEDGEMENT
    // — that flow goes through the worker on inbound CREATE_ACKNOWLEDGEMENT
    // actions. Admins bypass for completeness (e.g. backfilling an ack
    // task that the worker missed).
    if (taskCategory === 'ACKNOWLEDGEMENT' && !actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Acknowledgement tasks are created by the system, not via /tasks',
      );
    }
    if (isDelegation && !actor.isSchoolAdmin) {
      // Non-admins can only delegate to users they have write-access to —
      // for the cycle 7 ship we restrict delegation to admins. Future
      // iterations can open this up to teachers delegating to students
      // they teach (matching the cls_class_teachers row-scope pattern
      // from Cycle 2).
      throw new ForbiddenException(
        'Only admins can create tasks on behalf of another user this cycle',
      );
    }
    if (isDelegation) {
      // Defence-in-depth: even an admin acting in tenant A must not be
      // able to land a task on a platform_users.id that belongs to
      // tenant B (cross-tenant guess). Verify the target has a domain
      // projection in this tenant — sis_students/sis_guardians/hr_employees
      // — mirroring the Cycle 6.1 ProfileService.assertTargetInCurrentTenant
      // pattern. REVIEW-CYCLE7 MAJOR 4.
      await this.assertAssigneeInCurrentTenant(input.assigneeAccountId!);
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tsk_tasks ' +
          '(id, school_id, owner_id, title, description, source, priority, status, ' +
          ' task_category, due_at, created_for_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'MANUAL', $6, 'TODO', $7, $8::timestamptz, $9::uuid)",
        taskId,
        tenant.schoolId,
        ownerId,
        input.title,
        input.description ?? null,
        priority,
        taskCategory,
        input.dueAt ?? null,
        createdForId,
      );
    });
    const dto = await this.loadOrFail(taskId);
    void this.kafka.emit({
      topic: 'task.created',
      key: taskId,
      sourceModule: 'tasks',
      payload: {
        taskId,
        ownerId,
        title: dto.title,
        priority: dto.priority,
        taskCategory: dto.taskCategory,
        source: 'MANUAL',
        sourceRefId: null,
        dueAt: dto.dueAt,
        createdForId: dto.createdForId,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
    return dto;
  }

  /**
   * Status transitions + minor edits. Status drives the multi-column
   * completed_chk: TODO/IN_PROGRESS ⇒ completed_at NULL; DONE/CANCELLED
   * ⇒ completed_at NOT NULL. Service handles the lockstep so callers
   * don't surface the constraint to end users.
   *
   * Row scope: owner can edit own rows; the task creator (actor =
   * created_for_id holder when present) can also edit; admins always.
   */
  async update(id: string, input: UpdateTaskDto, actor: ResolvedActor): Promise<TaskResponseDto> {
    const existing = await this.getById(id, actor); // also enforces row scope + 404
    const isOwner = existing.ownerId === actor.accountId;
    const isCreator = !!existing.createdForId && existing.createdForId === actor.accountId;
    if (!actor.isSchoolAdmin && !isOwner && !isCreator) {
      // getById already short-circuits with 404 on no access, but defend
      // in depth in case admins ever path through here without the row-
      // scope filter.
      throw new ForbiddenException('You cannot edit this task');
    }
    if (Object.keys(input).length === 0) return existing;

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (input.title !== undefined) {
      sets.push('title = $' + idx);
      params.push(input.title);
      idx++;
    }
    if (input.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(input.description);
      idx++;
    }
    if (input.priority !== undefined) {
      sets.push('priority = $' + idx);
      params.push(input.priority);
      idx++;
    }
    if (input.dueAt !== undefined) {
      if (input.dueAt === null) {
        sets.push('due_at = NULL');
      } else {
        sets.push('due_at = $' + idx + '::timestamptz');
        params.push(input.dueAt);
        idx++;
      }
    }
    let emitCompleted = false;
    if (input.status !== undefined) {
      // Source-of-truth lifecycle: TODO ↔ IN_PROGRESS ↔ DONE, plus
      // CANCELLED reachable from any of those. DONE → TODO and the
      // similar reverse paths are allowed (a user can mark something
      // "not done after all"); the multi-column completed_chk is the
      // schema-side guarantee.
      sets.push('status = $' + idx);
      params.push(input.status);
      idx++;
      if (input.status === 'DONE' || input.status === 'CANCELLED') {
        sets.push('completed_at = COALESCE(completed_at, now())');
        if (input.status === 'DONE' && existing.status !== 'DONE') emitCompleted = true;
      } else {
        // Re-opening — clear completed_at to satisfy completed_chk.
        sets.push('completed_at = NULL');
      }
    }
    sets.push('updated_at = now()');

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE tsk_tasks SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
        id,
      );
    });
    const updated = await this.loadOrFail(id);
    if (emitCompleted) {
      const tenant = getCurrentTenant();
      void this.kafka.emit({
        topic: 'task.completed',
        key: id,
        sourceModule: 'tasks',
        payload: {
          taskId: id,
          ownerId: updated.ownerId,
          title: updated.title,
          taskCategory: updated.taskCategory,
          source: updated.source,
          sourceRefId: updated.sourceRefId,
          completedAt: updated.completedAt,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    }
    return updated;
  }

  private async loadOrFail(id: string): Promise<TaskResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TaskRow[]>(SELECT_TASK_BASE + 'WHERE t.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Task ' + id);
    return rowToDto(rows[0]!);
  }

  /**
   * Verify that the supplied platform_users.id has a domain projection
   * (sis_students / sis_guardians / hr_employees) in the calling tenant.
   * Used by `create()` on the delegation path so that a school admin in
   * tenant A cannot land a task on an unrelated tenant B's user by
   * supplying a foreign UUID. Mirrors the Cycle 6.1 Profile pattern.
   *
   * REVIEW-CYCLE7 MAJOR 4.
   */
  private async assertAssigneeInCurrentTenant(accountId: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM platform.platform_users pu WHERE pu.id = $1::uuid AND ( ' +
          'EXISTS (SELECT 1 FROM sis_students s ' +
          '        JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '        WHERE ps.person_id = pu.person_id) ' +
          'OR EXISTS (SELECT 1 FROM sis_guardians WHERE person_id = pu.person_id) ' +
          'OR EXISTS (SELECT 1 FROM hr_employees WHERE person_id = pu.person_id)) LIMIT 1',
        accountId,
      );
    });
    if (rows.length === 0) {
      // 400 not 404 — the assigneeAccountId is request-supplied, the
      // caller didn't navigate to it. A bad UUID is invalid input, not
      // a missing resource.
      throw new BadRequestException('assigneeAccountId does not belong to a user in this school');
    }
  }
}
