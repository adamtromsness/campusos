import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { InitOnboardingDto, OnboardingChecklistDto, PatchOnboardingTaskDto } from '../dto/crm.dto';
import { AccountService } from './account.service';

/**
 * P2-21a — OnboardingService.
 *
 * Initialises a checklist + task set for an account. Mutating a task
 * (complete or skip) runs inside one transaction:
 *   1. PATCH the task row
 *   2. If checklist now has 0 PENDING and at least 1 task, flip
 *      checklist > COMPLETED.
 *   3. On COMPLETED flip, ask AccountService.autoFlipOnOnboardingComplete
 *      to flip the parent account ONBOARDING > ACTIVE. AccountService
 *      no-ops when the account is in any other state.
 *
 * The first task transition out of PENDING also starts the checklist
 * (NOT_STARTED > IN_PROGRESS, stamping started_at).
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  // Default template — runs on initOnboarding when no tasks are supplied.
  private static readonly DEFAULT_TEMPLATE: Array<{
    name: string;
    category: 'TECHNICAL' | 'DATA_MIGRATION' | 'TRAINING' | 'CONFIGURATION' | 'GO_LIVE';
  }> = [
    { name: 'Provision tenant schema', category: 'TECHNICAL' },
    { name: 'Configure SSO / SAML', category: 'CONFIGURATION' },
    { name: 'Import student roster', category: 'DATA_MIGRATION' },
    { name: 'Import staff directory', category: 'DATA_MIGRATION' },
    { name: 'Run administrator training', category: 'TRAINING' },
    { name: 'Run teacher training', category: 'TRAINING' },
    { name: 'Configure attendance + grading policies', category: 'CONFIGURATION' },
    { name: 'Go-live readiness review', category: 'GO_LIVE' },
  ];

  constructor(
    private readonly platform: PrismaClient,
    private readonly accounts: AccountService,
  ) {}

  async getForAccount(accountId: string): Promise<OnboardingChecklistDto | null> {
    await this.accounts.loadOrFail(accountId);
    const rows = await this.platform.$queryRawUnsafe<RawChecklistRow[]>(
      `SELECT id::text, account_id::text, template_version, started_at, completed_at, status
       FROM platform.crm_onboarding_checklists WHERE account_id = $1::uuid LIMIT 1`,
      accountId,
    );
    if (rows.length === 0) return null;
    return this.hydrateChecklist(rows[0]!);
  }

  async init(accountId: string, input: InitOnboardingDto): Promise<OnboardingChecklistDto> {
    await this.accounts.loadOrFail(accountId);

    const existing = await this.platform.$queryRawUnsafe<RawChecklistRow[]>(
      `SELECT id::text FROM platform.crm_onboarding_checklists WHERE account_id = $1::uuid LIMIT 1`,
      accountId,
    );
    if (existing.length > 0) {
      throw new ConflictException(
        `Account ${accountId} already has an onboarding checklist. PATCH tasks individually.`,
      );
    }

    const checklistId = generateId();
    const tasks =
      input.tasks && input.tasks.length > 0
        ? input.tasks
        : OnboardingService.DEFAULT_TEMPLATE.map((t, i) => ({
            taskName: t.name,
            taskCategory: t.category,
            sortOrder: i,
          }));

    if (tasks.length === 0) {
      throw new BadRequestException('Onboarding checklist must include at least one task.');
    }

    await this.platform.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.crm_onboarding_checklists
          (id, account_id, template_version, status)
         VALUES ($1::uuid, $2::uuid, $3, 'NOT_STARTED')`,
        checklistId,
        accountId,
        input.templateVersion ?? 1,
      );
      for (const t of tasks) {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.crm_onboarding_tasks
            (id, checklist_id, task_name, task_category, sort_order, status)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'PENDING')`,
          generateId(),
          checklistId,
          t.taskName,
          t.taskCategory,
          t.sortOrder,
        );
      }
    });

    const checklist = await this.getForAccount(accountId);
    return checklist!;
  }

  /**
   * Patch a single task's status. Status transitions:
   *   PENDING > COMPLETED  (stamps completed_at + completed_by)
   *   PENDING > SKIPPED    (stamps completed_at + completed_by; service treats SKIP as terminal)
   *   COMPLETED|SKIPPED > PENDING  (re-opens, clears completed_at / completed_by)
   *
   * Then re-evaluates parent checklist status:
   *   any move from NOT_STARTED > IN_PROGRESS stamps started_at
   *   when 0 PENDING tasks remain > COMPLETED, stamping completed_at
   *   when re-opening to PENDING from a COMPLETED checklist, status
   *     flips back to IN_PROGRESS and completed_at clears.
   *
   * The account auto-flip ONBOARDING > ACTIVE fires when the checklist
   * lands at COMPLETED.
   */
  async patchTask(
    taskId: string,
    actorPersonId: string,
    input: PatchOnboardingTaskDto,
  ): Promise<OnboardingChecklistDto> {
    const taskRows = await this.platform.$queryRawUnsafe<RawTaskRow[]>(
      `SELECT t.id::text, t.checklist_id::text, t.task_name, t.task_category, t.sort_order,
              t.status, t.completed_at, t.completed_by::text,
              c.account_id::text AS account_id, c.status AS checklist_status
       FROM platform.crm_onboarding_tasks t
       JOIN platform.crm_onboarding_checklists c ON c.id = t.checklist_id
       WHERE t.id = $1::uuid`,
      taskId,
    );
    if (taskRows.length === 0) throw new NotFoundException(`Onboarding task ${taskId} not found.`);
    const task = taskRows[0]!;

    let triggerAccountAutoFlip = false;

    await this.platform.$transaction(async (tx) => {
      const target = input.status;
      const isReopening = target === 'PENDING';
      const isCompleting = target === 'COMPLETED' || target === 'SKIPPED';

      if (isReopening) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_onboarding_tasks
             SET status = 'PENDING', completed_at = NULL, completed_by = NULL, updated_at = now()
           WHERE id = $1::uuid`,
          taskId,
        );
      } else if (isCompleting) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_onboarding_tasks
             SET status = $1, completed_at = now(), completed_by = $2::uuid, updated_at = now()
           WHERE id = $3::uuid`,
          target,
          actorPersonId,
          taskId,
        );
      } else {
        throw new BadRequestException(`Illegal task status ${target}.`);
      }

      // Re-evaluate parent checklist.
      const stats = await tx.$queryRawUnsafe<Array<{ total: number; pending: number }>>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending
         FROM platform.crm_onboarding_tasks WHERE checklist_id = $1::uuid`,
        task.checklist_id,
      );
      const { total, pending } = stats[0]!;
      const checklistStatus = task.checklist_status;

      if (checklistStatus === 'NOT_STARTED' && pending < total) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_onboarding_checklists
             SET status = 'IN_PROGRESS', started_at = now(), updated_at = now()
           WHERE id = $1::uuid`,
          task.checklist_id,
        );
      }

      if (pending === 0 && total > 0 && checklistStatus !== 'COMPLETED') {
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_onboarding_checklists
             SET status = 'COMPLETED', completed_at = now(),
                 started_at = COALESCE(started_at, now()), updated_at = now()
           WHERE id = $1::uuid`,
          task.checklist_id,
        );
        triggerAccountAutoFlip = true;
      } else if (pending > 0 && checklistStatus === 'COMPLETED') {
        // Re-open a completed checklist by clearing completed_at and
        // flipping back to IN_PROGRESS. started_at preserved.
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_onboarding_checklists
             SET status = 'IN_PROGRESS', completed_at = NULL, updated_at = now()
           WHERE id = $1::uuid`,
          task.checklist_id,
        );
      }
    });

    if (triggerAccountAutoFlip) {
      try {
        await this.accounts.autoFlipOnOnboardingComplete(task.account_id);
      } catch (e: unknown) {
        this.logger.warn(
          `[crm-onboarding] auto-flip to ACTIVE failed for account ${task.account_id}: ${(e as Error).message}`,
        );
      }
    }

    const checklist = await this.getForAccount(task.account_id);
    return checklist!;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private async hydrateChecklist(row: RawChecklistRow): Promise<OnboardingChecklistDto> {
    const tasks = await this.platform.$queryRawUnsafe<RawTaskOnlyRow[]>(
      `SELECT id::text, task_name, task_category, sort_order, status,
              completed_at, completed_by::text
       FROM platform.crm_onboarding_tasks WHERE checklist_id = $1::uuid
       ORDER BY sort_order ASC`,
      row.id,
    );
    let pending = 0;
    let completed = 0;
    let skipped = 0;
    for (const t of tasks) {
      if (t.status === 'PENDING') pending++;
      else if (t.status === 'COMPLETED') completed++;
      else if (t.status === 'SKIPPED') skipped++;
    }
    return {
      id: row.id,
      accountId: row.account_id,
      templateVersion: row.template_version,
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      status: row.status as OnboardingChecklistDto['status'],
      tasks: tasks.map((t) => ({
        id: t.id,
        checklistId: row.id,
        taskName: t.task_name,
        taskCategory: t.task_category as OnboardingChecklistDto['tasks'][number]['taskCategory'],
        sortOrder: t.sort_order,
        status: t.status as OnboardingChecklistDto['tasks'][number]['status'],
        completedAt: t.completed_at ? t.completed_at.toISOString() : null,
        completedBy: t.completed_by,
      })),
      taskCounts: { total: tasks.length, pending, completed, skipped },
    };
  }
}

interface RawChecklistRow {
  id: string;
  account_id: string;
  template_version: number;
  started_at: Date | null;
  completed_at: Date | null;
  status: string;
}

interface RawTaskRow {
  id: string;
  checklist_id: string;
  task_name: string;
  task_category: string;
  sort_order: number;
  status: string;
  completed_at: Date | null;
  completed_by: string | null;
  account_id: string;
  checklist_status: string;
}

interface RawTaskOnlyRow {
  id: string;
  task_name: string;
  task_category: string;
  sort_order: number;
  status: string;
  completed_at: Date | null;
  completed_by: string | null;
}
