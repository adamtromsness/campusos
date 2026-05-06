'use client';

import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCanVote, useCastVote, useElection } from '@/hooks/use-clubs';
import { useAuthStore } from '@/lib/auth-store';

/**
 * ANONYMOUS BALLOT UI — `/clubs/elections/:id/vote`.
 *
 * Per the Cycle 17 plan: candidates grouped by position with
 * statements + photos. One selection per position. Submit button
 * with "Your vote is anonymous and cannot be changed" confirmation.
 * Post-submit: thank-you screen with no indication of who was
 * selected. The UI never stores or displays the voter's choice
 * after submission — the schema makes ballot secrecy structural
 * (ext_votes has no voter_id) and the UI never tries to retrieve
 * a vote-by-voter mapping because no such mapping exists.
 */
export default function AnonymousBallotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const electionQ = useElection(id, !!user);
  const canVoteQ = useCanVote(id, !!user);
  const cast = useCastVote(id);
  const { toast } = useToast();
  // Map of position -> selected candidateId
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!user) return null;
  if (electionQ.isLoading || canVoteQ.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (!electionQ.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Election not found" />
      </div>
    );
  }
  const election = electionQ.data;
  const canVote = canVoteQ.data;

  if (submitted) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <div className="mb-6 text-6xl">🗳️</div>
        <h1 className="text-3xl font-semibold text-gray-900">Thank you for voting</h1>
        <p className="mt-2 text-base text-gray-600">
          Your ballot has been recorded. Your vote is anonymous and cannot be traced back to you.
        </p>
        <div className="mt-8">
          <button
            type="button"
            onClick={() => router.push(`/clubs/elections/${id}`)}
            className="rounded bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-600"
          >
            Back to election
          </button>
        </div>
      </div>
    );
  }

  if (canVote && !canVote.canVote) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={election.title} />
        <EmptyState
          title={canVote.hasVoted ? 'You have already voted' : 'Cannot vote'}
          description={canVote.reason}
        />
      </div>
    );
  }

  // Group candidates by position
  const byPosition = new Map<string, typeof election.candidates>();
  for (const c of election.candidates ?? []) {
    if (!c.isApproved) continue;
    if (!byPosition.has(c.position)) byPosition.set(c.position, []);
    byPosition.get(c.position)!.push(c);
  }

  const positions = Array.from(byPosition.keys()).sort();
  const allSelected = positions.every((p) => selections[p]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={election.title} description={election.description ?? undefined} />

      <div className="mb-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Your vote is anonymous.</strong> Once submitted, your ballot cannot be changed and
        cannot be traced back to you. The schema records that you voted (to prevent double-voting)
        but does not record what you voted for.
      </div>

      {positions.map((position) => (
        <section key={position} className="mb-6 rounded-lg border border-gray-200 bg-white">
          <h2 className="border-b border-gray-200 px-4 py-3 text-base font-semibold text-gray-900">
            Position: {position}
          </h2>
          <ul className="divide-y divide-gray-100">
            {(byPosition.get(position) ?? []).map((c) => (
              <li key={c.id} className="px-4 py-3">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="radio"
                    name={position}
                    checked={selections[position] === c.id}
                    onChange={() => setSelections({ ...selections, [position]: c.id })}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="font-semibold text-gray-900">{c.studentName ?? '—'}</div>
                    {c.statement ? (
                      <p className="mt-1 text-sm text-gray-700">{c.statement}</p>
                    ) : null}
                  </div>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          {Object.keys(selections).length} of {positions.length} positions selected
        </p>
        <button
          type="button"
          disabled={!allSelected || cast.isPending || confirming}
          onClick={() => setConfirming(true)}
          className="rounded bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-600 disabled:opacity-50"
        >
          Submit ballot
        </button>
      </div>

      {confirming ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Confirm your ballot</h3>
            <p className="mt-2 text-sm text-gray-700">
              Once you submit, your vote is final and cannot be changed. Are you sure?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={cast.isPending}
                onClick={async () => {
                  // Cast each position vote sequentially
                  try {
                    for (const position of positions) {
                      await cast.mutateAsync({
                        position,
                        candidateId: selections[position]!,
                      });
                    }
                    setSubmitted(true);
                    setConfirming(false);
                  } catch (err) {
                    toast((err as { message?: string })?.message ?? 'Failed to submit', 'error');
                    setConfirming(false);
                  }
                }}
                className="rounded bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-600 disabled:opacity-50"
              >
                {cast.isPending ? 'Submitting…' : 'Submit ballot'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
