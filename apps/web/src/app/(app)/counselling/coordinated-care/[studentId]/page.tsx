'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useCoordinatedCare, useCreateCoordinatedCareNote } from '@/hooks/use-counselling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CARE_AUTHOR_ROLE_LABELS,
  CARE_AUTHOR_ROLE_PILL,
  CARE_AUTHOR_ROLES,
  formatRelative,
} from '@/lib/counselling-format';
import type { CareAuthorRole } from '@/lib/types';

export default function CoordinatedCareThreadPage() {
  const params = useParams<{ studentId: string }>();
  const studentId = params?.studentId ?? '';
  const { user } = useAuthStore();
  // Client-side mirror of the server intersection gate. Hide the page
  // body when the actor doesn't hold both codes (the API would 403 on
  // every read anyway). School Admin / Platform Admin pass via either
  // perm because their everyFunction grant covers both.
  const hasIntersection =
    hasAnyPermission(user, ['hlt-001:read']) && hasAnyPermission(user, ['cou-007:read']);

  const careQ = useCoordinatedCare(studentId, hasIntersection);
  const create = useCreateCoordinatedCareNote(studentId);
  const { toast } = useToast();
  const [authorRole, setAuthorRole] = useState<CareAuthorRole>('COUNSELLOR');
  const [noteText, setNoteText] = useState('');

  if (!hasIntersection) {
    return (
      <div>
        <PageHeader
          title="Coordinated care"
          description="Shared between the health and counselling teams."
        />
        <EmptyState
          title="Restricted to nurse + counsellor team"
          description="Coordinated care notes require both hlt-001:read AND cou-007:read. Teachers and parents see only their own surfaces."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coordinated care"
        description="Shared observation thread between the nurse and counsellor teams."
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        Visible only to staff who hold BOTH <code>hlt-001:read</code> AND <code>cou-007:read</code>.
        Teachers, parents, and students always 403 at the API gate.
      </div>

      {careQ.isLoading ? (
        <LoadingSpinner />
      ) : careQ.isError ? (
        <EmptyState
          title="Could not load thread"
          description="The intersection gate may have rejected this read at the API. Verify your role."
        />
      ) : (careQ.data ?? []).length === 0 ? (
        <EmptyState title="No notes yet" description="Start the thread with the form below." />
      ) : (
        <ul className="space-y-3">
          {(careQ.data ?? []).map((n) => (
            <li key={n.id} className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      CARE_AUTHOR_ROLE_PILL[n.authorRole],
                    )}
                  >
                    {CARE_AUTHOR_ROLE_LABELS[n.authorRole]}
                  </span>
                  <span className="text-sm font-medium text-gray-900">
                    {n.authorName ?? 'Unknown author'}
                  </span>
                </div>
                <span className="text-xs text-gray-500">{formatRelative(n.createdAt)}</span>
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-gray-800">{n.noteText}</div>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border border-campus-200 bg-campus-50 p-4">
        <h3 className="text-sm font-semibold text-campus-900">Add a note</h3>
        <div className="mt-3 space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-700">Posting as</label>
            <div className="mt-1 flex gap-2">
              {CARE_AUTHOR_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setAuthorRole(r)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium ring-1',
                    authorRole === r
                      ? CARE_AUTHOR_ROLE_PILL[r]
                      : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50',
                  )}
                >
                  {CARE_AUTHOR_ROLE_LABELS[r]}
                </button>
              ))}
            </div>
          </div>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Coordinated observation, hand-off, or referral note…"
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            rows={4}
            maxLength={8000}
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!noteText.trim() || create.isPending}
              onClick={async () => {
                try {
                  await create.mutateAsync({ authorRole, noteText: noteText.trim() });
                  toast('Note added to coordinated care thread', 'success');
                  setNoteText('');
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed to add note', 'error');
                }
              }}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
            >
              {create.isPending ? 'Adding…' : 'Add note'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
