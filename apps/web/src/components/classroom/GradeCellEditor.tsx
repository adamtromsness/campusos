'use client';

import { useEffect, useRef, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { cn } from '@/components/ui/cn';

export interface GradeCellState {
  hasGrade: boolean;
  gradeValue: number | null;
  letterGrade: string | null;
  feedback: string | null;
  isPublished: boolean;
  isSubmitted: boolean;       // student has at least submitted
  maxPoints: number;
  isExtraCredit: boolean;
}

interface GradeCellEditorProps {
  state: GradeCellState;
  saving: boolean;
  publishing: boolean;
  /** Save: persists the grade. Pass `null` for gradeValue to keep the existing value. */
  onSave: (gradeValue: number, feedback: string) => Promise<void>;
  onTogglePublish: () => Promise<void>;
  onClose: () => void;
}

/**
 * Inline cell editor — drops down below the gradebook cell.
 * Contains: grade value input (auto-derives letter), feedback textarea,
 * Save / Publish-or-Unpublish / Cancel buttons.
 *
 * Optimistic save: caller mutates the cache so the cell updates immediately;
 * the editor closes after the API resolves.
 */
export function GradeCellEditor({
  state,
  saving,
  publishing,
  onSave,
  onTogglePublish,
  onClose,
}: GradeCellEditorProps) {
  const [value, setValue] = useState<string>(
    state.gradeValue !== null ? String(state.gradeValue) : '',
  );
  const [feedback, setFeedback] = useState<string>(state.feedback ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const numeric = Number(value);
  const isNumber = value !== '' && Number.isFinite(numeric);
  const overMax = isNumber && numeric > state.maxPoints && !state.isExtraCredit;
  const negative = isNumber && numeric < 0;
  const canSave = isNumber && !overMax && !negative && !saving;
  const pct = isNumber && state.maxPoints > 0 ? (numeric / state.maxPoints) * 100 : null;

  return (
    <div
      className="absolute left-0 top-full z-20 mt-1 w-72 rounded-card border border-gray-200 bg-white p-3 shadow-elevated"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1">
          <input
            ref={inputRef}
            type="number"
            min={0}
            step={0.01}
            value={value}
            disabled={saving}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) {
                e.preventDefault();
                void handleSave();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            className={cn(
              'w-20 rounded-lg border px-2 py-1.5 text-right text-sm tabular-nums focus:outline-none',
              overMax || negative
                ? 'border-red-300 focus:border-red-400'
                : 'border-gray-200 focus:border-campus-400',
            )}
          />
          <span className="text-xs text-gray-500">/ {state.maxPoints}</span>
        </div>
        <div className="text-xs text-gray-500 tabular-nums">
          {pct !== null ? pct.toFixed(1) + '%' : '—'}
          {pct !== null && (
            <span className="ml-1 font-semibold text-gray-700">
              {deriveLetter(pct)}
            </span>
          )}
        </div>
      </div>
      {(overMax || negative) && (
        <p className="mt-1 text-xs text-red-600">
          {negative ? 'Grade can’t be negative.' : `Exceeds max points (${state.maxPoints}).`}
        </p>
      )}

      <textarea
        value={feedback}
        disabled={saving}
        onChange={(e) => setFeedback(e.target.value)}
        rows={2}
        placeholder="Feedback (optional)"
        className="mt-2 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs focus:border-campus-400 focus:outline-none"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="text-xs font-medium text-gray-500 hover:text-gray-700 disabled:opacity-60"
        >
          Cancel
        </button>
        <div className="flex items-center gap-2">
          {state.hasGrade && (
            <button
              type="button"
              onClick={() => void onTogglePublish()}
              disabled={publishing || saving}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                state.isPublished
                  ? 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                  : 'bg-campus-50 text-campus-700 hover:bg-campus-100',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {publishing && <LoadingSpinner size="sm" className="mr-1 inline-block" />}
              {state.isPublished ? 'Unpublish' : 'Publish'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="inline-flex items-center gap-1 rounded-md bg-campus-700 px-3 py-1 text-xs font-semibold text-white hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving && <LoadingSpinner size="sm" className="border-white/40 border-t-white" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );

  async function handleSave() {
    if (!canSave) return;
    await onSave(numeric, feedback.trim());
  }
}

export function deriveLetter(pct: number): string {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

/** Cell color tier for the at-a-glance grid. */
export function gradeTier(pct: number | null): 'good' | 'ok' | 'low' | 'none' {
  if (pct === null) return 'none';
  if (pct >= 80) return 'good';
  if (pct >= 60) return 'ok';
  return 'low';
}
