'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCommunityLeaderboard,
  useMyCommunityProfile,
  useUpdateMyCommunityProfile,
} from '@/hooks/use-community';

/**
 * P2-21c — Community Profiles + Leaderboard.
 *
 * Shows the calling user's own profile + edit panel, plus the top-25
 * leaderboard ordered by reputation_points DESC. is_public toggle
 * controls whether the calling user appears in the leaderboard.
 */
export default function CommunityProfilesPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['mkt-005:read']);
  const canWrite = !!user && hasAnyPermission(user, ['mkt-005:write']);

  const me = useMyCommunityProfile();
  const leaderboard = useCommunityLeaderboard(25);
  const update = useUpdateMyCommunityProfile();

  const [bio, setBio] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user) return <LoadingSpinner />;
  if (!canRead) {
    return (
      <EmptyState
        title="Not available"
        description="Community Profiles are available to anyone holding MKT-005:read."
      />
    );
  }
  if (me.isPending || leaderboard.isPending) return <LoadingSpinner />;

  const myProfile = me.data;
  const effectiveBio = bio !== null ? bio : (myProfile?.bio ?? '');
  const effectiveIsPublic = isPublic !== null ? isPublic : (myProfile?.isPublic ?? true);

  const onSave = async (): Promise<void> => {
    if (!myProfile) return;
    setError(null);
    try {
      await update.mutateAsync({
        bio: effectiveBio,
        isPublic: effectiveIsPublic,
      });
      setBio(null);
      setIsPublic(null);
    } catch (e) {
      setError(String((e as Error).message ?? 'Failed to save profile'));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Community Profiles"
        description="Your community profile + the cross-school reputation leaderboard."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-gray-900">Your profile</h2>
          {myProfile ? (
            <div className="mt-3 space-y-3">
              <div>
                <p className="text-xs text-gray-500">Display name</p>
                <p className="text-sm font-medium text-gray-900">{myProfile.displayName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Reputation</p>
                <p className="text-2xl font-semibold text-campus-700">
                  {myProfile.reputationPoints}
                </p>
                <p className="text-xs text-gray-500">points</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Bio</label>
                <textarea
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  rows={3}
                  value={effectiveBio ?? ''}
                  disabled={!canWrite}
                  onChange={(e) => setBio(e.target.value)}
                />
              </div>
              <div>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={effectiveIsPublic}
                    disabled={!canWrite}
                    onChange={(e) => setIsPublic(e.target.checked)}
                  />
                  <span className="text-sm">Show on public leaderboard</span>
                </label>
              </div>
              {error && <p className="text-sm text-rose-700">{error}</p>}
              {canWrite && (bio !== null || isPublic !== null) && (
                <button
                  type="button"
                  onClick={onSave}
                  disabled={update.isPending}
                  className="rounded-md bg-campus-600 px-3 py-2 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
                >
                  {update.isPending ? 'Saving…' : 'Save profile'}
                </button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-gray-500">No profile yet — opening a profile…</p>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-gray-900">Top reputation</h2>
          {(leaderboard.data ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">No public profiles yet.</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {(leaderboard.data ?? []).map((p, idx) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded border border-gray-100 p-2"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      #{idx + 1} {p.displayName}
                    </p>
                    {p.schoolName && <p className="text-xs text-gray-500">{p.schoolName}</p>}
                  </div>
                  <p className="text-sm font-semibold text-campus-700">{p.reputationPoints} pts</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
