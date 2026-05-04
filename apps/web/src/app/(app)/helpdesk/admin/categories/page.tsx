'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useEmployees } from '@/hooks/use-hr';
import {
  useCreateTicketCategory,
  useCreateTicketSubcategory,
  useTicketCategories,
  useUpdateTicketCategory,
  useUpdateTicketSubcategory,
} from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { TicketCategoryDto, TicketSubcategoryDto } from '@/lib/types';

export default function HelpdeskCategoriesPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['it-001:admin', 'sch-001:admin']);
  const cats = useTicketCategories(isAdmin, true);

  const [editCategory, setEditCategory] = useState<TicketCategoryDto | null>(null);
  const [createCategory, setCreateCategory] = useState<boolean>(false);
  const [editSub, setEditSub] = useState<{ sub: TicketSubcategoryDto; categoryId: string } | null>(null);
  const [createSubFor, setCreateSubFor] = useState<TicketCategoryDto | null>(null);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Helpdesk categories" />
        <EmptyState
          title="Admin only"
          description="The category tree editor is visible to school administrators only."
        />
      </div>
    );
  }

  const tree = (cats.data ?? []).filter((c) => c.parentCategoryId === null);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Categories"
        description="Top-level categories + subcategories. Auto-assignment hints live on subcategories."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/helpdesk/admin" className="text-sm text-campus-700 hover:underline">
              ← Back to queue
            </Link>
            <button
              type="button"
              onClick={() => setCreateCategory(true)}
              className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
            >
              New category
            </button>
          </div>
        }
      />

      {cats.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : tree.length === 0 ? (
        <EmptyState title="No categories yet" description="Add a top-level category to start the tree." />
      ) : (
        <div className="space-y-3">
          {tree.map((cat) => (
            <CategoryCard
              key={cat.id}
              cat={cat}
              onEdit={() => setEditCategory(cat)}
              onAddSub={() => setCreateSubFor(cat)}
              onEditSub={(sub) => setEditSub({ sub, categoryId: cat.id })}
            />
          ))}
        </div>
      )}

      {createCategory && (
        <CategoryModal mode="create" onClose={() => setCreateCategory(false)} />
      )}
      {editCategory && (
        <CategoryModal mode="edit" category={editCategory} onClose={() => setEditCategory(null)} />
      )}
      {createSubFor && (
        <SubcategoryModal
          mode="create"
          categoryId={createSubFor.id}
          categoryName={createSubFor.name}
          onClose={() => setCreateSubFor(null)}
        />
      )}
      {editSub && (
        <SubcategoryModal
          mode="edit"
          subcategory={editSub.sub}
          categoryId={editSub.categoryId}
          onClose={() => setEditSub(null)}
        />
      )}
    </div>
  );
}

function CategoryCard({
  cat,
  onEdit,
  onAddSub,
  onEditSub,
}: {
  cat: TicketCategoryDto;
  onEdit: () => void;
  onAddSub: () => void;
  onEditSub: (sub: TicketSubcategoryDto) => void;
}) {
  return (
    <div className={cn('rounded-lg border border-gray-200 bg-white', !cat.isActive && 'opacity-60')}>
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900">{cat.name}</span>
            {!cat.isActive && (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                Inactive
              </span>
            )}
          </div>
          {cat.icon && <p className="mt-0.5 text-xs text-gray-500">icon: {cat.icon}</p>}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onAddSub}
            className="rounded-md bg-white px-3 py-1 text-xs font-medium text-campus-700 ring-1 ring-campus-200 hover:bg-campus-50"
          >
            Add subcategory
          </button>
        </div>
      </div>

      {cat.subcategories.length === 0 ? (
        <p className="px-4 py-3 text-sm text-gray-500">No subcategories yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {cat.subcategories.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-4 py-2">
              <div className="text-sm">
                <span className={cn('font-medium', !s.isActive && 'text-gray-400 line-through')}>
                  {s.name}
                </span>
                <div className="mt-0.5 text-xs text-gray-500">
                  {s.defaultAssigneeName
                    ? 'Auto-assigns to ' + s.defaultAssigneeName
                    : s.autoAssignToRole
                      ? 'Routes to role ' + s.autoAssignToRole
                      : 'Lands in admin queue'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onEditSub(s)}
                className="rounded-md px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CategoryModal({
  mode,
  category,
  onClose,
}: {
  mode: 'create' | 'edit';
  category?: TicketCategoryDto;
  onClose: () => void;
}) {
  const create = useCreateTicketCategory();
  const update = useUpdateTicketCategory(category?.id ?? '');
  const { toast } = useToast();
  const [name, setName] = useState(category?.name ?? '');
  const [icon, setIcon] = useState(category?.icon ?? '');
  const [isActive, setIsActive] = useState(category?.isActive ?? true);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      if (mode === 'create') {
        await create.mutateAsync({ name: name.trim(), icon: icon.trim() || undefined });
        toast('Category created', 'success');
      } else if (category) {
        await update.mutateAsync({
          name: name.trim() !== category.name ? name.trim() : undefined,
          icon: icon !== (category.icon ?? '') ? (icon.trim() || null) : undefined,
          isActive: isActive !== category.isActive ? isActive : undefined,
        });
        toast('Category updated', 'success');
      }
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={mode === 'create' ? 'New category' : 'Edit ' + (category?.name ?? '')}
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Icon (optional)</label>
          <input
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="computer / wrench / people"
            maxLength={60}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        {mode === 'edit' && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-gray-300 text-campus-600 focus:ring-campus-300"
            />
            Active (uncheck to soft-deactivate without affecting historical tickets)
          </label>
        )}
        <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending || update.isPending}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SubcategoryModal({
  mode,
  categoryId,
  categoryName,
  subcategory,
  onClose,
}: {
  mode: 'create' | 'edit';
  categoryId: string;
  categoryName?: string;
  subcategory?: TicketSubcategoryDto;
  onClose: () => void;
}) {
  const employees = useEmployees({});
  const create = useCreateTicketSubcategory();
  const update = useUpdateTicketSubcategory(subcategory?.id ?? '');
  const { toast } = useToast();
  const [name, setName] = useState(subcategory?.name ?? '');
  const [defaultAssigneeId, setDefaultAssigneeId] = useState(subcategory?.defaultAssigneeId ?? '');
  const [autoAssignToRole, setAutoAssignToRole] = useState(subcategory?.autoAssignToRole ?? '');
  const [isActive, setIsActive] = useState(subcategory?.isActive ?? true);

  // Mutual exclusion — picking an employee clears the role and vice-versa.
  function pickEmployee(id: string): void {
    setDefaultAssigneeId(id);
    if (id) setAutoAssignToRole('');
  }
  function pickRole(role: string): void {
    setAutoAssignToRole(role);
    if (role) setDefaultAssigneeId('');
  }

  const employeeList = useMemo(
    () => (employees.data ?? []).filter((e) => e.employmentStatus === 'ACTIVE'),
    [employees.data],
  );

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      if (mode === 'create') {
        await create.mutateAsync({
          categoryId,
          name: name.trim(),
          defaultAssigneeId: defaultAssigneeId || undefined,
          autoAssignToRole: autoAssignToRole.trim().toUpperCase() || undefined,
        });
        toast('Subcategory created', 'success');
      } else if (subcategory) {
        await update.mutateAsync({
          name: name.trim() !== subcategory.name ? name.trim() : undefined,
          defaultAssigneeId:
            defaultAssigneeId !== (subcategory.defaultAssigneeId ?? '')
              ? defaultAssigneeId || null
              : undefined,
          autoAssignToRole:
            autoAssignToRole.trim().toUpperCase() !== (subcategory.autoAssignToRole ?? '')
              ? autoAssignToRole.trim().toUpperCase() || null
              : undefined,
          isActive: isActive !== subcategory.isActive ? isActive : undefined,
        });
        toast('Subcategory updated', 'success');
      }
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={
        mode === 'create'
          ? 'New subcategory under ' + (categoryName ?? '…')
          : 'Edit ' + (subcategory?.name ?? '')
      }
      size="md"
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Auto-assign to (optional)</label>
          <p className="mb-2 mt-0.5 text-xs text-gray-500">
            Pick an employee OR a role token. Leave both blank to land tickets in the admin queue.
          </p>
          <select
            value={defaultAssigneeId}
            onChange={(e) => pickEmployee(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">— No default employee —</option>
            {employeeList.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.fullName} {emp.primaryPositionTitle ? '· ' + emp.primaryPositionTitle : ''}
              </option>
            ))}
          </select>
          <input
            value={autoAssignToRole}
            onChange={(e) => pickRole(e.target.value.toUpperCase())}
            placeholder="Role token (e.g. SCHOOL_ADMIN)"
            maxLength={60}
            pattern="^[A-Z][A-Z0-9_]*$"
            className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
          />
        </div>
        {mode === 'edit' && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-gray-300 text-campus-600 focus:ring-campus-300"
            />
            Active
          </label>
        )}
        <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending || update.isPending}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
