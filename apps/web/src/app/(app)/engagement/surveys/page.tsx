'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCreateSurvey,
  useSubmitSurveyResponse,
  useSurvey,
  useSurveyResults,
  useSurveys,
  useUpdateSurvey,
} from '@/hooks/use-engagement';
import type {
  CreateSurveyPayload,
  SurveyDto,
  SurveyQuestion,
  SurveyQuestionType,
} from '@/lib/types';
import {
  formatDateOnly,
  SURVEY_QUESTION_TYPE_LABEL,
  SURVEY_STATUS_LABEL,
  SURVEY_STATUS_PILL,
} from '@/lib/engagement-format';

export default function SurveyManagerPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin', 'eng-001:admin']);
  const isStaff = user?.personType === 'STAFF' || isAdmin;
  const isParent = user?.personType === 'GUARDIAN';

  const [filter, setFilter] = useState<'all' | 'open' | 'draft' | 'closed'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedSurveyId, setSelectedSurveyId] = useState<string | null>(null);
  const [respondSurveyId, setRespondSurveyId] = useState<string | null>(null);

  const surveysQ = useSurveys();

  const filtered = useMemo(() => {
    const rows = surveysQ.data ?? [];
    if (filter === 'open') return rows.filter((r) => r.status === 'OPEN');
    if (filter === 'draft') return rows.filter((r) => r.status === 'DRAFT');
    if (filter === 'closed') return rows.filter((r) => r.status === 'CLOSED');
    return rows;
  }, [surveysQ.data, filter]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Parent Surveys"
        description={
          isParent
            ? 'Respond to open parent surveys. Your responses help shape school decisions.'
            : 'Build and publish parent surveys. Anonymous surveys never expose individual responses.'
        }
      />

      {isStaff ? (
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link
            href="/engagement/conferences"
            className="rounded-full bg-campus-50 px-3 py-1 font-medium text-campus-700 hover:bg-campus-100"
          >
            Conferences →
          </Link>
          <Link
            href="/engagement/dashboard"
            className="rounded-full bg-campus-50 px-3 py-1 font-medium text-campus-700 hover:bg-campus-100"
          >
            Engagement dashboard →
          </Link>
        </nav>
      ) : null}

      {/* Filters + create */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(
            [
              { key: 'all', label: 'All' },
              { key: 'open', label: 'Open' },
              ...(isStaff ? ([{ key: 'draft', label: 'Draft' }] as const) : []),
              { key: 'closed', label: 'Closed' },
            ] as const
          ).map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key as typeof filter)}
              className={
                'rounded-full px-3 py-1 text-xs font-medium ring-1 ' +
                (filter === f.key
                  ? 'bg-campus-600 text-white ring-campus-600'
                  : 'bg-white text-gray-700 ring-gray-200 hover:bg-gray-50')
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            + New survey
          </button>
        ) : null}
      </div>

      {/* Surveys list */}
      {filtered.length === 0 ? (
        <EmptyState
          title={isParent ? 'No surveys at the moment' : 'No surveys yet'}
          description={
            isParent
              ? 'Check back when the school publishes a new survey.'
              : 'Create your first survey to gather parent feedback.'
          }
        />
      ) : (
        <ul className="space-y-3">
          {filtered.map((s) => (
            <SurveyRow
              key={s.id}
              survey={s}
              isAdmin={isAdmin}
              isStaff={isStaff}
              isParent={isParent}
              onView={() => setSelectedSurveyId(s.id)}
              onRespond={() => setRespondSurveyId(s.id)}
            />
          ))}
        </ul>
      )}

      {showCreate ? <CreateSurveyModal onClose={() => setShowCreate(false)} /> : null}
      {selectedSurveyId ? (
        <SurveyResultsModal
          surveyId={selectedSurveyId}
          isAdmin={isAdmin}
          onClose={() => setSelectedSurveyId(null)}
        />
      ) : null}
      {respondSurveyId ? (
        <RespondSurveyModal surveyId={respondSurveyId} onClose={() => setRespondSurveyId(null)} />
      ) : null}
    </div>
  );
}

function SurveyRow({
  survey,
  isAdmin,
  isStaff,
  isParent,
  onView,
  onRespond,
}: {
  survey: SurveyDto;
  isAdmin: boolean;
  isStaff: boolean;
  isParent: boolean;
  onView: () => void;
  onRespond: () => void;
}) {
  const updateMut = useUpdateSurvey();

  return (
    <li className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">{survey.title}</h3>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' + SURVEY_STATUS_PILL[survey.status]
              }
            >
              {SURVEY_STATUS_LABEL[survey.status]}
            </span>
            {survey.isAnonymous ? (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">
                Anonymous
              </span>
            ) : (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200">
                Identified
              </span>
            )}
          </div>
          {survey.description ? (
            <p className="mt-1 text-sm text-gray-700">{survey.description}</p>
          ) : null}
          <p className="mt-1 text-xs text-gray-500">
            {survey.questions.length} questions · {survey.totalResponses} responses
            {survey.openedAt ? ` · opened ${formatDateOnly(survey.openedAt)}` : ''}
            {survey.closedAt ? ` · closed ${formatDateOnly(survey.closedAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isParent && survey.status === 'OPEN' ? (
            <button
              type="button"
              onClick={onRespond}
              className="rounded-md bg-campus-600 px-3 py-1 text-xs font-medium text-white hover:bg-campus-700"
            >
              Respond
            </button>
          ) : null}
          {isStaff ? (
            <button
              type="button"
              onClick={onView}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              View results
            </button>
          ) : null}
          {isAdmin && survey.status === 'DRAFT' ? (
            <button
              type="button"
              onClick={() => updateMut.mutate({ id: survey.id, body: { status: 'OPEN' } })}
              disabled={updateMut.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Open
            </button>
          ) : null}
          {isAdmin && survey.status === 'OPEN' ? (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Close this survey? No further responses will be accepted.'))
                  updateMut.mutate({ id: survey.id, body: { status: 'CLOSED' } });
              }}
              disabled={updateMut.isPending}
              className="rounded-md bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              Close
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function CreateSurveyModal({ onClose }: { onClose: () => void }) {
  const mut = useCreateSurvey();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [questions, setQuestions] = useState<SurveyQuestion[]>([
    { id: 'q1', question_text: '', question_type: 'RATING_1_5' },
  ]);
  const [error, setError] = useState<string | null>(null);

  function addQuestion(): void {
    const nextId = `q${questions.length + 1}`;
    setQuestions([...questions, { id: nextId, question_text: '', question_type: 'RATING_1_5' }]);
  }

  function updateQuestion(idx: number, patch: Partial<SurveyQuestion>): void {
    setQuestions(questions.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  }

  function removeQuestion(idx: number): void {
    setQuestions(questions.filter((_, i) => i !== idx));
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (questions.length === 0 || questions.some((q) => !q.question_text.trim())) {
      setError('Each question must have text.');
      return;
    }
    const cleaned: SurveyQuestion[] = questions.map((q) => {
      const out: SurveyQuestion = { ...q, question_text: q.question_text.trim() };
      if (q.question_type === 'MULTIPLE_CHOICE') {
        const opts = (q.options ?? []).map((o) => o.trim()).filter((o) => o);
        if (opts.length < 2) {
          throw new Error(`Multiple choice question "${q.question_text}" needs ≥2 options.`);
        }
        out.options = opts;
      } else {
        delete out.options;
      }
      return out;
    });

    const payload: CreateSurveyPayload = {
      title: title.trim(),
      description: description.trim() || undefined,
      isAnonymous,
      questions: cleaned,
    };
    try {
      await mut.mutateAsync(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card bg-white p-5 shadow-lg"
      >
        <h2 className="text-lg font-semibold text-gray-900">New parent survey</h2>
        <p className="mt-1 text-sm text-gray-500">
          Surveys start as DRAFT. Open them to start collecting responses.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600">Title</label>
            <input
              type="text"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">
              Description (optional)
            </label>
            <textarea
              rows={2}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isAnonymous}
              onChange={(e) => setIsAnonymous(e.target.checked)}
            />
            <span>
              Anonymous — respondent identity is <strong>never</strong> stored
            </span>
          </label>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-gray-600">Questions</label>
              <button
                type="button"
                onClick={addQuestion}
                className="rounded-md border border-campus-300 px-2 py-0.5 text-xs font-medium text-campus-700 hover:bg-campus-50"
              >
                + Add question
              </button>
            </div>
            <div className="mt-2 space-y-3">
              {questions.map((q, i) => (
                <div key={q.id} className="rounded-md border border-gray-200 bg-gray-50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-500">Q{i + 1}</span>
                    {questions.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeQuestion(i)}
                        className="text-xs text-rose-700 hover:underline"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <input
                    type="text"
                    required
                    value={q.question_text}
                    onChange={(e) => updateQuestion(i, { question_text: e.target.value })}
                    placeholder="Question text"
                    className="mt-2 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        'RATING_1_5',
                        'RATING_1_10',
                        'YES_NO',
                        'FREE_TEXT',
                        'MULTIPLE_CHOICE',
                      ] as SurveyQuestionType[]
                    ).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => updateQuestion(i, { question_type: t })}
                        className={
                          'rounded-full px-2 py-0.5 text-xs ring-1 ' +
                          (q.question_type === t
                            ? 'bg-campus-600 text-white ring-campus-600'
                            : 'bg-white text-gray-700 ring-gray-200 hover:bg-gray-50')
                        }
                      >
                        {SURVEY_QUESTION_TYPE_LABEL[t]}
                      </button>
                    ))}
                  </div>
                  {q.question_type === 'MULTIPLE_CHOICE' ? (
                    <div className="mt-2">
                      <label className="block text-xs font-medium text-gray-600">
                        Options (one per line, ≥2)
                      </label>
                      <textarea
                        rows={3}
                        value={(q.options ?? []).join('\n')}
                        onChange={(e) =>
                          updateQuestion(i, {
                            options: e.target.value.split('\n'),
                          })
                        }
                        className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mut.isPending}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            {mut.isPending ? 'Creating…' : 'Create draft survey'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SurveyResultsModal({
  surveyId,
  isAdmin,
  onClose,
}: {
  surveyId: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const surveyQ = useSurvey(surveyId);
  // Admin gets the dedicated results endpoint; staff falls back to the survey detail
  const resultsQ = useSurveyResults(surveyId, isAdmin);
  const dto = (isAdmin ? resultsQ.data : surveyQ.data) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-card bg-white p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {dto?.title ?? 'Survey results'}
            </h2>
            {dto?.description ? (
              <p className="mt-1 text-sm text-gray-500">{dto.description}</p>
            ) : null}
            {dto ? (
              <p className="mt-1 text-xs text-gray-500">
                {dto.totalResponses} responses · {dto.isAnonymous ? 'Anonymous' : 'Identified'}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Close
          </button>
        </div>

        {!dto ? (
          <p className="mt-4 text-sm text-gray-500">Loading results…</p>
        ) : (
          <div className="mt-4 space-y-4">
            {dto.isAnonymous ? (
              <p className="rounded-md border border-indigo-200 bg-indigo-50 p-2 text-xs text-indigo-800">
                Anonymous survey — individual responses are never available. Aggregated charts only.
              </p>
            ) : null}
            {dto.questions.map((q) => {
              const aggregate = (dto.responseDataAggregated ?? {})[q.id] as
                | Record<string, unknown>
                | undefined;
              return (
                <div key={q.id} className="rounded-md border border-gray-200 bg-gray-50 p-3">
                  <div className="text-sm font-medium text-gray-800">{q.question_text}</div>
                  <div className="mt-1 text-xs text-gray-500">{q.question_type}</div>
                  <ResultDisplay question={q} aggregate={aggregate} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultDisplay({
  question,
  aggregate,
}: {
  question: SurveyQuestion;
  aggregate: Record<string, unknown> | undefined;
}) {
  if (!aggregate) {
    return <p className="mt-2 text-xs text-gray-500">No responses yet.</p>;
  }

  if (question.question_type === 'RATING_1_5' || question.question_type === 'RATING_1_10') {
    const count = Number(aggregate.count ?? 0);
    const average = Number(aggregate.average ?? 0);
    const dist = (aggregate.distribution ?? {}) as Record<string, number>;
    const max = question.question_type === 'RATING_1_5' ? 5 : 10;
    return (
      <div className="mt-2">
        <div className="text-xs text-gray-500">
          {count} responses · average {average.toFixed(1)}
        </div>
        <div className="mt-2 space-y-1">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
            const c = Number(dist[String(n)] ?? 0);
            const pct = count === 0 ? 0 : (c / count) * 100;
            return (
              <div key={n} className="flex items-center gap-2 text-xs">
                <span className="w-4 text-right text-gray-500">{n}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full bg-campus-500" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-8 text-right text-gray-500">{c}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  if (question.question_type === 'YES_NO') {
    const yes = Number(aggregate.yes ?? 0);
    const no = Number(aggregate.no ?? 0);
    const total = yes + no;
    return (
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-emerald-700">
          Yes: {yes} ({total === 0 ? 0 : Math.round((yes / total) * 100)}%)
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-rose-700">
          No: {no} ({total === 0 ? 0 : Math.round((no / total) * 100)}%)
        </div>
      </div>
    );
  }
  if (question.question_type === 'MULTIPLE_CHOICE') {
    const count = Number(aggregate.count ?? 0);
    const dist = (aggregate.distribution ?? {}) as Record<string, number>;
    return (
      <div className="mt-2 space-y-1">
        {Object.entries(dist).map(([option, n]) => {
          const c = Number(n);
          const pct = count === 0 ? 0 : (c / count) * 100;
          return (
            <div key={option} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate text-gray-700">{option}</span>
              <div className="h-2 w-32 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-campus-500" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-8 text-right text-gray-500">{c}</span>
            </div>
          );
        })}
      </div>
    );
  }
  // FREE_TEXT — count only (never aggregated to preserve anonymity)
  return (
    <p className="mt-2 text-xs text-gray-500">
      {Number(aggregate.count ?? 0)} free-text responses. Raw text is never aggregated to preserve
      anonymity.
    </p>
  );
}

function RespondSurveyModal({ surveyId, onClose }: { surveyId: string; onClose: () => void }) {
  const surveyQ = useSurvey(surveyId);
  const mut = useSubmitSurveyResponse();
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ total: number } | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!surveyQ.data) return;
    // Ensure every question has an answer
    for (const q of surveyQ.data.questions) {
      const v = answers[q.id];
      if (v === undefined || v === '' || v === null) {
        setError(`Please answer: ${q.question_text}`);
        return;
      }
    }
    try {
      const res = await mut.mutateAsync({ id: surveyId, body: { answers } });
      setSubmitted({ total: res.totalResponses });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card bg-white p-5 shadow-lg">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {surveyQ.data?.title ?? 'Survey'}
            </h2>
            {surveyQ.data?.description ? (
              <p className="mt-1 text-sm text-gray-500">{surveyQ.data.description}</p>
            ) : null}
            {surveyQ.data?.isAnonymous ? (
              <p className="mt-1 text-xs font-medium text-indigo-700">
                Anonymous — your identity is never stored.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Close
          </button>
        </div>

        {submitted ? (
          <div className="mt-6 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            ✓ Thank you for responding. Total responses so far: <strong>{submitted.total}</strong>.
          </div>
        ) : !surveyQ.data ? (
          <p className="mt-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-4">
            {surveyQ.data.questions.map((q) => (
              <QuestionInput
                key={q.id}
                question={q}
                value={answers[q.id]}
                onChange={(v) => setAnswers({ ...answers, [q.id]: v })}
              />
            ))}
            {error ? <p className="text-sm text-rose-700">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={mut.isPending}
                className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
              >
                {mut.isPending ? 'Submitting…' : 'Submit responses'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: SurveyQuestion;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  if (question.question_type === 'RATING_1_5' || question.question_type === 'RATING_1_10') {
    const max = question.question_type === 'RATING_1_5' ? 5 : 10;
    return (
      <div>
        <label className="block text-sm font-medium text-gray-800">{question.question_text}</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              className={
                'min-w-[2.5rem] rounded-md px-3 py-1.5 text-sm ring-1 ' +
                (value === n
                  ? 'bg-campus-600 text-white ring-campus-600'
                  : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50')
              }
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (question.question_type === 'YES_NO') {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-800">{question.question_text}</label>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => onChange(true)}
            className={
              'rounded-md px-4 py-1.5 text-sm ring-1 ' +
              (value === true
                ? 'bg-emerald-600 text-white ring-emerald-600'
                : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50')
            }
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => onChange(false)}
            className={
              'rounded-md px-4 py-1.5 text-sm ring-1 ' +
              (value === false
                ? 'bg-rose-600 text-white ring-rose-600'
                : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50')
            }
          >
            No
          </button>
        </div>
      </div>
    );
  }
  if (question.question_type === 'MULTIPLE_CHOICE') {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-800">{question.question_text}</label>
        <div className="mt-2 space-y-1">
          {(question.options ?? []).map((opt) => (
            <label key={opt} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={question.id}
                checked={value === opt}
                onChange={() => onChange(opt)}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }
  // FREE_TEXT
  return (
    <div>
      <label className="block text-sm font-medium text-gray-800">{question.question_text}</label>
      <textarea
        rows={3}
        maxLength={5000}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
      />
    </div>
  );
}
