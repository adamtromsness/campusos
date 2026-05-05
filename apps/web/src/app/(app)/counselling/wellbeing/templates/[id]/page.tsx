'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useAddWellbeingQuestion,
  useDeleteWellbeingQuestion,
  useUpdateWellbeingQuestion,
  useUpdateWellbeingTemplate,
  useWellbeingTemplate,
} from '@/hooks/use-wellbeing';
import {
  DOMAIN_LABELS,
  DOMAIN_PILL,
  FREQUENCY_LABELS,
  FREQUENCY_RECOMMENDATIONS,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPE_PILL,
  WELLBEING_DOMAINS,
} from '@/lib/wellbeing-format';
import type {
  FrequencyRecommendation,
  WellbeingDomain,
  WellbeingQuestionDto,
  WellbeingQuestionType,
} from '@/lib/types';

export default function WellbeingTemplateBuilderPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const tplQ = useWellbeingTemplate(id);
  const update = useUpdateWellbeingTemplate(id);
  const addQ = useAddWellbeingQuestion(id);
  const patchQ = useUpdateWellbeingQuestion(id);
  const deleteQ = useDeleteWellbeingQuestion(id);
  const { toast } = useToast();

  const [editing, setEditing] = useState<WellbeingQuestionDto | null>(null);
  const [adding, setAdding] = useState(false);

  if (tplQ.isLoading) return <LoadingSpinner />;
  if (tplQ.isError || !tplQ.data) {
    return (
      <EmptyState
        title="Template not found"
        description="It may have been deleted, or you may not have permission to view it."
      />
    );
  }
  const t = tplQ.data;
  const questions = (t.questions ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.name}
        description="Wellbeing survey template — questions are presented to students in sort order on submit."
      />

      <div className="flex items-center gap-2 text-sm">
        <Link href="/counselling/wellbeing" className="text-campus-700 hover:underline">
          ← Wellbeing dashboard
        </Link>
      </div>

      {/* Header card */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-gray-500">Frequency</dt>
            <dd className="text-sm text-gray-900">{FREQUENCY_LABELS[t.frequencyRecommendation]}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500">Status</dt>
            <dd>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  t.isActive
                    ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200'
                    : 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
                )}
              >
                {t.isActive ? 'Active' : 'Inactive'}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500">Created by</dt>
            <dd className="text-sm text-gray-900">{t.createdByName ?? '—'}</dd>
          </div>
        </dl>
        {t.description ? <p className="mt-3 text-sm text-gray-600">{t.description}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
            value={t.frequencyRecommendation}
            onChange={async (e) => {
              try {
                await update.mutateAsync({
                  frequencyRecommendation: e.target.value as FrequencyRecommendation,
                });
                toast('Frequency updated', 'success');
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Failed to update', 'error');
              }
            }}
          >
            {FREQUENCY_RECOMMENDATIONS.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={async () => {
              try {
                await update.mutateAsync({ isActive: !t.isActive });
                toast(t.isActive ? 'Template deactivated' : 'Template activated', 'success');
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Failed to update', 'error');
              }
            }}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium ring-1',
              t.isActive
                ? 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50'
                : 'bg-emerald-50 text-emerald-800 ring-emerald-200 hover:bg-emerald-100',
            )}
          >
            {t.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
        </div>
      </section>

      {/* Questions */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Questions ({questions.length})</h3>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Add question
          </button>
        </div>
        {questions.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            No questions yet. The template needs at least one question before deployment.
          </p>
        ) : (
          <ol className="mt-3 space-y-2">
            {questions.map((q) => (
              <li
                key={q.id}
                className="flex items-baseline justify-between rounded-md border border-gray-200 p-3"
              >
                <div className="flex flex-1 flex-col gap-1">
                  <div className="text-sm font-medium text-gray-900">
                    Q{q.sortOrder + 1}. {q.questionText}
                  </div>
                  <div className="flex gap-2">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        DOMAIN_PILL[q.domain],
                      )}
                    >
                      {DOMAIN_LABELS[q.domain]}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        QUESTION_TYPE_PILL[q.questionType],
                      )}
                    >
                      {QUESTION_TYPE_LABELS[q.questionType]}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(q)}
                    className="text-xs font-medium text-campus-700 hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !confirm('Delete this question? Refused if any response references it.')
                      ) {
                        return;
                      }
                      try {
                        await deleteQ.mutateAsync(q.id);
                        toast('Question deleted', 'success');
                      } catch (err) {
                        toast(err instanceof Error ? err.message : 'Failed to delete', 'error');
                      }
                    }}
                    className="text-xs font-medium text-rose-700 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Add question modal */}
      <QuestionEditorModal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add question"
        nextSortOrder={questions.length}
        onSubmit={async (data) => {
          try {
            await addQ.mutateAsync(data);
            toast('Question added', 'success');
            setAdding(false);
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Failed to add', 'error');
          }
        }}
      />

      {/* Edit question modal */}
      {editing ? (
        <QuestionEditorModal
          open={!!editing}
          onClose={() => setEditing(null)}
          title="Edit question"
          initial={editing}
          onSubmit={async (data) => {
            try {
              await patchQ.mutateAsync({ id: editing.id, payload: data });
              toast('Question updated', 'success');
              setEditing(null);
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Failed to update', 'error');
            }
          }}
        />
      ) : null}
    </div>
  );
}

interface QuestionEditorModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  initial?: WellbeingQuestionDto;
  nextSortOrder?: number;
  onSubmit: (data: {
    questionText: string;
    questionType: WellbeingQuestionType;
    domain: WellbeingDomain;
    sortOrder: number;
  }) => void | Promise<void>;
}

function QuestionEditorModal({
  open,
  onClose,
  title,
  initial,
  nextSortOrder = 0,
  onSubmit,
}: QuestionEditorModalProps) {
  const [text, setText] = useState(initial?.questionText ?? '');
  const [type, setType] = useState<WellbeingQuestionType>(initial?.questionType ?? 'SCALE_1_5');
  const [domain, setDomain] = useState<WellbeingDomain>(initial?.domain ?? 'EMOTIONAL');
  const [sort, setSort] = useState(initial?.sortOrder ?? nextSortOrder);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() =>
              onSubmit({ questionText: text.trim(), questionType: type, domain, sortOrder: sort })
            }
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-700">Question text</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={2000}
            className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-700">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as WellbeingQuestionType)}
              className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm"
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {QUESTION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">Domain</label>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value as WellbeingDomain)}
              className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm"
            >
              {WELLBEING_DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {DOMAIN_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">Sort order</label>
            <input
              type="number"
              value={sort}
              min={0}
              onChange={(e) => setSort(parseInt(e.target.value || '0', 10))}
              className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </div>
        </div>
        {domain === 'SAFETY' ? (
          <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
            <strong>SAFETY domain:</strong> SAFETY+SCALE_1_5 with answer=1 fires a
            SELF_HARM_INDICATOR alert (auto-escalates to admin). SAFETY+YES_NO with answer=YES fires
            WANTS_TO_TALK.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
