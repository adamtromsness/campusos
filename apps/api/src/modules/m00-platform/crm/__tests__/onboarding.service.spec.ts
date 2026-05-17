import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OnboardingService } from '../services/onboarding.service';
import { AccountService } from '../services/account.service';

/**
 * P2-21a — OnboardingService keystone tests.
 *
 * The keystone behaviour: completing the last PENDING task auto-flips
 * the checklist to COMPLETED, which calls AccountService.
 * autoFlipOnOnboardingComplete(accountId) on the parent. That method
 * is stubbed here and we assert it was called with the right account id.
 */

interface TaskRow {
  id: string;
  task_name: string;
  task_category: string;
  sort_order: number;
  status: 'PENDING' | 'COMPLETED' | 'SKIPPED';
  completed_at: Date | null;
  completed_by: string | null;
}

interface ChecklistRow {
  id: string;
  account_id: string;
  template_version: number;
  started_at: Date | null;
  completed_at: Date | null;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
}

interface FakeState {
  checklist: ChecklistRow | null;
  tasks: TaskRow[];
  accountAutoFlipCalls: string[];
}

function buildStubs(initial: { tasks: TaskRow[]; checklistStatus: ChecklistRow['status'] }): {
  state: FakeState;
  prisma: any;
  accountService: AccountService;
} {
  const state: FakeState = {
    checklist: {
      id: 'cl-1',
      account_id: 'acct-1',
      template_version: 1,
      started_at: initial.checklistStatus === 'NOT_STARTED' ? null : new Date('2026-01-01'),
      completed_at: initial.checklistStatus === 'COMPLETED' ? new Date('2026-02-01') : null,
      status: initial.checklistStatus,
    },
    tasks: initial.tasks,
    accountAutoFlipCalls: [],
  };

  const prisma = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes('SELECT t.id::text, t.checklist_id::text, t.task_name')) {
        const id = params[0] as string;
        const task = state.tasks.find((t) => t.id === id);
        if (!task) return [];
        return [
          {
            ...task,
            account_id: 'acct-1',
            checklist_status: state.checklist!.status,
          },
        ];
      }
      if (sql.includes('FROM platform.crm_onboarding_checklists WHERE account_id')) {
        return state.checklist ? [state.checklist] : [];
      }
      if (
        sql.includes('FROM platform.crm_onboarding_tasks WHERE checklist_id') &&
        sql.includes('ORDER BY sort_order')
      ) {
        return state.tasks.map((t) => ({
          id: t.id,
          task_name: t.task_name,
          task_category: t.task_category,
          sort_order: t.sort_order,
          status: t.status,
          completed_at: t.completed_at,
          completed_by: t.completed_by,
        }));
      }
      return [];
    },
    $executeRawUnsafe: async () => 1,
    $transaction: async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
          // Re-open + complete patches
          if (sql.includes("SET status = 'PENDING'")) {
            const id = params[0] as string;
            const t = state.tasks.find((x) => x.id === id);
            if (t) {
              t.status = 'PENDING';
              t.completed_at = null;
              t.completed_by = null;
            }
          } else if (
            sql.includes('UPDATE platform.crm_onboarding_tasks') &&
            sql.includes('SET status = $1')
          ) {
            const newStatus = params[0] as TaskRow['status'];
            const by = params[1] as string;
            const id = params[2] as string;
            const t = state.tasks.find((x) => x.id === id);
            if (t) {
              t.status = newStatus;
              t.completed_at = new Date();
              t.completed_by = by;
            }
          } else if (
            sql.includes('UPDATE platform.crm_onboarding_checklists') &&
            sql.includes("'IN_PROGRESS'") &&
            sql.includes('started_at = now')
          ) {
            state.checklist!.status = 'IN_PROGRESS';
            state.checklist!.started_at = new Date();
          } else if (sql.includes("'COMPLETED'") && sql.includes('completed_at = now')) {
            state.checklist!.status = 'COMPLETED';
            state.checklist!.completed_at = new Date();
          } else if (
            sql.includes("status = 'IN_PROGRESS'") &&
            sql.includes('completed_at = NULL')
          ) {
            state.checklist!.status = 'IN_PROGRESS';
            state.checklist!.completed_at = null;
          }
          return 1;
        },
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes("COUNT(*) FILTER (WHERE status = 'PENDING')")) {
            const total = state.tasks.length;
            const pending = state.tasks.filter((t) => t.status === 'PENDING').length;
            return [{ total, pending }];
          }
          return [];
        },
      };
      return cb(tx);
    },
  };

  const accountService = {
    loadOrFail: async (id: string) => ({
      id,
      status: 'ONBOARDING',
      school_id: '019dff45-1234-7000-8000-000000000001',
    }),
    autoFlipOnOnboardingComplete: async (accountId: string) => {
      state.accountAutoFlipCalls.push(accountId);
    },
  } as unknown as AccountService;

  return { state, prisma, accountService };
}

describe('OnboardingService.patchTask — auto-flip keystone', () => {
  let stubs: ReturnType<typeof buildStubs>;
  beforeEach(() => {
    stubs = buildStubs({
      checklistStatus: 'IN_PROGRESS',
      tasks: [
        {
          id: 't1',
          task_name: 'a',
          task_category: 'TECHNICAL',
          sort_order: 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          completed_by: 'u',
        },
        {
          id: 't2',
          task_name: 'b',
          task_category: 'CONFIGURATION',
          sort_order: 1,
          status: 'PENDING',
          completed_at: null,
          completed_by: null,
        },
      ],
    });
  });

  it('completing the last PENDING task triggers AccountService.autoFlipOnOnboardingComplete', async () => {
    const svc = new OnboardingService(stubs.prisma, stubs.accountService);
    await svc.patchTask('t2', 'actor-1', { status: 'COMPLETED' });
    expect(stubs.state.accountAutoFlipCalls).toEqual(['acct-1']);
    expect(stubs.state.checklist!.status).toBe('COMPLETED');
  });

  it('completing a non-last task does NOT trigger auto-flip', async () => {
    const stubs2 = buildStubs({
      checklistStatus: 'IN_PROGRESS',
      tasks: [
        {
          id: 't1',
          task_name: 'a',
          task_category: 'TECHNICAL',
          sort_order: 0,
          status: 'PENDING',
          completed_at: null,
          completed_by: null,
        },
        {
          id: 't2',
          task_name: 'b',
          task_category: 'CONFIGURATION',
          sort_order: 1,
          status: 'PENDING',
          completed_at: null,
          completed_by: null,
        },
      ],
    });
    const svc = new OnboardingService(stubs2.prisma, stubs2.accountService);
    await svc.patchTask('t1', 'actor-1', { status: 'COMPLETED' });
    expect(stubs2.state.accountAutoFlipCalls).toEqual([]);
    expect(stubs2.state.checklist!.status).toBe('IN_PROGRESS');
  });

  it('SKIPPED counts as terminal for the auto-flip', async () => {
    const stubs3 = buildStubs({
      checklistStatus: 'IN_PROGRESS',
      tasks: [
        {
          id: 't1',
          task_name: 'a',
          task_category: 'TECHNICAL',
          sort_order: 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          completed_by: 'u',
        },
        {
          id: 't2',
          task_name: 'b',
          task_category: 'CONFIGURATION',
          sort_order: 1,
          status: 'PENDING',
          completed_at: null,
          completed_by: null,
        },
      ],
    });
    const svc = new OnboardingService(stubs3.prisma, stubs3.accountService);
    await svc.patchTask('t2', 'actor-1', { status: 'SKIPPED' });
    expect(stubs3.state.accountAutoFlipCalls).toEqual(['acct-1']);
  });

  it('re-opening a task on a COMPLETED checklist clears the completion', async () => {
    const stubs4 = buildStubs({
      checklistStatus: 'COMPLETED',
      tasks: [
        {
          id: 't1',
          task_name: 'a',
          task_category: 'TECHNICAL',
          sort_order: 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          completed_by: 'u',
        },
      ],
    });
    const svc = new OnboardingService(stubs4.prisma, stubs4.accountService);
    await svc.patchTask('t1', 'actor-1', { status: 'PENDING' });
    expect(stubs4.state.checklist!.status).toBe('IN_PROGRESS');
    expect(stubs4.state.checklist!.completed_at).toBeNull();
    expect(stubs4.state.accountAutoFlipCalls).toEqual([]);
  });

  it('throws NotFoundException for unknown task id', async () => {
    const stubsA = buildStubs({ checklistStatus: 'IN_PROGRESS', tasks: [] });
    const svc = new OnboardingService(stubsA.prisma, stubsA.accountService);
    await expect(svc.patchTask('ghost', 'actor-1', { status: 'COMPLETED' })).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('OnboardingService.init — defaults + double-init guard', () => {
  it('rejects when a checklist already exists for the account', async () => {
    const prisma = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM platform.crm_onboarding_checklists')) {
          return [{ id: 'cl-existing' }];
        }
        return [];
      },
      $executeRawUnsafe: async () => 1,
      $transaction: async (cb: any) => cb({ $executeRawUnsafe: async () => 1 }),
    };
    const accountService = {
      loadOrFail: async () => ({ id: 'acct-1', status: 'PROSPECT' }),
    } as unknown as AccountService;
    const svc = new OnboardingService(prisma as any, accountService);
    await expect(svc.init('acct-1', {})).rejects.toThrow(ConflictException);
  });
});
