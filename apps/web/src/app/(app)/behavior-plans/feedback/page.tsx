'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useBehaviorPlan, useFeedbackPending, useSubmitFeedback } from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  FEEDBACK_EFFECTIVENESS_LABELS,
  FEEDBACK_EFFECTIVENESS_OPTIONS,
  FEEDBACK_EFFECTIVENESS_PILL,
} from '@/lib/discipline-format';
import type { BIPFeedbackDto, FeedbackEffectiveness } from '@/lib/types';

export default function FeedbackQueuePage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['beh-002:read']);

  const pending = useFeedbackPending(canRead);
  const [openFeedback, setOpenFeedback] = useState<BIPFeedbackDto | null>(null);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="BIP feedback" />
        <EmptyState
          title="Access required"
          description="You need behaviour plan read access to view your feedback queue."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="BIP feedback"
        description="Pending feedback requests on behaviour intervention plans."
        actions={
          <Link href="/behaviour" className="text-sm text-gray-500 hover:text-gray-700">
            ← Behaviour
          </Link>
        }
      />

      {pending.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (pending.data ?? []).length === 0 ? (
        <EmptyState
          title="No pending requests"
          description="You're all caught up. Counsellors will request feedback when a BIP needs your input."
        />
      ) : (
        <ul className="space-y-2">
          {(pending.data ?? []).map((row) => (
            <li
              key={row.id}
              className="rounded-lg border border-gray-200 bg-white p-4 transition hover:border-campus-300 hover:bg-campus-50/40"
            >
              <button
                type="button"
                onClick={() => setOpenFeedback(row)}
                className="block w-full text-left"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
                    Pending
                  </span>
                  {row.planType && (
                    <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-violet-200">
                      {row.planType}
                    </span>
                  )}
                  <span className="text-xs text-gray-500">
                    Requested {new Date(row.requestedAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium text-gray-900">
                  {row.studentName ?? 'Student'}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {row.requestedByName ? 'Requested by ' + row.requestedByName : ''}
                  <span className="ml-2 text-campus-700">→ Open feedback form</span>
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}

      {openFeedback && (
        <SubmitFeedbackModal feedback={openFeedback} onClose={() => setOpenFeedback(null)} />
      )}
    </div>
  );
}

function SubmitFeedbackModal({
  feedback,
  onClose,
}: {
  feedback: BIPFeedbackDto;
  onClose: () => void;
}) {
  const plan = useBehaviorPlan(feedback.planId);
  const submit = useSubmitFeedback(feedback.id);
  const { toast } = useToast();

  const [strategiesObserved, setStrategiesObserved] = useState<string[]>([]);
  const [effectiveness, setEffectiveness] = useState<FeedbackEffectiveness | ''>('');
  const [observations, setObservations] = useState('');
  const [adjustments, setAdjustments] = useState('');

  const reinforcementStrategies = plan.data?.reinforcementStrategies ?? [];

  function toggleStrategy(s: string) {
    setStrategiesObserved((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : prev.concat(s),
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await submit.mutateAsync({
        strategiesObserved: strategiesObserved.length > 0 ? strategiesObserved : undefined,
        overallEffectiveness: effectiveness || undefined,
        classroomObservations: observations.trim() || null,
        recommendedAdjustments: adjustments.trim() || null,
      });
      toast('Feedback submitted', 'success');
      onClose();
    } catch (err: any) {
      toast('Could not submit feedback: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={'Feedback · ' + (feedback.studentName ?? 'Student')}
      size="lg"
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
            form="submit-feedback-form"
            disabled={submit.isPending}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-gray-300"
          >
            {submit.isPending ? 'Submitting…' : 'Submit feedback'}
          </button>
        </>
      }
    >
      <form id="submit-feedback-form" onSubmit={handleSubmit} className="space-y-5">
        <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
          {feedback.requestedByName ? (
            <p>
              <span className="font-medium">{feedback.requestedByName}</span> has requested your
              observations on this BIP.
            </p>
          ) : (
            <p>A counsellor has requested your observations on this BIP.</p>
          )}
          {plan.data && (
            <p className="mt-1">
              <Link
                href={'/behavior-plans/' + plan.data.id}
                className="text-campus-700 hover:underline"
                target="_blank"
              >
                View full plan ↗
              </Link>
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Strategies observed <span className="text-gray-400">(optional)</span>
          </label>
          {plan.isLoading ? (
            <p className="text-sm text-gray-500">Loading plan strategies…</p>
          ) : reinforcementStrategies.length === 0 ? (
            <p className="text-sm text-gray-500">
              No reinforcement strategies are listed on this plan. You can still submit observations
              and recommendations below.
            </p>
          ) : (
            <ul className="space-y-1">
              {reinforcementStrategies.map((s) => (
                <li key={s}>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={strategiesObserved.includes(s)}
                      onChange={() => toggleStrategy(s)}
                      className="mt-0.5 rounded border-gray-300 text-campus-700 focus:ring-campus-500"
                    />
                    <span>{s}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Overall effectiveness <span className="text-gray-400">(optional)</span>
          </label>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {FEEDBACK_EFFECTIVENESS_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setEffectiveness(opt)}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm transition ring-1',
                  effectiveness === opt
                    ? FEEDBACK_EFFECTIVENESS_PILL[opt] + ' font-semibold'
                    : 'bg-white text-gray-700 ring-gray-200 hover:bg-gray-50',
                )}
              >
                {FEEDBACK_EFFECTIVENESS_LABELS[opt]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Classroom observations <span className="text-gray-400">(optional)</span>
          </label>
          <textarea
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            rows={4}
            maxLength={4000}
            placeholder="What you observed during the period covered by this feedback…"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-900">
            Recommended adjustments <span className="text-gray-400">(optional)</span>
          </label>
          <textarea
            value={adjustments}
            onChange={(e) => setAdjustments(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Suggestions for the counsellor on next iteration of the plan…"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>
      </form>
    </Modal>
  );
}
