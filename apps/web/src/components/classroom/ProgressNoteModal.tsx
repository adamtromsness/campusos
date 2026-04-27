'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import {
  useStudentProgressNotes,
  useUpsertProgressNote,
} from '@/hooks/use-classroom';
import type { EffortRating } from '@/lib/types';

interface ProgressNoteModalProps {
  classId: string;
  termId: string | null;
  studentId: string | null;
  /** Roster passed in so we can show the student's name in the title. */
  students: Array<{ id: string; fullName: string }>;
  onClose: () => void;
}

const EFFORT_OPTIONS: { value: EffortRating; label: string }[] = [
  { value: 'EXCELLENT', label: 'Excellent' },
  { value: 'GOOD', label: 'Good' },
  { value: 'SATISFACTORY', label: 'Satisfactory' },
  { value: 'NEEDS_IMPROVEMENT', label: 'Needs improvement' },
  { value: 'UNSATISFACTORY', label: 'Unsatisfactory' },
];

export function ProgressNoteModal({
  classId,
  termId,
  studentId,
  students,
  onClose,
}: ProgressNoteModalProps) {
  const { toast } = useToast();
  const open = !!studentId;

  const studentName = useMemo(
    () => (studentId ? students.find((s) => s.id === studentId)?.fullName ?? '' : ''),
    [studentId, students],
  );

  const notesQuery = useStudentProgressNotes(open ? studentId ?? undefined : undefined);
  const upsert = useUpsertProgressNote(classId);

  // Find an existing note for this (class, term) pair if any.
  const existing = useMemo(() => {
    if (!notesQuery.data || !termId) return null;
    return (
      notesQuery.data.find((n) => n.classId === classId && n.termId === termId) ?? null
    );
  }, [notesQuery.data, classId, termId]);

  const [noteText, setNoteText] = useState('');
  const [effort, setEffort] = useState<EffortRating | ''>('');
  const [parentVisible, setParentVisible] = useState(true);
  const [studentVisible, setStudentVisible] = useState(true);

  useEffect(() => {
    if (!open) return;
    setNoteText(existing?.noteText ?? '');
    setEffort((existing?.overallEffortRating as EffortRating) ?? '');
    setParentVisible(existing ? existing.isParentVisible : true);
    setStudentVisible(existing ? existing.isStudentVisible : true);
  }, [open, existing]);

  if (!open) return null;

  const canSubmit = noteText.trim().length > 0 && !!termId && !upsert.isPending;

  return (
    <Modal
      open={open}
      onClose={upsert.isPending ? () => {} : onClose}
      title={existing ? `Update progress note — ${studentName}` : `Add progress note — ${studentName}`}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={upsert.isPending}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!termId || !studentId) return;
              try {
                await upsert.mutateAsync({
                  studentId,
                  termId,
                  noteText: noteText.trim(),
                  overallEffortRating: effort || undefined,
                  isParentVisible: parentVisible,
                  isStudentVisible: studentVisible,
                });
                toast('Progress note saved', 'success');
                onClose();
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Failed to save', 'error');
              }
            }}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {upsert.isPending && <LoadingSpinner size="sm" className="border-white/40 border-t-white" />}
            {existing ? 'Update note' : 'Publish note'}
          </button>
        </>
      }
    >
      {!termId ? (
        <p className="text-sm text-gray-500">
          This class has no term assigned. Progress notes are scoped to a term.
        </p>
      ) : notesQuery.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading current note…
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
              Note
            </span>
            <textarea
              value={noteText}
              disabled={upsert.isPending}
              onChange={(e) => setNoteText(e.target.value)}
              rows={5}
              maxLength={8000}
              placeholder="Strong start to the term — work on showing more steps in solutions…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
              Effort rating
            </span>
            <select
              value={effort}
              disabled={upsert.isPending}
              onChange={(e) => setEffort(e.target.value as EffortRating | '')}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
            >
              <option value="">— No rating —</option>
              {EFFORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-4">
            <Toggle
              label="Visible to parents"
              checked={parentVisible}
              onChange={setParentVisible}
            />
            <Toggle
              label="Visible to student"
              checked={studentVisible}
              onChange={setStudentVisible}
            />
          </div>

          {existing && (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
              Last updated{' '}
              {new Date(existing.updatedAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              . Saving will overwrite the existing note for this term.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-gray-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-campus-600 focus:ring-campus-400"
      />
      {label}
    </label>
  );
}
