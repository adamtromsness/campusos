'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import { useTaskTemplates, useUpsertTaskTemplate } from '@/hooks/use-enrolment-advanced';
import { TASK_CATEGORIES, TASK_CATEGORY_LABEL } from '@/lib/enrolment-advanced-format';
import type { ExitTaskCategory, TaskTemplateRowPayload } from '@/lib/types';

export default function ExitTaskTemplatePage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['stu-004:admin', 'sch-001:admin']);
  const tpl = useTaskTemplates();
  const upsert = useUpsertTaskTemplate();
  const { toast } = useToast();
  const [draft, setDraft] = useState<TaskTemplateRowPayload[]>([]);

  useEffect(() => {
    if (tpl.data) {
      setDraft(
        tpl.data.map((r) => ({
          taskName: r.taskName,
          taskCategory: r.taskCategory,
          isRequired: r.isRequired,
        })),
      );
    }
  }, [tpl.data]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Exit task template</h1>
        <p className="mt-2 text-slate-600">Template management is admin-only.</p>
      </div>
    );
  }

  const save = async () => {
    if (draft.some((d) => !d.taskName.trim())) {
      toast('Every task needs a name', 'error');
      return;
    }
    try {
      await upsert.mutateAsync({ tasks: draft });
      toast('Template saved');
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Exit task template</h1>
          <p className="text-sm text-slate-500">
            Configure the per-school checklist used by WithdrawalService.create.
          </p>
        </div>
        <Link className="text-sm text-sky-700 hover:underline" href="/enrolment/withdrawals">
          ← Back to withdrawals
        </Link>
      </div>

      <table className="min-w-full text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th className="py-2">Order</th>
            <th>Task</th>
            <th>Department</th>
            <th>Required</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {draft.map((row, idx) => (
            <tr key={idx}>
              <td className="py-2">{idx + 1}</td>
              <td>
                <input
                  className="w-full rounded border border-slate-300 px-2 py-1"
                  value={row.taskName}
                  onChange={(e) =>
                    setDraft((arr) =>
                      arr.map((r, i) => (i === idx ? { ...r, taskName: e.target.value } : r)),
                    )
                  }
                />
              </td>
              <td>
                <select
                  className="rounded border border-slate-300 px-2 py-1"
                  value={row.taskCategory}
                  onChange={(e) =>
                    setDraft((arr) =>
                      arr.map((r, i) =>
                        i === idx ? { ...r, taskCategory: e.target.value as ExitTaskCategory } : r,
                      ),
                    )
                  }
                >
                  {TASK_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {TASK_CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={row.isRequired ?? true}
                  onChange={(e) =>
                    setDraft((arr) =>
                      arr.map((r, i) => (i === idx ? { ...r, isRequired: e.target.checked } : r)),
                    )
                  }
                />
              </td>
              <td className="text-right text-xs">
                <button
                  className="text-rose-700 hover:underline"
                  onClick={() => setDraft((arr) => arr.filter((_, i) => i !== idx))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-between pt-2">
        <button
          className="text-sm text-sky-700 hover:underline"
          onClick={() =>
            setDraft((arr) => [
              ...arr,
              { taskName: '', taskCategory: 'ADMINISTRATIVE', isRequired: true },
            ])
          }
        >
          + Add task
        </button>
        <button
          className="rounded bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          onClick={save}
          disabled={upsert.isPending}
        >
          {upsert.isPending ? 'Saving…' : 'Save template'}
        </button>
      </div>
    </div>
  );
}
