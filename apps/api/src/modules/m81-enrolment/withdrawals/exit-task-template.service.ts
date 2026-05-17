import { ForbiddenException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { TaskCategory, TaskTemplateResponseDto, UpsertTaskTemplateDto } from './dto/withdrawal.dto';

interface TemplateRow {
  id: string;
  school_id: string;
  template_name: string;
  task_name: string;
  task_category: string;
  sort_order: number;
  is_active: boolean;
  is_required: boolean;
}

const DEFAULT_TEMPLATE: Array<{
  taskName: string;
  taskCategory: TaskCategory;
  isRequired: boolean;
}> = [
  { taskName: 'Library books returned', taskCategory: 'RECORDS', isRequired: true },
  { taskName: 'Device returned (Chromebook + charger)', taskCategory: 'IT', isRequired: true },
  { taskName: 'Locker cleared', taskCategory: 'FACILITIES', isRequired: true },
  { taskName: 'Outstanding fees resolved', taskCategory: 'FINANCE', isRequired: true },
  { taskName: 'Records package prepared for transfer', taskCategory: 'RECORDS', isRequired: true },
  { taskName: 'Bus assignment cancelled', taskCategory: 'TRANSPORT', isRequired: false },
  { taskName: 'Lunch account closed', taskCategory: 'ADMINISTRATIVE', isRequired: false },
];

/**
 * ExitTaskTemplateService — configurable per-school exit task
 * checklist used by WithdrawalService.create to auto-create
 * enr_withdrawal_exit_tasks rows.
 *
 * Default is the 7-task baseline. Schools customise by replacing
 * the template entirely (UpsertTaskTemplateDto) which DELETEs
 * every active row in the template and INSERTs the supplied
 * tasks. UNIQUE(school_id, template_name, task_name) prevents
 * duplicate task names within a template.
 */
@Injectable()
export class ExitTaskTemplateService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Exit task template management requires stu-004:admin');
    }
  }

  private rowToDto(r: TemplateRow): TaskTemplateResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      templateName: r.template_name,
      taskName: r.task_name,
      taskCategory: r.task_category as TaskCategory,
      sortOrder: r.sort_order,
      isActive: r.is_active,
      isRequired: r.is_required,
    };
  }

  /**
   * Read the active template, lazily creating the DEFAULT baseline
   * the first time a school calls listActive (so a fresh tenant
   * with no admin-side configuration still has a working
   * withdrawal flow on day one).
   */
  async listActive(
    schoolId: string,
    templateName: string,
    _actor: ResolvedActor,
  ): Promise<TaskTemplateResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      let rows = (await client.$queryRawUnsafe(
        'SELECT id, school_id, template_name, task_name, task_category, sort_order, is_active, is_required ' +
          'FROM enr_withdrawal_task_templates ' +
          'WHERE school_id = $1::uuid AND template_name = $2 AND is_active = true ' +
          'ORDER BY sort_order',
        schoolId,
        templateName,
      )) as TemplateRow[];

      if (rows.length === 0 && templateName === 'DEFAULT') {
        // Lazy-seed the baseline 7 tasks.
        for (let i = 0; i < DEFAULT_TEMPLATE.length; i++) {
          const t = DEFAULT_TEMPLATE[i]!;
          await client.$executeRawUnsafe(
            'INSERT INTO enr_withdrawal_task_templates ' +
              '(id, school_id, template_name, task_name, task_category, sort_order, is_required, is_active) ' +
              'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, true) ON CONFLICT DO NOTHING',
            generateId(),
            schoolId,
            templateName,
            t.taskName,
            t.taskCategory,
            i,
            t.isRequired,
          );
        }
        rows = (await client.$queryRawUnsafe(
          'SELECT id, school_id, template_name, task_name, task_category, sort_order, is_active, is_required ' +
            'FROM enr_withdrawal_task_templates ' +
            'WHERE school_id = $1::uuid AND template_name = $2 AND is_active = true ' +
            'ORDER BY sort_order',
          schoolId,
          templateName,
        )) as TemplateRow[];
      }
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async list(actor: ResolvedActor): Promise<TaskTemplateResponseDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.listActive(tenant.schoolId, 'DEFAULT', actor);
  }

  async upsert(
    input: UpsertTaskTemplateDto,
    actor: ResolvedActor,
  ): Promise<TaskTemplateResponseDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Mark every existing row inactive (preserve historical UNIQUE
      // by NOT deleting — schools that re-add a previously removed
      // task can flip is_active back via a fresh upsert).
      await tx.$executeRawUnsafe(
        'UPDATE enr_withdrawal_task_templates SET is_active = false, updated_at = now() ' +
          "WHERE school_id = $1::uuid AND template_name = 'DEFAULT'",
        tenant.schoolId,
      );

      for (let i = 0; i < input.tasks.length; i++) {
        const t = input.tasks[i]!;
        await tx.$executeRawUnsafe(
          'INSERT INTO enr_withdrawal_task_templates ' +
            '(id, school_id, template_name, task_name, task_category, sort_order, is_required, is_active) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, true) ' +
            'ON CONFLICT (school_id, template_name, task_name) DO UPDATE SET ' +
            '  task_category = EXCLUDED.task_category, ' +
            '  sort_order = EXCLUDED.sort_order, ' +
            '  is_required = EXCLUDED.is_required, ' +
            '  is_active = true, updated_at = now()',
          generateId(),
          tenant.schoolId,
          'DEFAULT',
          t.taskName,
          t.taskCategory,
          i,
          t.isRequired ?? true,
        );
      }
    });

    return this.list(actor);
  }
}
