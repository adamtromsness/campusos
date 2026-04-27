'use client';

import { FormEvent, useEffect, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useAssignmentTypes, useCategories } from '@/hooks/use-classroom';
import type { AssignmentDto, CreateAssignmentPayload } from '@/lib/types';

export interface AssignmentFormValues {
  title: string;
  instructions: string;
  assignmentTypeId: string;
  categoryId: string;       // '' = no category
  dueDate: string;          // datetime-local string ('' = no deadline)
  maxPoints: string;        // string for the input — coerced on submit
  isExtraCredit: boolean;
  isPublished: boolean;
}

interface AssignmentFormProps {
  classId: string;
  initial?: AssignmentDto | null;
  submitting: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (payload: CreateAssignmentPayload) => Promise<void> | void;
  /** Inline error from the server (e.g. 400 "weights must sum to 100"). */
  serverError?: string | null;
}

export function AssignmentForm({
  classId,
  initial,
  submitting,
  submitLabel,
  onCancel,
  onSubmit,
  serverError,
}: AssignmentFormProps) {
  const typesQuery = useAssignmentTypes();
  const categoriesQuery = useCategories(classId);

  const [values, setValues] = useState<AssignmentFormValues>(() => deriveInitial(initial));
  const [localError, setLocalError] = useState<string | null>(null);

  // Re-seed the form when the initial assignment changes (edit mode loading async).
  useEffect(() => {
    setValues(deriveInitial(initial));
    setLocalError(null);
  }, [initial?.id]);

  function update<K extends keyof AssignmentFormValues>(key: K, value: AssignmentFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (values.title.trim().length === 0) {
      setLocalError('Title is required.');
      return;
    }
    if (!values.assignmentTypeId) {
      setLocalError('Pick an assignment type.');
      return;
    }
    const maxPointsNum = Number(values.maxPoints);
    if (!Number.isFinite(maxPointsNum) || maxPointsNum <= 0) {
      setLocalError('Max points must be greater than zero.');
      return;
    }

    const payload: CreateAssignmentPayload = {
      title: values.title.trim(),
      assignmentTypeId: values.assignmentTypeId,
      maxPoints: maxPointsNum,
      isExtraCredit: values.isExtraCredit,
      isPublished: values.isPublished,
    };
    if (values.instructions.trim().length > 0) payload.instructions = values.instructions.trim();
    if (values.categoryId) payload.categoryId = values.categoryId;
    if (values.dueDate) {
      // datetime-local has no timezone; treat as local and serialise to ISO.
      const d = new Date(values.dueDate);
      if (!Number.isNaN(d.getTime())) payload.dueDate = d.toISOString();
    }

    await onSubmit(payload);
  }

  const types = typesQuery.data ?? [];
  const categories = categoriesQuery.data ?? [];

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-card border border-gray-200 bg-white p-5 shadow-card">
      <Field label="Title" required>
        <input
          type="text"
          value={values.title}
          onChange={(e) => update('title', e.target.value)}
          maxLength={200}
          required
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
        />
      </Field>

      <Field label="Instructions" hint="Plain text shown to students.">
        <textarea
          value={values.instructions}
          onChange={(e) => update('instructions', e.target.value)}
          rows={4}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" required>
          <select
            value={values.assignmentTypeId}
            onChange={(e) => update('assignmentTypeId', e.target.value)}
            required
            disabled={typesQuery.isLoading}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none disabled:bg-gray-50"
          >
            <option value="">— Select a type —</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Category"
          hint={
            categories.length === 0
              ? 'No categories yet — manage them from the assignments list.'
              : 'Drives the weighted average.'
          }
        >
          <select
            value={values.categoryId}
            onChange={(e) => update('categoryId', e.target.value)}
            disabled={categoriesQuery.isLoading || categories.length === 0}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none disabled:bg-gray-50"
          >
            <option value="">— Uncategorised —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.weight}%)
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Due date">
          <input
            type="datetime-local"
            value={values.dueDate}
            onChange={(e) => update('dueDate', e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
          />
        </Field>
        <Field label="Max points" required>
          <input
            type="number"
            value={values.maxPoints}
            onChange={(e) => update('maxPoints', e.target.value)}
            min={0.01}
            step={0.01}
            required
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-4">
        <CheckboxRow
          label="Extra credit"
          hint="Excluded from the gradebook denominator."
          checked={values.isExtraCredit}
          onChange={(v) => update('isExtraCredit', v)}
        />
        <CheckboxRow
          label="Published"
          hint="Visible to students and parents."
          checked={values.isPublished}
          onChange={(v) => update('isPublished', v)}
        />
      </div>

      {(localError || serverError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {localError || serverError}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting && <LoadingSpinner size="sm" className="border-white/40 border-t-white" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
        {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

function CheckboxRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="inline-flex items-start gap-2 text-sm text-gray-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-campus-600 focus:ring-campus-400"
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="ml-1 text-xs text-gray-400">({hint})</span>}
      </span>
    </label>
  );
}

function deriveInitial(initial: AssignmentDto | null | undefined): AssignmentFormValues {
  if (!initial) {
    return {
      title: '',
      instructions: '',
      assignmentTypeId: '',
      categoryId: '',
      dueDate: '',
      maxPoints: '100',
      isExtraCredit: false,
      isPublished: true,
    };
  }
  return {
    title: initial.title,
    instructions: initial.instructions ?? '',
    assignmentTypeId: initial.assignmentType.id,
    categoryId: initial.category?.id ?? '',
    dueDate: toLocalInputValue(initial.dueDate),
    maxPoints: String(initial.maxPoints),
    isExtraCredit: initial.isExtraCredit,
    isPublished: initial.isPublished,
  };
}

/** Convert ISO timestamp → datetime-local input value (local clock, no zone). */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}
