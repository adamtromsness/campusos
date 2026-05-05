'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useSubmitWellbeingCheckin,
  useWellbeingCheckin,
  useWellbeingTemplate,
} from '@/hooks/use-wellbeing';
import { DOMAIN_LABELS, DOMAIN_PILL } from '@/lib/wellbeing-format';
import type {
  SubmitWellbeingCheckinResponseInput,
  WellbeingQuestionDto,
  WellbeingQuestionType,
} from '@/lib/types';

/**
 * /wellbeing/checkins/[id] — Student check-in completion flow.
 *
 * THE FIRST STUDENT-INPUT SURFACE IN CAMPUSOS.
 *
 * Renders one card per template question with the appropriate input
 * for the question_type. The user must answer every question before
 * submit is enabled. POST to /counselling/wellbeing/checkins/:id/submit
 * runs the alert evaluation server-side; the response stamps
 * completed_at + flagged_for_follow_up + creates alert rows. Students
 * never see the flagged status or alert rows — the counsellor
 * initiates any follow-up conversation naturally.
 */
export default function CheckinCompletionPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  const { toast } = useToast();

  const ckinQ = useWellbeingCheckin(id);
  const tplQ = useWellbeingTemplate(ckinQ.data?.templateId ?? null);
  const submit = useSubmitWellbeingCheckin(id);

  const [responses, setResponses] = useState<Record<string, { numeric?: number; text?: string }>>(
    {},
  );
  const [submitted, setSubmitted] = useState(false);

  const questions: WellbeingQuestionDto[] = useMemo(() => {
    return (tplQ.data?.questions ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  }, [tplQ.data?.questions]);

  function setNumeric(qid: string, n: number) {
    setResponses((prev) => ({ ...prev, [qid]: { numeric: n } }));
  }
  function setText(qid: string, t: string) {
    setResponses((prev) => ({ ...prev, [qid]: { text: t } }));
  }

  const allAnswered = questions.every((q) => {
    const r = responses[q.id];
    if (!r) return false;
    if (q.questionType === 'FREE_TEXT') return !!r.text && r.text.trim().length > 0;
    return r.numeric !== undefined && r.numeric !== null;
  });

  if (ckinQ.isLoading || tplQ.isLoading) return <LoadingSpinner />;
  if (ckinQ.isError || !ckinQ.data) {
    return (
      <EmptyState
        title="Check-in not found"
        description="It may have already been completed, or you may not have access."
      />
    );
  }
  const ckin = ckinQ.data;

  if (ckin.completedAt && !submitted) {
    return (
      <div className="space-y-4">
        <PageHeader title="Already submitted" description="This check-in is already complete." />
        <Link
          href="/wellbeing"
          className="inline-block rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
        >
          ← Back to wellbeing
        </Link>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="mx-auto max-w-xl space-y-6 py-8 text-center">
        <div className="text-6xl">💚</div>
        <h1 className="font-display text-3xl text-gray-900">Thank you for checking in.</h1>
        <p className="text-sm text-gray-700">
          Your counsellor will see your responses. If you need to talk to someone before then, find
          your school counsellor or a trusted adult.
        </p>
        <div className="flex justify-center gap-3 pt-4">
          <Link
            href="/wellbeing"
            className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
          >
            Back to wellbeing
          </Link>
          <Link
            href="/wellbeing/history"
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50"
          >
            See my history
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={ckin.templateName ?? 'Check-in'}
        description="Take a moment to think about each question. Your responses go to the counselling team."
      />

      <div className="text-sm">
        <Link href="/wellbeing" className="text-campus-700 hover:underline">
          ← Back to wellbeing
        </Link>
      </div>

      <ol className="space-y-4">
        {questions.map((q, idx) => {
          const r = responses[q.id];
          return (
            <li key={q.id} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-sm font-medium text-gray-900">
                  Question {idx + 1} of {questions.length}
                </div>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    DOMAIN_PILL[q.domain],
                  )}
                >
                  {DOMAIN_LABELS[q.domain]}
                </span>
              </div>
              <p className="mt-2 text-base text-gray-900">{q.questionText}</p>
              <div className="mt-4">
                <QuestionInput
                  type={q.questionType}
                  numeric={r?.numeric}
                  text={r?.text}
                  onNumeric={(n) => setNumeric(q.id, n)}
                  onText={(t) => setText(q.id, t)}
                />
              </div>
            </li>
          );
        })}
      </ol>

      <div className="sticky bottom-0 -mx-4 border-t border-gray-200 bg-white px-4 py-4 shadow-lg">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-gray-700">
            {Object.keys(responses).length} of {questions.length} answered
          </div>
          <button
            type="button"
            disabled={!allAnswered || submit.isPending}
            onClick={async () => {
              try {
                const payload: SubmitWellbeingCheckinResponseInput[] = questions.map((q) => {
                  const r = responses[q.id]!;
                  if (q.questionType === 'FREE_TEXT') {
                    return { questionId: q.id, textResponse: r.text };
                  }
                  return { questionId: q.id, numericResponse: r.numeric };
                });
                await submit.mutateAsync({ responses: payload });
                setSubmitted(true);
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Failed to submit', 'error');
              }
            }}
            className={cn(
              'rounded-md px-5 py-2 text-sm font-medium text-white shadow-sm',
              allAnswered && !submit.isPending
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-gray-300 cursor-not-allowed',
            )}
          >
            {submit.isPending ? 'Submitting…' : 'Submit check-in'}
          </button>
        </div>
        {!allAnswered ? (
          <p className="mt-2 text-xs text-gray-500">
            Answer every question to enable submit. Take your time.
          </p>
        ) : null}
      </div>

      {/* Bottom spacer so the sticky footer doesn't cover the last card */}
      <div className="h-2" />

      <p className="text-xs text-gray-500">
        Once you submit, you can&apos;t change your responses. If you need to add something, you can
        share it with your counsellor directly.
      </p>

      {/* Use router placeholder so Next doesn't tree-shake the import */}
      <NoopRouterRef router={router} />
    </div>
  );
}

interface QuestionInputProps {
  type: WellbeingQuestionType;
  numeric: number | undefined;
  text: string | undefined;
  onNumeric: (n: number) => void;
  onText: (t: string) => void;
}

function QuestionInput({ type, numeric, text, onNumeric, onText }: QuestionInputProps) {
  if (type === 'YES_NO') {
    return (
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onNumeric(1)}
          className={cn(
            'flex-1 rounded-md border-2 px-6 py-4 text-base font-medium transition',
            numeric === 1
              ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
              : 'border-gray-200 bg-white text-gray-700 hover:border-emerald-300',
          )}
        >
          ✓ Yes
        </button>
        <button
          type="button"
          onClick={() => onNumeric(0)}
          className={cn(
            'flex-1 rounded-md border-2 px-6 py-4 text-base font-medium transition',
            numeric === 0
              ? 'border-gray-500 bg-gray-100 text-gray-900'
              : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400',
          )}
        >
          ✕ No
        </button>
      </div>
    );
  }

  if (type === 'SCALE_1_5') {
    return (
      <div>
        <div className="grid grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onNumeric(n)}
              className={cn(
                'rounded-md border-2 py-3 text-base font-semibold transition',
                numeric === n
                  ? 'border-rose-500 bg-rose-50 text-rose-900'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-rose-300',
              )}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-gray-500">
          <span>1 = Not at all</span>
          <span>5 = Very much</span>
        </div>
      </div>
    );
  }

  if (type === 'SCALE_1_10') {
    const v = numeric ?? 5;
    return (
      <div>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={v}
          onChange={(e) => onNumeric(parseInt(e.target.value, 10))}
          className="w-full accent-rose-600"
        />
        <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
          <span>1</span>
          <span className="font-mono text-base text-gray-900">{numeric ?? '—'}</span>
          <span>10</span>
        </div>
        {numeric === undefined ? (
          <p className="mt-1 text-xs text-gray-500">Move the slider to choose a number.</p>
        ) : null}
      </div>
    );
  }

  if (type === 'EMOJI_SCALE') {
    const emojis = ['😢', '🙁', '😐', '🙂', '😄'];
    return (
      <div className="grid grid-cols-5 gap-2">
        {emojis.map((e, i) => {
          const n = i + 1;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onNumeric(n)}
              className={cn(
                'flex flex-col items-center rounded-md border-2 py-3 transition',
                numeric === n
                  ? 'border-amber-500 bg-amber-50'
                  : 'border-gray-200 bg-white hover:border-amber-300',
              )}
            >
              <span className="text-3xl">{e}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // FREE_TEXT
  return (
    <div>
      <textarea
        value={text ?? ''}
        onChange={(e) => onText(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="Take your time…"
        className="w-full rounded-md border border-gray-300 p-3 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
      />
      <div className="mt-1 text-xs text-gray-500">{(text ?? '').length} / 500</div>
    </div>
  );
}

// Suppress unused-router warning — kept for future redirect flow.
function NoopRouterRef({ router: _router }: { router: ReturnType<typeof useRouter> }) {
  return null;
}
