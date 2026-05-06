import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  AddWorkOrderCommentDto,
  ChecklistResultResponseDto,
  CreatePmPlanDto,
  CreateWorkOrderDto,
  GeneratePmTasksDto,
  PmChecklistItemResponseDto,
  PmPlanResponseDto,
  PmTargetType,
  PmTaskResponseDto,
  PmTaskStatus,
  SubmitChecklistResultsDto,
  UpdatePmPlanDto,
  UpdatePmTaskDto,
  UpdateWorkOrderDto,
  WorkOrderActivityResponseDto,
  WorkOrderActivityType,
  WorkOrderPriority,
  WorkOrderResponseDto,
  WorkOrderStatus,
  WorkOrderType,
} from './dto/facilities.dto';

function assertCanManage(actor: ResolvedActor): void {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'STAFF') return;
  throw new ForbiddenException('Only school admins or facilities staff can manage work orders');
}

interface TxClient {
  $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
}

@Injectable()
export class WorkOrderService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(args: {
    status?: WorkOrderStatus;
    priority?: WorkOrderPriority;
    buildingId?: string;
    assignedToId?: string;
  }): Promise<WorkOrderResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['w.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      where.push('w.status = $' + (params.length + 1));
      params.push(args.status);
    }
    if (args.priority) {
      where.push('w.priority = $' + (params.length + 1));
      params.push(args.priority);
    }
    if (args.buildingId) {
      where.push('w.building_id = $' + (params.length + 1) + '::uuid');
      params.push(args.buildingId);
    }
    if (args.assignedToId) {
      where.push('w.assigned_to_id = $' + (params.length + 1) + '::uuid');
      params.push(args.assignedToId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        WO_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY w.created_at DESC LIMIT 200',
        ...params,
      );
    })) as WoRow[];
    return rows.map(woRowToDto);
  }

  async getById(id: string, includeActivity = true): Promise<WorkOrderResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(WO_SELECT + 'WHERE w.id = $1::uuid LIMIT 1', id);
    })) as WoRow[];
    if (rows.length === 0) throw new NotFoundException('Work order not found');
    const dto = woRowToDto(rows[0]!);
    if (includeActivity) {
      dto.activity = await this.listActivity(id);
    }
    return dto;
  }

  async listActivity(workOrderId: string): Promise<WorkOrderActivityResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.work_order_id::text AS work_order_id, a.actor_id::text AS actor_id, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
          '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = a.actor_id) AS actor_name, ' +
          'a.activity_type, a.metadata, a.created_at ' +
          'FROM fac_work_order_activity a WHERE a.work_order_id = $1::uuid ' +
          'ORDER BY a.created_at ASC',
        workOrderId,
      );
    })) as Array<{
      id: string;
      work_order_id: string;
      actor_id: string;
      actor_name: string | null;
      activity_type: string;
      metadata: unknown;
      created_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      workOrderId: r.work_order_id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      activityType: r.activity_type as WorkOrderActivityType,
      metadata: r.metadata,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async create(input: CreateWorkOrderDto, actor: ResolvedActor): Promise<WorkOrderResponseDto> {
    assertCanManage(actor);
    if (!actor.personId) {
      throw new ForbiddenException('Work order creation requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fac_work_orders (id, school_id, work_order_type, priority, space_id, building_id, assigned_to_id, vendor_id, scheduled_date, status, tkt_ticket_id, description, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::date, 'OPEN', $10::uuid, $11, $12::uuid)",
        id,
        tenant.schoolId,
        input.workOrderType,
        input.priority,
        input.spaceId ?? null,
        input.buildingId ?? null,
        input.assignedToId ?? null,
        input.vendorId ?? null,
        input.scheduledDate ?? null,
        input.tktTicketId ?? null,
        input.description ?? null,
        actor.personId,
      );
    });

    await this.kafka.emit({
      topic: 'fac.work_order.created',
      key: id,
      sourceModule: 'facilities',
      payload: {
        workOrderId: id,
        sourceRefId: id,
        workOrderType: input.workOrderType,
        priority: input.priority,
        spaceId: input.spaceId ?? null,
        buildingId: input.buildingId ?? null,
        assignedToId: input.assignedToId ?? null,
        vendorId: input.vendorId ?? null,
        tktTicketId: input.tktTicketId ?? null,
      },
    });

    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateWorkOrderDto,
    actor: ResolvedActor,
  ): Promise<WorkOrderResponseDto> {
    assertCanManage(actor);
    if (!actor.personId) {
      throw new ForbiddenException('Work order edit requires an authenticated person');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, status, assigned_to_id::text AS assigned_to_id FROM fac_work_orders WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string; assigned_to_id: string | null }>;
      if (locked.length === 0) throw new NotFoundException('Work order not found');
      const before = locked[0]!;

      const sets: string[] = [];
      const params: unknown[] = [];
      const activityRows: Array<{ type: WorkOrderActivityType; metadata: object }> = [];

      if (input.status !== undefined && input.status !== before.status) {
        sets.push('status = $' + (params.length + 1));
        params.push(input.status);
        if (input.status === 'COMPLETED') {
          sets.push('completed_at = now()');
        } else if (before.status === 'COMPLETED') {
          sets.push('completed_at = NULL');
        }
        activityRows.push({
          type: 'STATUS_CHANGE',
          metadata: { from: before.status, to: input.status },
        });
      }
      if (input.priority !== undefined) {
        sets.push('priority = $' + (params.length + 1));
        params.push(input.priority);
      }
      if (input.assignedToId !== undefined) {
        if (input.assignedToId !== before.assigned_to_id) {
          activityRows.push({
            type: 'REASSIGNMENT',
            metadata: {
              from: before.assigned_to_id,
              to: input.assignedToId,
            },
          });
        }
        sets.push('assigned_to_id = $' + (params.length + 1) + '::uuid');
        params.push(input.assignedToId);
      }
      if (input.vendorId !== undefined) {
        sets.push('vendor_id = $' + (params.length + 1) + '::uuid');
        params.push(input.vendorId);
      }
      if (input.scheduledDate !== undefined) {
        sets.push('scheduled_date = $' + (params.length + 1) + '::date');
        params.push(input.scheduledDate);
      }
      if (input.cost !== undefined) {
        sets.push('cost = $' + (params.length + 1));
        params.push(input.cost);
      }
      if (input.description !== undefined) {
        sets.push('description = $' + (params.length + 1));
        params.push(input.description);
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + (params.length + 1));
        params.push(input.notes);
      }
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        await tx.$executeRawUnsafe(
          'UPDATE fac_work_orders SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      }
      for (const a of activityRows) {
        await this.recordActivityInTx(tx as TxClient, id, actor.accountId, a.type, a.metadata);
      }
    });
    return this.getById(id);
  }

  async addComment(
    id: string,
    input: AddWorkOrderCommentDto,
    actor: ResolvedActor,
  ): Promise<WorkOrderResponseDto> {
    assertCanManage(actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await this.recordActivityInTx(client as TxClient, id, actor.accountId, 'COMMENT', {
        body: input.body,
      });
    });
    return this.getById(id);
  }

  async recordActivityInTx(
    tx: TxClient,
    workOrderId: string,
    actorAccountId: string,
    activityType: WorkOrderActivityType,
    metadata: object,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      'INSERT INTO fac_work_order_activity (id, work_order_id, actor_id, activity_type, metadata) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)',
      generateId(),
      workOrderId,
      actorAccountId,
      activityType,
      JSON.stringify(metadata),
    );
  }
}

@Injectable()
export class MaintenancePlanService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(): Promise<PmPlanResponseDto[]> {
    const tenant = getCurrentTenant();
    const planRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT p.id::text AS id, p.school_id::text AS school_id, p.name, p.description, p.frequency_months, p.target_type, ' +
          'p.target_id::text AS target_id, p.is_active ' +
          'FROM fac_preventive_maintenance_plans p WHERE p.school_id = $1::uuid ORDER BY p.name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      frequency_months: number;
      target_type: string;
      target_id: string | null;
      is_active: boolean;
    }>;
    const out: PmPlanResponseDto[] = [];
    for (const p of planRows) {
      const items = await this.listItems(p.id);
      out.push({
        id: p.id,
        schoolId: p.school_id,
        name: p.name,
        description: p.description,
        frequencyMonths: p.frequency_months,
        targetType: p.target_type as PmTargetType,
        targetId: p.target_id,
        isActive: p.is_active,
        items,
      });
    }
    return out;
  }

  async getById(id: string): Promise<PmPlanResponseDto> {
    const list = await this.list();
    const found = list.find((p) => p.id === id);
    if (!found) throw new NotFoundException('PM plan not found');
    return found;
  }

  async listItems(planId: string): Promise<PmChecklistItemResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, plan_id::text AS plan_id, item_name, description, sort_order ' +
          'FROM fac_preventive_maintenance_checklist_items WHERE plan_id = $1::uuid ORDER BY sort_order',
        planId,
      );
    })) as Array<{
      id: string;
      plan_id: string;
      item_name: string;
      description: string | null;
      sort_order: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      itemName: r.item_name,
      description: r.description,
      sortOrder: r.sort_order,
    }));
  }

  async create(input: CreatePmPlanDto, actor: ResolvedActor): Promise<PmPlanResponseDto> {
    assertCanManage(actor);
    if (!actor.personId) {
      throw new ForbiddenException('PM plan creation requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const planId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO fac_preventive_maintenance_plans (id, school_id, name, description, frequency_months, target_type, target_id, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::uuid)',
        planId,
        tenant.schoolId,
        input.name,
        input.description ?? null,
        input.frequencyMonths,
        input.targetType,
        input.targetId ?? null,
        actor.personId,
      );
      const items = input.items ?? [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        await tx.$executeRawUnsafe(
          'INSERT INTO fac_preventive_maintenance_checklist_items (id, plan_id, item_name, description, sort_order) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          generateId(),
          planId,
          it.itemName,
          it.description ?? null,
          it.sortOrder ?? i,
        );
      }
    });
    return this.getById(planId);
  }

  async patch(
    id: string,
    input: UpdatePmPlanDto,
    actor: ResolvedActor,
  ): Promise<PmPlanResponseDto> {
    assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.frequencyMonths !== undefined) {
      sets.push('frequency_months = $' + (params.length + 1));
      params.push(input.frequencyMonths);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_preventive_maintenance_plans SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }

  async generateTasks(
    planId: string,
    input: GeneratePmTasksDto,
    actor: ResolvedActor,
  ): Promise<{ created: number; skipped: number; firstId: string | null }> {
    assertCanManage(actor);
    const plan = await this.getById(planId);
    if (!plan.isActive) {
      throw new BadRequestException('Cannot generate tasks for an inactive PM plan');
    }
    const fromDate = new Date(input.fromDate);
    const toDate = new Date(input.toDate);
    if (toDate < fromDate) {
      throw new BadRequestException('toDate must be on or after fromDate');
    }
    let created = 0;
    let skipped = 0;
    let firstId: string | null = null;
    const cursor = new Date(fromDate);
    while (cursor <= toDate) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const taskId = generateId();
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'INSERT INTO fac_preventive_maintenance_tasks (id, plan_id, scheduled_date, status) ' +
              "VALUES ($1::uuid, $2::uuid, $3::date, 'SCHEDULED') " +
              'ON CONFLICT (plan_id, scheduled_date) DO NOTHING',
            taskId,
            planId,
            dateStr,
          );
        });
        // Verify whether the row was created
        const probe = (await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe(
            'SELECT id::text AS id FROM fac_preventive_maintenance_tasks WHERE id = $1::uuid',
            taskId,
          );
        })) as Array<{ id: string }>;
        if (probe.length > 0) {
          created++;
          if (!firstId) firstId = taskId;
        } else {
          skipped++;
        }
      } catch (err) {
        skipped++;
      }
      // Advance by frequency_months
      cursor.setMonth(cursor.getMonth() + plan.frequencyMonths);
    }
    return { created, skipped, firstId };
  }
}

@Injectable()
export class MaintenanceTaskService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly workOrders: WorkOrderService,
  ) {}

  async list(args: {
    planId?: string;
    status?: PmTaskStatus;
    fromDate?: string;
    toDate?: string;
  }): Promise<PmTaskResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['p.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.planId) {
      where.push('t.plan_id = $' + (params.length + 1) + '::uuid');
      params.push(args.planId);
    }
    if (args.status) {
      where.push('t.status = $' + (params.length + 1));
      params.push(args.status);
    }
    if (args.fromDate) {
      where.push('t.scheduled_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('t.scheduled_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        TASK_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY t.scheduled_date DESC LIMIT 200',
        ...params,
      );
    })) as TaskRow[];
    return rows.map(taskRowToDto);
  }

  async getById(id: string): Promise<PmTaskResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(TASK_SELECT + 'WHERE t.id = $1::uuid LIMIT 1', id);
    })) as TaskRow[];
    if (rows.length === 0) throw new NotFoundException('PM task not found');
    return taskRowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdatePmTaskDto,
    actor: ResolvedActor,
  ): Promise<PmTaskResponseDto> {
    assertCanManage(actor);
    if (!actor.personId) {
      throw new ForbiddenException('PM task update requires an authenticated person');
    }
    const before = await this.getById(id);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.status !== undefined) {
        sets.push('status = $' + (params.length + 1));
        params.push(input.status);
        if (input.status === 'COMPLETED') {
          sets.push('completed_at = now()');
          sets.push('completed_by = $' + (params.length + 1) + '::uuid');
          params.push(actor.personId);
        } else if (before.status === 'COMPLETED') {
          sets.push('completed_at = NULL');
          sets.push('completed_by = NULL');
        }
      }
      if (input.assignedTo !== undefined) {
        sets.push('assigned_to = $' + (params.length + 1) + '::uuid');
        params.push(input.assignedTo);
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + (params.length + 1));
        params.push(input.notes);
      }
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        await tx.$executeRawUnsafe(
          'UPDATE fac_preventive_maintenance_tasks SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      }
    });
    if (input.status === 'OVERDUE' && before.status !== 'OVERDUE') {
      await this.kafka.emit({
        topic: 'fac.maintenance_task.overdue',
        key: id,
        sourceModule: 'facilities',
        payload: {
          taskId: id,
          sourceRefId: id,
          planId: before.planId,
          planName: before.planName,
          scheduledDate: before.scheduledDate,
          assignedTo: before.assignedTo,
        },
      });
    }
    return this.getById(id);
  }

  async submitResults(
    taskId: string,
    input: SubmitChecklistResultsDto,
    actor: ResolvedActor,
  ): Promise<{ task: PmTaskResponseDto; followUpWorkOrders: string[] }> {
    assertCanManage(actor);
    if (!actor.personId) {
      throw new ForbiddenException('Submitting results requires an authenticated person');
    }
    const followUps: string[] = [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const taskRow = (await tx.$queryRawUnsafe(
        'SELECT t.id, t.plan_id::text AS plan_id, p.school_id::text AS school_id, ' +
          't.assigned_to::text AS assigned_to, p.target_type, p.target_id::text AS target_id, p.name AS plan_name ' +
          'FROM fac_preventive_maintenance_tasks t JOIN fac_preventive_maintenance_plans p ON p.id = t.plan_id ' +
          'WHERE t.id = $1::uuid FOR UPDATE',
        taskId,
      )) as Array<{
        id: string;
        plan_id: string;
        school_id: string;
        assigned_to: string | null;
        target_type: string;
        target_id: string | null;
        plan_name: string;
      }>;
      if (taskRow.length === 0) throw new NotFoundException('PM task not found');
      const task = taskRow[0]!;

      for (const r of input.results) {
        let followUpWoId: string | null = null;
        if (r.passed === false) {
          // Auto-create follow-up work order in the same tx — addresses
          // FAIL → corrective work cycle keystone.
          followUpWoId = generateId();
          // Resolve building_id when target_type=BUILDING; SPACE -> derive
          // building_id from the space row.
          let buildingId: string | null = null;
          let spaceId: string | null = null;
          if (task.target_type === 'BUILDING') {
            buildingId = task.target_id;
          } else if (task.target_type === 'SPACE' && task.target_id) {
            spaceId = task.target_id;
            const sp = (await tx.$queryRawUnsafe(
              'SELECT building_id::text AS building_id FROM fac_spaces WHERE id = $1::uuid',
              task.target_id,
            )) as Array<{ building_id: string }>;
            buildingId = sp[0]?.building_id ?? null;
          }
          await tx.$executeRawUnsafe(
            'INSERT INTO fac_work_orders (id, school_id, work_order_type, priority, space_id, building_id, assigned_to_id, status, description, created_by) ' +
              "VALUES ($1::uuid, $2::uuid, 'REPAIR', 'MEDIUM', $3::uuid, $4::uuid, $5::uuid, 'OPEN', $6, $7::uuid)",
            followUpWoId,
            task.school_id,
            spaceId,
            buildingId,
            task.assigned_to,
            'Follow-up from PM task — ' +
              task.plan_name +
              ' — checklist item flagged: see fac_maintenance_checklist_results',
            actor.personId,
          );
          followUps.push(followUpWoId);

          await this.workOrders.recordActivityInTx(
            tx as TxClient,
            followUpWoId,
            actor.accountId,
            'COMMENT',
            {
              body:
                'Auto-created from PM task ' +
                taskId +
                ' on FAIL of checklist item ' +
                r.checklistItemId,
            },
          );
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO fac_maintenance_checklist_results (id, task_id, checklist_item_id, passed, notes, photo_s3_keys, follow_up_work_order_id, submitted_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[], $7::uuid, $8::uuid)',
          generateId(),
          taskId,
          r.checklistItemId,
          r.passed,
          r.notes ?? null,
          r.photoS3Keys ?? [],
          followUpWoId,
          actor.personId,
        );
      }
    });
    return { task: await this.getById(taskId), followUpWorkOrders: followUps };
  }

  async listResults(taskId: string): Promise<ChecklistResultResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.task_id::text AS task_id, r.checklist_item_id::text AS checklist_item_id, ' +
          'i.item_name, r.passed, r.notes, r.photo_s3_keys, r.follow_up_work_order_id::text AS follow_up_work_order_id, ' +
          'r.submitted_by::text AS submitted_by, r.submitted_at ' +
          'FROM fac_maintenance_checklist_results r ' +
          'JOIN fac_preventive_maintenance_checklist_items i ON i.id = r.checklist_item_id ' +
          'WHERE r.task_id = $1::uuid ORDER BY i.sort_order',
        taskId,
      );
    })) as Array<{
      id: string;
      task_id: string;
      checklist_item_id: string;
      item_name: string;
      passed: boolean;
      notes: string | null;
      photo_s3_keys: string[];
      follow_up_work_order_id: string | null;
      submitted_by: string;
      submitted_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      checklistItemId: r.checklist_item_id,
      itemName: r.item_name,
      passed: r.passed,
      notes: r.notes,
      photoS3Keys: r.photo_s3_keys,
      followUpWorkOrderId: r.follow_up_work_order_id,
      submittedBy: r.submitted_by,
      submittedAt: r.submitted_at.toISOString(),
    }));
  }
}

interface WoRow {
  id: string;
  school_id: string;
  work_order_type: string;
  priority: string;
  space_id: string | null;
  space_name: string | null;
  building_id: string | null;
  building_name: string | null;
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  scheduled_date: Date | null;
  completed_at: Date | null;
  status: string;
  tkt_ticket_id: string | null;
  cost: number | null;
  description: string | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
}

const WO_SELECT =
  'SELECT w.id::text AS id, w.school_id::text AS school_id, w.work_order_type, w.priority, ' +
  'w.space_id::text AS space_id, sp.name AS space_name, ' +
  'w.building_id::text AS building_id, b.name AS building_name, ' +
  'w.assigned_to_id::text AS assigned_to_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip JOIN hr_employees e ON e.person_id = ip.id WHERE e.id = w.assigned_to_id) AS assigned_to_name, " +
  'w.vendor_id::text AS vendor_id, v.vendor_name AS vendor_name, ' +
  'w.scheduled_date, w.completed_at, w.status, w.tkt_ticket_id::text AS tkt_ticket_id, ' +
  'w.cost, w.description, w.notes, w.created_by::text AS created_by, w.created_at ' +
  'FROM fac_work_orders w ' +
  'LEFT JOIN fac_spaces sp ON sp.id = w.space_id ' +
  'LEFT JOIN fac_buildings b ON b.id = w.building_id ' +
  'LEFT JOIN tkt_vendors v ON v.id = w.vendor_id ';

function woRowToDto(r: WoRow): WorkOrderResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    workOrderType: r.work_order_type as WorkOrderType,
    priority: r.priority as WorkOrderPriority,
    spaceId: r.space_id,
    spaceName: r.space_name,
    buildingId: r.building_id,
    buildingName: r.building_name,
    assignedToId: r.assigned_to_id,
    assignedToName: r.assigned_to_name,
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    scheduledDate: r.scheduled_date ? r.scheduled_date.toISOString().slice(0, 10) : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    status: r.status as WorkOrderStatus,
    tktTicketId: r.tkt_ticket_id,
    cost: r.cost !== null ? Number(r.cost) : null,
    description: r.description,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

interface TaskRow {
  id: string;
  plan_id: string;
  plan_name: string;
  scheduled_date: Date;
  assigned_to: string | null;
  assigned_to_name: string | null;
  status: string;
  completed_at: Date | null;
  completed_by: string | null;
  notes: string | null;
}

const TASK_SELECT =
  'SELECT t.id::text AS id, t.plan_id::text AS plan_id, p.name AS plan_name, t.scheduled_date, ' +
  't.assigned_to::text AS assigned_to, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip JOIN hr_employees e ON e.person_id = ip.id WHERE e.id = t.assigned_to) AS assigned_to_name, " +
  't.status, t.completed_at, t.completed_by::text AS completed_by, t.notes ' +
  'FROM fac_preventive_maintenance_tasks t JOIN fac_preventive_maintenance_plans p ON p.id = t.plan_id ';

function taskRowToDto(r: TaskRow): PmTaskResponseDto {
  return {
    id: r.id,
    planId: r.plan_id,
    planName: r.plan_name,
    scheduledDate: r.scheduled_date.toISOString().slice(0, 10),
    assignedTo: r.assigned_to,
    assignedToName: r.assigned_to_name,
    status: r.status as PmTaskStatus,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    completedBy: r.completed_by,
    notes: r.notes,
  };
}
