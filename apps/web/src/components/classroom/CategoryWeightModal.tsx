'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { cn } from '@/components/ui/cn';
import type { AssignmentCategoryDto, UpsertCategoryEntry } from '@/lib/types';

interface CategoryWeightModalProps {
  open: boolean;
  classId: string;
  categories: AssignmentCategoryDto[];
  loading: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (entries: UpsertCategoryEntry[]) => Promise<void> | void;
}

interface DraftRow {
  key: string;          // stable key for React (existing id, or "new-N")
  name: string;
  weight: string;       // string for the input — coerced on submit
  sortOrder: number;
}

const NEW_ROW_PREFIX = 'new-';

/**
 * Manage per-class category weights. The PUT semantics on the API are
 * "the body is the new full set" — names that disappear are deleted (or
 * 409 if still referenced by an assignment). This modal mirrors that:
 * editing a name renames the category, removing a row queues it for
 * deletion, the running total must hit exactly 100 to enable Submit.
 */
export function CategoryWeightModal({
  open,
  categories,
  loading,
  submitting,
  onCancel,
  onSubmit,
}: CategoryWeightModalProps) {
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newCounter, setNewCounter] = useState(0);

  // Re-seed the draft when the modal opens or the underlying data refreshes.
  useEffect(() => {
    if (!open) return;
    setRows(
      categories
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((c) => ({
          key: c.id,
          name: c.name,
          weight: String(c.weight),
          sortOrder: c.sortOrder,
        })),
    );
    setError(null);
    setNewCounter(0);
  }, [open, categories]);

  const total = rows.reduce((sum, r) => sum + (Number(r.weight) || 0), 0);
  const totalRounded = Math.round(total * 100) / 100;
  const sumIsHundred = totalRounded === 100;
  const namesValid = rows.every((r) => r.name.trim().length > 0);
  const uniqueNames =
    new Set(rows.map((r) => r.name.trim().toLowerCase())).size === rows.length;
  const canSubmit = !submitting && rows.length > 0 && sumIsHundred && namesValid && uniqueNames;

  function addRow() {
    setNewCounter((n) => n + 1);
    setRows((prev) => [
      ...prev,
      {
        key: NEW_ROW_PREFIX + (newCounter + 1),
        name: '',
        weight: '0',
        sortOrder: prev.length + 1,
      },
    ]);
  }

  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateRow(idx: number, patch: Partial<DraftRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function handleSubmit() {
    setError(null);
    if (!canSubmit) {
      if (!sumIsHundred) setError('Weights must sum to exactly 100.');
      else if (!namesValid) setError('Every category needs a name.');
      else if (!uniqueNames) setError('Category names must be unique.');
      return;
    }
    const entries: UpsertCategoryEntry[] = rows.map((r, i) => ({
      name: r.name.trim(),
      weight: Number(r.weight),
      sortOrder: i + 1,
    }));
    try {
      await onSubmit(entries);
    } catch (e) {
      // Caller handles toast — but capture the message inline so the modal
      // shows the API's reason (e.g. 409 "category still referenced").
      const msg = e instanceof Error ? e.message : 'Failed to save weights';
      setError(msg);
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onCancel}
      title="Manage category weights"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <LoadingSpinner size="sm" className="border-white/40 border-t-white" />}
            Save weights
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          Weights are used to compute each student&rsquo;s current average. They must sum to 100%.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <LoadingSpinner size="sm" /> Loading categories…
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r, idx) => (
              <div key={r.key} className="flex items-center gap-2">
                <input
                  type="text"
                  value={r.name}
                  disabled={submitting}
                  onChange={(e) => updateRow(idx, { name: e.target.value })}
                  placeholder="Category name"
                  className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none disabled:bg-gray-50"
                />
                <div className="relative w-28">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step={0.01}
                    value={r.weight}
                    disabled={submitting}
                    onChange={(e) => updateRow(idx, { weight: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 pr-7 text-right text-sm tabular-nums focus:border-campus-400 focus:outline-none disabled:bg-gray-50"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                    %
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  disabled={submitting || rows.length === 1}
                  className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title={rows.length === 1 ? 'At least one category required' : 'Remove'}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addRow}
              disabled={submitting}
              className="text-xs font-medium text-campus-600 hover:text-campus-700 disabled:opacity-60"
            >
              + Add category
            </button>
          </div>
        )}

        <div
          className={cn(
            'flex items-center justify-between rounded-lg border px-3 py-2 text-sm',
            sumIsHundred
              ? 'border-status-present-soft bg-status-present-soft/30 text-status-present-text'
              : 'border-amber-200 bg-amber-50 text-amber-800',
          )}
        >
          <span className="font-medium">Total</span>
          <span className="tabular-nums">
            {totalRounded.toFixed(2)}% {sumIsHundred ? '✓' : `(must equal 100)`}
          </span>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
