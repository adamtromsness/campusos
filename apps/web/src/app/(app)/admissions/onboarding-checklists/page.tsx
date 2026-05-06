'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateOnboardingChecklist, useOnboardingChecklists } from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ONBOARDING_ADMISSION_TYPES,
  ONBOARDING_TASK_CATEGORIES,
  type CreateChecklistTaskInput,
  type OnboardingAdmissionType,
  type OnboardingTaskCategory,
} from '@/lib/types';

const ADMISSION_LABEL: Record<OnboardingAdmissionType, string> = {
  STANDARD_INTAKE: 'Standard intake',
  MID_YEAR_ADMISSION: 'Mid-year admission',
  TRANSFER_IN: 'Transfer in',
  RETURNING_STUDENT: 'Returning student',
  INTERNATIONAL: 'International',
};

export default function OnboardingChecklistsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['stu-003:admin']);
  const checklistsQ = useOnboardingChecklists(true, !!user);
  const create = useCreateOnboardingChecklist();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [admissionType, setAdmissionType] = useState<OnboardingAdmissionType>('STANDARD_INTAKE');
  const [tasks, setTasks] = useState<CreateChecklistTaskInput[]>([
    { taskName: '', taskCategory: 'ADMINISTRATIVE', isMandatory: true },
  ]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader
          title="Onboarding checklists"
          description="School admin only — checklist templates drive new-student onboarding."
        />
        <EmptyState title="Admin access required" />
      </div>
    );
  }

  const checklists = checklistsQ.data ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Onboarding checklists"
        description="Per-school templates for new-student onboarding. Each accepted offer auto-generates a per-student progress row from the matching admission_type checklist."
      />
      <div className="mb-4 flex items-center justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-600"
        >
          New checklist
        </button>
      </div>
      {checklistsQ.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : checklists.length === 0 ? (
        <EmptyState
          title="No checklists yet"
          description="Create a checklist to drive auto-generated onboarding when an offer is accepted."
        />
      ) : (
        <ul className="space-y-3">
          {checklists.map((c) => (
            <li key={c.id} className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-900">{c.name}</p>
                  <p className="text-xs text-gray-500">
                    {ADMISSION_LABEL[c.admissionType]} ·{' '}
                    {c.isActive ? (
                      <span className="text-emerald-700">active</span>
                    ) : (
                      <span className="text-gray-500">inactive</span>
                    )}
                  </p>
                </div>
              </div>
              {c.description ? <p className="mt-2 text-gray-700">{c.description}</p> : null}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={open}
        title="New onboarding checklist"
        onClose={() => setOpen(false)}
        size="lg"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={create.isPending || !name.trim() || tasks.every((t) => !t.taskName.trim())}
              className="rounded bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
              onClick={async () => {
                const cleanTasks = tasks
                  .filter((t) => t.taskName.trim())
                  .map((t, i) => ({
                    taskName: t.taskName.trim(),
                    description: t.description?.trim() || undefined,
                    taskCategory: t.taskCategory,
                    responsibleRole: t.responsibleRole?.trim() || undefined,
                    sortOrder: i,
                    dueDaysBeforeStart: t.dueDaysBeforeStart ?? 0,
                    isMandatory: t.isMandatory ?? true,
                  }));
                try {
                  await create.mutateAsync({
                    name: name.trim(),
                    description: description.trim() || undefined,
                    admissionType,
                    tasks: cleanTasks,
                  });
                  toast('Checklist created', 'success');
                  setOpen(false);
                  setName('');
                  setDescription('');
                  setTasks([{ taskName: '', taskCategory: 'ADMINISTRATIVE', isMandatory: true }]);
                } catch (err) {
                  toast((err as { message?: string })?.message ?? 'Failed to create', 'error');
                }
              }}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <div>
            <label htmlFor="cl-name" className="mb-1 block font-medium text-gray-700">
              Name
            </label>
            <input
              id="cl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </div>
          <div>
            <label htmlFor="cl-admission" className="mb-1 block font-medium text-gray-700">
              Admission type
            </label>
            <select
              id="cl-admission"
              value={admissionType}
              onChange={(e) => setAdmissionType(e.target.value as OnboardingAdmissionType)}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
            >
              {ONBOARDING_ADMISSION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ADMISSION_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cl-desc" className="mb-1 block font-medium text-gray-700">
              Description (optional)
            </label>
            <textarea
              id="cl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </div>

          <div>
            <p className="mb-2 font-medium text-gray-700">Tasks</p>
            <ul className="space-y-2">
              {tasks.map((t, i) => (
                <li key={i} className="grid grid-cols-12 gap-2">
                  <input
                    placeholder="Task name"
                    value={t.taskName}
                    onChange={(e) => {
                      const next = [...tasks];
                      next[i] = { ...t, taskName: e.target.value };
                      setTasks(next);
                    }}
                    className="col-span-5 rounded border border-gray-300 px-2 py-1.5"
                  />
                  <select
                    value={t.taskCategory}
                    onChange={(e) => {
                      const next = [...tasks];
                      next[i] = { ...t, taskCategory: e.target.value as OnboardingTaskCategory };
                      setTasks(next);
                    }}
                    className="col-span-3 rounded border border-gray-300 px-2 py-1.5"
                  >
                    {ONBOARDING_TASK_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="Responsible role"
                    value={t.responsibleRole ?? ''}
                    onChange={(e) => {
                      const next = [...tasks];
                      next[i] = { ...t, responsibleRole: e.target.value };
                      setTasks(next);
                    }}
                    className="col-span-3 rounded border border-gray-300 px-2 py-1.5"
                  />
                  <button
                    type="button"
                    onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
                    className="col-span-1 text-xs text-rose-600 hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() =>
                setTasks([
                  ...tasks,
                  { taskName: '', taskCategory: 'ADMINISTRATIVE', isMandatory: true },
                ])
              }
              className="mt-2 text-xs text-campus-700 hover:underline"
            >
              + Add task
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
