'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateGroup, useGroups, useJoinGroup, useMyPendingTransfers } from '@/hooks/use-groups';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  POLICY_LABEL,
  POLICY_PILL,
  ROLE_LABEL,
  ROLE_PILL,
  SCOPE_LABEL,
  SCOPE_PILL,
  formatRelativeDate,
} from '@/lib/groups-format';
import type { GroupScopeType, JoinPolicy } from '@/lib/types';

export default function GroupsLandingPage() {
  const user = useAuthStore((s) => s.user);
  const canWrite = !!user && hasAnyPermission(user, ['grp-001:write']);
  const [scopeFilter, setScopeFilter] = useState<GroupScopeType | 'ALL'>('ALL');
  const [showCreate, setShowCreate] = useState(false);
  const groupsQ = useGroups(
    { status: 'ACTIVE', scopeType: scopeFilter === 'ALL' ? undefined : scopeFilter },
    !!user,
  );
  const transfersQ = useMyPendingTransfers(!!user);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Groups & communities"
        description="Browse groups across the school. Join open groups or request to join those that require approval."
      />

      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/groups/my" className="rounded-full px-3 py-1.5 hover:bg-gray-100">
            My groups →
          </Link>
          <Link href="/groups/feed" className="rounded-full px-3 py-1.5 hover:bg-gray-100">
            My feed →
          </Link>
        </div>
        {canWrite ? (
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            New group
          </button>
        ) : null}
      </div>

      {transfersQ.data && transfersQ.data.length > 0 ? (
        <section className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-amber-800">
            Ownership transfers awaiting your response
          </h2>
          <ul className="space-y-1 text-sm">
            {transfersQ.data.map((t) => (
              <li key={t.id}>
                <Link href={`/groups/${t.groupId}`} className="text-amber-700 hover:underline">
                  {t.fromName} → you · expires {formatRelativeDate(t.expiresAt)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {(['ALL', 'CLASS', 'YEAR_GROUP', 'SCHOOL', 'CUSTOM', 'ACTIVITY'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScopeFilter(s)}
            className={`rounded-full border px-3 py-1 text-sm ${
              scopeFilter === s
                ? 'border-campus-600 bg-campus-50 text-campus-700'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {s === 'ALL' ? 'All' : SCOPE_LABEL[s]}
          </button>
        ))}
      </div>

      {groupsQ.isLoading ? (
        <LoadingSpinner />
      ) : groupsQ.data && groupsQ.data.length > 0 ? (
        <ul className="grid gap-3">
          {groupsQ.data.map((g) => (
            <li key={g.id}>
              <Link
                href={`/groups/${g.id}`}
                className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-campus-300 hover:bg-campus-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">{g.name}</h3>
                    {g.description ? (
                      <p className="text-sm text-gray-600">{g.description}</p>
                    ) : null}
                    {g.scopeLabel ? (
                      <p className="mt-1 text-xs text-gray-500">{g.scopeLabel}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${SCOPE_PILL[g.scopeType]}`}
                    >
                      {SCOPE_LABEL[g.scopeType]}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${POLICY_PILL[g.joinPolicy]}`}
                    >
                      {POLICY_LABEL[g.joinPolicy]}
                    </span>
                    {g.myMembership ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_PILL[g.myMembership.role]}`}
                      >
                        {ROLE_LABEL[g.myMembership.role]}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="text-xs text-gray-500">
                  {g.memberCount} members
                  {g.pendingCount > 0 ? ` · ${g.pendingCount} pending` : ''}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No groups yet" />
      )}

      {showCreate ? <CreateGroupModal onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

function CreateGroupModal({ onClose }: { onClose: () => void }) {
  const create = useCreateGroup();
  const { toast: showToast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scopeType, setScopeType] = useState<GroupScopeType>('CUSTOM');
  const [scopeId, setScopeId] = useState('');
  const [policy, setPolicy] = useState<JoinPolicy>('OPEN');
  const needsScopeId = scopeType !== 'SCHOOL' && scopeType !== 'CUSTOM';

  const submit = async () => {
    if (!name.trim()) return;
    if (needsScopeId && !scopeId.trim()) {
      showToast('scopeId is required for ' + scopeType + ' groups', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        scopeType,
        scopeId: needsScopeId ? scopeId.trim() : undefined,
        joinPolicy: policy,
      });
      showToast('Group created', 'success');
      onClose();
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  };

  return (
    <Modal open onClose={onClose} title="New group" size="md">
      <div className="space-y-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Scope">
          <select
            value={scopeType}
            onChange={(e) => setScopeType(e.target.value as GroupScopeType)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="SCHOOL">School-wide</option>
            <option value="CUSTOM">Custom (no specific binding)</option>
            <option value="CLASS">Class</option>
            <option value="YEAR_GROUP">Year group</option>
            <option value="ACTIVITY">Activity</option>
          </select>
        </Field>
        {needsScopeId ? (
          <Field label="Target ID (UUID)">
            <input
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              placeholder="paste the matching ID for this scope"
              className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
            />
          </Field>
        ) : null}
        <Field label="Join policy">
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value as JoinPolicy)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="OPEN">Open — anyone can join</option>
            <option value="APPROVAL_REQUIRED">Approval required</option>
            <option value="INVITE_ONLY">Invite only</option>
          </select>
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={create.isPending || !name.trim()}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

// Suppress unused import warning for the join hook (may be used in
// future iterations of the landing page when self-service join lands
// from the row card).
void useJoinGroup;
