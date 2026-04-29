'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAcademicYears } from '@/hooks/use-enrollment';
import { useFamilyAccounts } from '@/hooks/use-billing';
import {
  useCreateFeeCategory,
  useCreateFeeSchedule,
  useFeeCategories,
  useFeeSchedules,
  useUpdateFeeSchedule,
} from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  RECURRENCE_LABELS,
  RECURRENCE_OPTIONS,
  formatCurrency,
} from '@/lib/billing-format';
import type {
  FeeCategoryDto,
  FeeScheduleDto,
  FamilyAccountDto,
  Recurrence,
} from '@/lib/types';

export default function BillingFeesPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const isWriter = !!user && hasAnyPermission(user, ['fin-001:write']);
  const categories = useFeeCategories(!!user);
  const schedules = useFeeSchedules(!!user);
  const accounts = useFamilyAccounts(!!user);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [showNewSchedule, setShowNewSchedule] = useState(false);
  const [editScheduleId, setEditScheduleId] = useState<string | null>(null);

  if (!user) return null;
  if (!isWriter) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing — Fees" description="Billing access required." />
        <EmptyState
          title="Access required"
          description="Ask a school admin for the Billing app."
        />
      </div>
    );
  }

  const editSchedule = (schedules.data ?? []).find((s) => s.id === editScheduleId) ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Fees"
        description="Fee categories and per-grade fee schedules."
        actions={
          isAdmin && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowNewCategory(true)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
              >
                New category
              </button>
              <button
                type="button"
                onClick={() => setShowNewSchedule(true)}
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
              >
                New schedule
              </button>
            </div>
          )
        }
      />

      <BillingTabs active="fees" />

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Fee categories
        </h2>
        <div className="mt-3">
          {categories.isLoading ? (
            <LoadingSpinner />
          ) : (categories.data ?? []).length === 0 ? (
            <EmptyState
              title="No fee categories yet"
              description="Categories group fee schedules (e.g. Tuition, Registration)."
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(categories.data ?? []).map((c) => (
                <CategoryCard key={c.id} category={c} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Fee schedules
        </h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {schedules.isLoading ? (
            <div className="py-12 text-center">
              <LoadingSpinner />
            </div>
          ) : (schedules.data ?? []).length === 0 ? (
            <div className="py-12">
              <EmptyState
                title="No fee schedules yet"
                description="A schedule binds an amount + recurrence to a fee category and academic year."
              />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Schedule</th>
                  <th className="px-4 py-2">Category</th>
                  <th className="px-4 py-2">Year</th>
                  <th className="px-4 py-2">Grade</th>
                  <th className="px-4 py-2">Amount</th>
                  <th className="px-4 py-2">Recurrence</th>
                  <th className="px-4 py-2">Affected families</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(schedules.data ?? []).map((s) => (
                  <ScheduleRow
                    key={s.id}
                    schedule={s}
                    accounts={accounts.data ?? []}
                    isAdmin={isAdmin}
                    onEdit={() => setEditScheduleId(s.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {showNewCategory && <CategoryModal onClose={() => setShowNewCategory(false)} />}
      {showNewSchedule && (
        <ScheduleModal
          onClose={() => setShowNewSchedule(false)}
          categories={categories.data ?? []}
        />
      )}
      {editSchedule && (
        <EditScheduleModal
          schedule={editSchedule}
          onClose={() => setEditScheduleId(null)}
        />
      )}
    </div>
  );
}

function BillingTabs({ active }: { active: 'accounts' | 'invoices' | 'payments' | 'fees' }) {
  const items: { key: typeof active; label: string; href: string }[] = [
    { key: 'accounts', label: 'Accounts', href: '/billing/accounts' },
    { key: 'invoices', label: 'Invoices', href: '/billing/invoices' },
    { key: 'payments', label: 'Payments', href: '/billing/payments' },
    { key: 'fees', label: 'Fees', href: '/billing/fees' },
  ];
  return (
    <nav className="mt-2 flex gap-3 text-sm">
      {items.map((it, i) => (
        <span key={it.key} className="flex items-center gap-3">
          {it.key === active ? (
            <span className="font-medium text-campus-700">{it.label}</span>
          ) : (
            <Link href={it.href} className="text-gray-500 hover:text-campus-700">
              {it.label}
            </Link>
          )}
          {i < items.length - 1 && <span className="text-gray-300">·</span>}
        </span>
      ))}
    </nav>
  );
}

function CategoryCard({ category }: { category: FeeCategoryDto }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">{category.name}</p>
        {!category.isActive && (
          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            Inactive
          </span>
        )}
      </div>
      {category.description && (
        <p className="mt-1 line-clamp-2 text-xs text-gray-500">{category.description}</p>
      )}
    </li>
  );
}

function ScheduleRow({
  schedule,
  accounts,
  isAdmin,
  onEdit,
}: {
  schedule: FeeScheduleDto;
  accounts: FamilyAccountDto[];
  isAdmin: boolean;
  onEdit: () => void;
}) {
  // Affected = number of family accounts whose linked students match the
  // schedule's grade_level (or all active accounts if grade_level is NULL).
  const affected = useMemo(() => {
    let total = 0;
    for (const acc of accounts) {
      if (acc.status !== 'ACTIVE') continue;
      if (!schedule.gradeLevel) {
        total += 1;
        continue;
      }
      if (acc.students.some((s) => s.gradeLevel === schedule.gradeLevel)) total += 1;
    }
    return total;
  }, [accounts, schedule.gradeLevel]);

  return (
    <tr>
      <td className="px-4 py-2 font-medium text-gray-900">
        {schedule.name}
        {!schedule.isActive && (
          <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            inactive
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-gray-600">{schedule.feeCategoryName}</td>
      <td className="px-4 py-2 text-gray-600">{schedule.academicYearName}</td>
      <td className="px-4 py-2 text-gray-600">
        {schedule.gradeLevel ? `Grade ${schedule.gradeLevel}` : 'All grades'}
      </td>
      <td className="px-4 py-2 font-semibold text-gray-900">{formatCurrency(schedule.amount)}</td>
      <td className="px-4 py-2 text-gray-600">{RECURRENCE_LABELS[schedule.recurrence]}</td>
      <td className="px-4 py-2 text-gray-600">{affected}</td>
      <td className="px-4 py-2 text-right">
        {isAdmin && (
          <button
            type="button"
            onClick={onEdit}
            className="text-xs font-medium text-campus-700 hover:text-campus-900"
          >
            Edit
          </button>
        )}
      </td>
    </tr>
  );
}

function CategoryModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateFeeCategory();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  async function onSubmit() {
    if (!name.trim()) {
      toast('Name is required', 'error');
      return;
    }
    try {
      await create.mutateAsync({ name: name.trim(), description: description || undefined });
      toast('Category created', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not create category', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New fee category"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={create.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Tuition"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
      </div>
    </Modal>
  );
}

function ScheduleModal({
  onClose,
  categories,
}: {
  onClose: () => void;
  categories: FeeCategoryDto[];
}) {
  const { toast } = useToast();
  const years = useAcademicYears();
  const create = useCreateFeeSchedule();
  const activeCategories = useMemo(() => categories.filter((c) => c.isActive), [categories]);
  const [academicYearId, setAcademicYearId] = useState('');
  const [feeCategoryId, setFeeCategoryId] = useState('');
  const [name, setName] = useState('');
  const [gradeLevel, setGradeLevel] = useState('');
  const [amount, setAmount] = useState('');
  const [recurrence, setRecurrence] = useState<Recurrence>('ANNUAL');

  async function onSubmit() {
    if (!academicYearId || !feeCategoryId || !name.trim() || !amount) {
      toast('Fill all required fields', 'error');
      return;
    }
    const amt = Number(amount);
    if (Number.isNaN(amt) || amt < 0) {
      toast('Amount must be a non-negative number', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        academicYearId,
        feeCategoryId,
        name: name.trim(),
        gradeLevel: gradeLevel.trim() || null,
        amount: amt,
        recurrence,
        isRecurring: recurrence !== 'ONE_TIME',
      });
      toast('Fee schedule created', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not create schedule', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New fee schedule"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={create.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Academic year" required>
          <select
            value={academicYearId}
            onChange={(e) => setAcademicYearId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="">Select…</option>
            {(years.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
                {y.isCurrent ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category" required>
          <select
            value={feeCategoryId}
            onChange={(e) => setFeeCategoryId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="">Select…</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Schedule name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="e.g. Grade 9 Annual Tuition"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Grade (blank for all grades)">
          <input
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            maxLength={8}
            placeholder="9"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Amount (USD)" required>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min={0}
            step="0.01"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Recurrence" required>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as Recurrence)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            {RECURRENCE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {RECURRENCE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function EditScheduleModal({
  schedule,
  onClose,
}: {
  schedule: FeeScheduleDto;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateFeeSchedule(schedule.id);
  const [name, setName] = useState(schedule.name);
  const [gradeLevel, setGradeLevel] = useState(schedule.gradeLevel ?? '');
  const [amount, setAmount] = useState(String(schedule.amount));
  const [recurrence, setRecurrence] = useState<Recurrence>(schedule.recurrence);
  const [isActive, setIsActive] = useState(schedule.isActive);

  async function onSubmit() {
    const amt = Number(amount);
    if (Number.isNaN(amt) || amt < 0) {
      toast('Amount must be a non-negative number', 'error');
      return;
    }
    try {
      await update.mutateAsync({
        name: name.trim(),
        gradeLevel: gradeLevel.trim() || null,
        amount: amt,
        recurrence,
        isActive,
      });
      toast('Schedule updated', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not update schedule', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${schedule.name}`}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={update.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={update.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Schedule name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Grade (blank for all grades)">
          <input
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            maxLength={8}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Amount (USD)" required>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min={0}
            step="0.01"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Recurrence" required>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as Recurrence)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            {RECURRENCE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {RECURRENCE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700 sm:col-span-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
          />
          Active — uncheck to hide from invoice generation without deleting historical attribution.
        </label>
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
