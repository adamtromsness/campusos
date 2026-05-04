'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCreateDisciplineActionType,
  useCreateDisciplineCategory,
  useDisciplineActionTypes,
  useDisciplineCategories,
  useUpdateDisciplineActionType,
  useUpdateDisciplineCategory,
} from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { SEVERITIES, SEVERITY_LABELS, SEVERITY_PILL } from '@/lib/discipline-format';
import type { DisciplineActionTypeDto, DisciplineCategoryDto, Severity } from '@/lib/types';

export default function BehaviourCatalogueAdminPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['beh-001:admin', 'sch-001:admin']);

  const categories = useDisciplineCategories(isAdmin, /* includeInactive */ true);
  const actionTypes = useDisciplineActionTypes(isAdmin, /* includeInactive */ true);

  const [categoryModal, setCategoryModal] = useState<{
    open: boolean;
    edit: DisciplineCategoryDto | null;
  }>({ open: false, edit: null });
  const [actionTypeModal, setActionTypeModal] = useState<{
    open: boolean;
    edit: DisciplineActionTypeDto | null;
  }>({ open: false, edit: null });

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Catalogue management" />
        <EmptyState
          title="Admin only"
          description="Only school admins can manage the behaviour catalogue."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Behaviour catalogue"
        description="Manage discipline categories and disciplinary action types."
        actions={
          <Link href="/behaviour" className="text-sm text-gray-500 hover:text-gray-700">
            ← Queue
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900">Categories</h3>
            <button
              type="button"
              onClick={() => setCategoryModal({ open: true, edit: null })}
              className="rounded-lg bg-campus-700 px-3 py-1 text-sm font-medium text-white hover:bg-campus-800"
            >
              Add category
            </button>
          </div>
          {categories.isLoading ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : (categories.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No categories yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {(categories.data ?? []).map((c) => (
                <li
                  key={c.id}
                  className={cn(
                    'flex items-center justify-between rounded-lg border border-gray-200 p-3',
                    c.isActive ? 'bg-white' : 'bg-gray-50',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">{c.name}</span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          SEVERITY_PILL[c.severity],
                        )}
                      >
                        {SEVERITY_LABELS[c.severity]}
                      </span>
                      {!c.isActive && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                          Inactive
                        </span>
                      )}
                    </div>
                    {c.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{c.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setCategoryModal({ open: true, edit: c })}
                    className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Edit
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900">Action types</h3>
            <button
              type="button"
              onClick={() => setActionTypeModal({ open: true, edit: null })}
              className="rounded-lg bg-campus-700 px-3 py-1 text-sm font-medium text-white hover:bg-campus-800"
            >
              Add action type
            </button>
          </div>
          {actionTypes.isLoading ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : (actionTypes.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No action types yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {(actionTypes.data ?? []).map((t) => (
                <li
                  key={t.id}
                  className={cn(
                    'flex items-center justify-between rounded-lg border border-gray-200 p-3',
                    t.isActive ? 'bg-white' : 'bg-gray-50',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">{t.name}</span>
                      {t.requiresParentNotification && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
                          Notifies parent
                        </span>
                      )}
                      {!t.isActive && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                          Inactive
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{t.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setActionTypeModal({ open: true, edit: t })}
                    className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Edit
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {categoryModal.open && (
        <CategoryModal
          edit={categoryModal.edit}
          onClose={() => setCategoryModal({ open: false, edit: null })}
        />
      )}
      {actionTypeModal.open && (
        <ActionTypeModal
          edit={actionTypeModal.edit}
          onClose={() => setActionTypeModal({ open: false, edit: null })}
        />
      )}
    </div>
  );
}

function CategoryModal({
  edit,
  onClose,
}: {
  edit: DisciplineCategoryDto | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateDisciplineCategory();
  const update = useUpdateDisciplineCategory(edit?.id ?? '');

  const [name, setName] = useState(edit?.name ?? '');
  const [severity, setSeverity] = useState<Severity>(edit?.severity ?? 'MEDIUM');
  const [description, setDescription] = useState(edit?.description ?? '');
  const [isActive, setIsActive] = useState(edit?.isActive ?? true);

  const submitting = edit ? update.isPending : create.isPending;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      toast('Name is required', 'error');
      return;
    }
    try {
      if (edit) {
        await update.mutateAsync({
          name: name.trim(),
          severity,
          description: description.trim() || null,
          isActive,
        });
        toast('Category updated', 'success');
      } else {
        await create.mutateAsync({
          name: name.trim(),
          severity,
          description: description.trim() || null,
        });
        toast('Category created', 'success');
      }
      onClose();
    } catch (err: any) {
      toast('Could not save: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={edit ? 'Edit category' : 'Add category'}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="category-form"
            disabled={submitting}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="category-form" onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">Severity</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Description <span className="text-gray-400">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
        {edit && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-gray-300 text-campus-700 focus:ring-campus-500"
            />
            Active
          </label>
        )}
      </form>
    </Modal>
  );
}

function ActionTypeModal({
  edit,
  onClose,
}: {
  edit: DisciplineActionTypeDto | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateDisciplineActionType();
  const update = useUpdateDisciplineActionType(edit?.id ?? '');

  const [name, setName] = useState(edit?.name ?? '');
  const [requiresParentNotification, setRequiresParentNotification] = useState(
    edit?.requiresParentNotification ?? false,
  );
  const [description, setDescription] = useState(edit?.description ?? '');
  const [isActive, setIsActive] = useState(edit?.isActive ?? true);

  const submitting = edit ? update.isPending : create.isPending;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      toast('Name is required', 'error');
      return;
    }
    try {
      if (edit) {
        await update.mutateAsync({
          name: name.trim(),
          requiresParentNotification,
          description: description.trim() || null,
          isActive,
        });
        toast('Action type updated', 'success');
      } else {
        await create.mutateAsync({
          name: name.trim(),
          requiresParentNotification,
          description: description.trim() || null,
        });
        toast('Action type created', 'success');
      }
      onClose();
    } catch (err: any) {
      toast('Could not save: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={edit ? 'Edit action type' : 'Add action type'}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="action-type-form"
            disabled={submitting}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="action-type-form" onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={requiresParentNotification}
            onChange={(e) => setRequiresParentNotification(e.target.checked)}
            className="rounded border-gray-300 text-campus-700 focus:ring-campus-500"
          />
          Notify parent when this action is assigned
        </label>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Description <span className="text-gray-400">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
        {edit && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-gray-300 text-campus-700 focus:ring-campus-500"
            />
            Active
          </label>
        )}
      </form>
    </Modal>
  );
}
