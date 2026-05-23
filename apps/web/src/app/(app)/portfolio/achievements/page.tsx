'use client';

import { useState } from 'react';
import { PageHeader, Modal, useToast } from '@/components/ui';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useAchievements, useShareAchievement, useAwardAchievement } from '@/hooks/use-portfolio';
import {
  ACHIEVEMENT_TYPES,
  ACHIEVEMENT_TYPE_LABELS,
  ACHIEVEMENT_TYPE_PILL,
  ACHIEVEMENT_SHARE_PLATFORMS,
  SHARE_PLATFORM_LABELS,
  formatDate,
} from '@/lib/portfolio-format';
import type { AchievementDto, AchievementType, AchievementSharePlatform } from '@/lib/types';

export default function AchievementsGalleryPage() {
  const { user } = useAuthStore();
  const isStudent = user?.activePersona?.type === 'STUDENT';
  const canAward = hasAnyPermission(user, ['ach-001:write']);
  const achievements = useAchievements();
  const award = useAwardAchievement();
  const { toast } = useToast();
  const [shareTarget, setShareTarget] = useState<AchievementDto | null>(null);
  const [showAwardModal, setShowAwardModal] = useState(false);

  const grouped: Record<AchievementType, AchievementDto[]> = {
    ACADEMIC: [],
    SPORTING: [],
    MUSICAL: [],
    LEADERSHIP: [],
    COMMUNITY: [],
    CUSTOM: [],
  };
  for (const a of achievements.data ?? []) grouped[a.achievementType].push(a);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Achievement gallery"
        description={
          isStudent
            ? 'All the achievements you’ve earned, grouped by type.'
            : 'Awarded achievements across the school.'
        }
      />

      {canAward && (
        <div>
          <button
            type="button"
            onClick={() => setShowAwardModal(true)}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Award a new achievement
          </button>
        </div>
      )}

      {(achievements.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-gray-500">No achievements yet.</p>
      ) : (
        ACHIEVEMENT_TYPES.map((type) => {
          const items = grouped[type];
          if (items.length === 0) return null;
          return (
            <section key={type}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                {ACHIEVEMENT_TYPE_LABELS[type]}
                <span className="ml-2 text-xs font-normal text-gray-400">({items.length})</span>
              </h2>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {items.map((a) => (
                  <li key={a.id} className="rounded-md border border-gray-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">{a.title}</p>
                        <p className="text-xs text-gray-500">
                          {a.studentName ?? 'Student'} · {formatDate(a.awardedAt)}
                          {a.sourceModule ? ` · from ${a.sourceModule}` : ''}
                        </p>
                      </div>
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${ACHIEVEMENT_TYPE_PILL[a.achievementType]}`}
                      >
                        {ACHIEVEMENT_TYPE_LABELS[a.achievementType]}
                      </span>
                    </div>
                    {a.description && <p className="mt-2 text-sm text-gray-700">{a.description}</p>}
                    <div className="mt-3 flex items-center gap-2 text-xs">
                      {a.shareCount > 0 && (
                        <span className="text-gray-400">{a.shareCount} share(s)</span>
                      )}
                      {isStudent && (
                        <button
                          type="button"
                          onClick={() => setShareTarget(a)}
                          className="text-campus-700 hover:underline"
                        >
                          Share
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      {shareTarget && (
        <ShareAchievementModal
          achievement={shareTarget}
          onClose={() => setShareTarget(null)}
          onShared={() => {
            toast(`Shared "${shareTarget.title}"`);
            setShareTarget(null);
          }}
        />
      )}

      {showAwardModal && (
        <AwardAchievementModal
          onClose={() => setShowAwardModal(false)}
          onAwarded={async (payload) => {
            try {
              await award.mutateAsync(payload);
              toast('Achievement awarded');
              setShowAwardModal(false);
            } catch (err) {
              toast(`Award failed: ${(err as Error).message}`, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function ShareAchievementModal({
  achievement,
  onClose,
  onShared,
}: {
  achievement: AchievementDto;
  onClose: () => void;
  onShared: () => void;
}) {
  const share = useShareAchievement(achievement.id);
  const [platform, setPlatform] = useState<AchievementSharePlatform>('EMAIL');
  return (
    <Modal open={true} title={`Share: ${achievement.title}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          We&apos;ll record this share in your activity. The actual external delivery (email,
          social) is delivered by the platform&apos;s notification service.
        </p>
        <div className="space-y-1">
          {ACHIEVEMENT_SHARE_PLATFORMS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <input type="radio" checked={platform === p} onChange={() => setPlatform(p)} />
              {SHARE_PLATFORM_LABELS[p]}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              await share.mutateAsync({ platform });
              onShared();
            }}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Share
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AwardAchievementModal({
  onClose,
  onAwarded,
}: {
  onClose: () => void;
  onAwarded: (payload: {
    studentId: string;
    title: string;
    achievementType: AchievementType;
    description?: string;
    badgeImageUrl?: string;
  }) => Promise<void>;
}) {
  const [studentId, setStudentId] = useState('');
  const [title, setTitle] = useState('');
  const [achievementType, setAchievementType] = useState<AchievementType>('ACADEMIC');
  const [description, setDescription] = useState('');
  const [badgeImageUrl, setBadgeImageUrl] = useState('');

  return (
    <Modal open={true} title="Award achievement" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700">Student ID</label>
          <input
            type="text"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            placeholder="UUID of the sis_students row"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700">Type</label>
          <select
            value={achievementType}
            onChange={(e) => setAchievementType(e.target.value as AchievementType)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            {ACHIEVEMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACHIEVEMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700">Badge image URL</label>
          <input
            type="url"
            value={badgeImageUrl}
            onChange={(e) => setBadgeImageUrl(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!studentId || !title}
            onClick={() =>
              onAwarded({
                studentId,
                title,
                achievementType,
                description: description || undefined,
                badgeImageUrl: badgeImageUrl || undefined,
              })
            }
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Award
          </button>
        </div>
      </div>
    </Modal>
  );
}
