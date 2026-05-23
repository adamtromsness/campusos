'use client';

import Link from 'next/link';
import { use } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCanVote, useElection, useElectionResults, useUpdateElection } from '@/hooks/use-clubs';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

const STATUS_PILL: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  OPEN: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-amber-100 text-amber-700',
  RESULTS_PUBLISHED: 'bg-violet-100 text-violet-700',
};

export default function ElectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['clb-002:write']);
  const isStudent = user?.activePersona?.type === 'STUDENT';
  const electionQ = useElection(id, !!user);
  const canVoteQ = useCanVote(id, !!user && isStudent);
  const update = useUpdateElection(id);
  const resultsQ = useElectionResults(id, !!user);
  const { toast } = useToast();

  if (!user) return null;
  if (electionQ.isLoading) {
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
  const isPublished = election.status === 'RESULTS_PUBLISHED';

  async function transition(toStatus: 'OPEN' | 'CLOSED' | 'RESULTS_PUBLISHED') {
    try {
      await update.mutateAsync({ status: toStatus });
      toast(`Election → ${toStatus}`, 'success');
    } catch (err) {
      toast((err as { message?: string })?.message ?? 'Failed', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={election.title} description={election.description ?? undefined} />

      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span
            className={`rounded px-2 py-1 text-xs font-medium ${
              STATUS_PILL[election.status] ?? 'bg-gray-100 text-gray-700'
            }`}
          >
            {election.status}
          </span>
          <span className="text-xs text-gray-500">
            Voting: {new Date(election.votingStart).toLocaleString()} →{' '}
            {new Date(election.votingEnd).toLocaleString()}
          </span>
        </div>

        {isStudent && election.status === 'OPEN' && canVoteQ.data?.canVote ? (
          <Link
            href={`/clubs/elections/${id}/vote`}
            className="inline-block rounded bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-600"
          >
            Cast your ballot →
          </Link>
        ) : null}
        {isStudent && canVoteQ.data?.hasVoted ? (
          <span className="inline-block rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">
            ✓ You have voted
          </span>
        ) : null}

        {isAdmin ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {election.status === 'DRAFT' ? (
              <button
                type="button"
                onClick={() => transition('OPEN')}
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
              >
                Open voting
              </button>
            ) : null}
            {election.status === 'OPEN' ? (
              <button
                type="button"
                onClick={() => transition('CLOSED')}
                className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
              >
                Close voting
              </button>
            ) : null}
            {election.status === 'CLOSED' ? (
              <button
                type="button"
                onClick={() => transition('RESULTS_PUBLISHED')}
                className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
              >
                Publish results
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="mb-6 rounded-lg border border-gray-200 bg-white">
        <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
          {isPublished ? 'Results' : 'Candidates'}
        </h2>
        {!election.candidates || election.candidates.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">No candidates registered.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {election.candidates.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-gray-900">
                      {c.studentName ?? '—'}{' '}
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        for {c.position}
                      </span>
                    </div>
                    {c.statement ? (
                      <p className="mt-1 text-sm text-gray-700">{c.statement}</p>
                    ) : null}
                  </div>
                  {isPublished && c.voteCount !== null && c.voteCount !== undefined ? (
                    <div className="text-right">
                      <p className="text-2xl font-bold text-campus-700">{c.voteCount}</p>
                      <p className="text-xs text-gray-500">votes</p>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isPublished && resultsQ.data ? (
        <section className="rounded-lg border border-gray-200 bg-violet-50 p-4 text-sm text-violet-900">
          <strong>{resultsQ.data.totalVotersChecked}</strong> students voted in this election. The
          schema-level anonymity guarantee means there is no record of who voted for whom.
        </section>
      ) : null}
    </div>
  );
}
