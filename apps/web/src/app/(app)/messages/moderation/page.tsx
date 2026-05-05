'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import {
  useCreateModerationPolicy,
  useModerationPolicies,
  useUpdateModerationPolicy,
} from '@/hooks/use-moderation';
import type {
  ModerationPolicyAction,
  ModerationPolicyDto,
  ModerationPolicyScope,
} from '@/lib/types';

const ACTION_PILL: Record<ModerationPolicyAction, string> = {
  BLOCK: 'bg-rose-100 text-rose-800',
  FLAG_FOR_REVIEW: 'bg-amber-100 text-amber-800',
  ESCALATE_TO_COUNSELLOR: 'bg-violet-100 text-violet-800',
};

const SCOPE_DESCRIPTION: Record<ModerationPolicyScope, string> = {
  PLATFORM: 'Platform-tier — non-negotiable, seed-only.',
  DISTRICT: 'District-tier — set by the district administrator (read-only here).',
  BUILDING: 'Building-tier — your school can author and manage these.',
};

export default function ModerationPoliciesPage() {
  const [showInactive, setShowInactive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const policiesQ = useModerationPolicies(showInactive);
  const policies = policiesQ.data ?? [];

  const grouped: Record<ModerationPolicyScope, ModerationPolicyDto[]> = {
    PLATFORM: [],
    DISTRICT: [],
    BUILDING: [],
  };
  for (const p of policies) grouped[p.scope].push(p);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Moderation policies"
        description="Three-tier content moderation. Platform and District policies are read-only here. Building-tier policies are edited by school admins."
        actions={
          <div className="flex items-center gap-3">
            <Link
              href="/messages/moderation/queue"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Flagged queue
            </Link>
            <Link
              href="/messages/moderation/log"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Audit log
            </Link>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-800"
            >
              New building policy
            </button>
          </div>
        }
      />

      <label className="mt-3 inline-flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        Show inactive
      </label>

      <div className="mt-6 space-y-6">
        {(['PLATFORM', 'DISTRICT', 'BUILDING'] as const).map((scope) => (
          <section key={scope}>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-gray-900">{scope} tier</h2>
              <span className="text-xs text-gray-500">{SCOPE_DESCRIPTION[scope]}</span>
            </div>
            {grouped[scope].length === 0 ? (
              <EmptyState
                title={'No ' + scope.toLowerCase() + ' policies'}
                description={
                  scope === 'BUILDING'
                    ? 'Author a school-specific policy to extend the platform/district defaults.'
                    : 'Higher-tier policies will appear here when configured.'
                }
              />
            ) : (
              <div className="space-y-2">
                {grouped[scope].map((p) => (
                  <PolicyRow key={p.id} policy={p} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      {createOpen && <CreatePolicyModal onClose={() => setCreateOpen(false)} />}
    </div>
  );
}

function PolicyRow({ policy }: { policy: ModerationPolicyDto }) {
  const [editOpen, setEditOpen] = useState(false);
  const update = useUpdateModerationPolicy(policy.id);
  const pill = ACTION_PILL[policy.keywordAction];
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + pill}>
              {policy.keywordAction}
            </span>
            {!policy.isActive && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-600">
                Inactive
              </span>
            )}
            {policy.name && <h3 className="text-sm font-semibold text-gray-900">{policy.name}</h3>}
          </div>
          {policy.description && <p className="mt-1 text-sm text-gray-600">{policy.description}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {policy.keywords.map((kw) => (
              <span
                key={kw}
                className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700"
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {policy.isEditable && (
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Edit
            </button>
          )}
          {policy.isEditable && (
            <button
              type="button"
              onClick={() => update.mutate({ isActive: !policy.isActive })}
              disabled={update.isPending}
              className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {policy.isActive ? 'Deactivate' : 'Activate'}
            </button>
          )}
        </div>
      </div>
      {editOpen && policy.isEditable && (
        <EditPolicyModal policy={policy} onClose={() => setEditOpen(false)} />
      )}
    </div>
  );
}

function CreatePolicyModal({ onClose }: { onClose: () => void }) {
  const create = useCreateModerationPolicy();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [keywordAction, setKeywordAction] = useState<ModerationPolicyAction>('FLAG_FOR_REVIEW');

  async function submit() {
    const list = keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!name || list.length === 0) return;
    await create.mutateAsync({
      name,
      description: description || undefined,
      keywords: list,
      keywordAction,
    });
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New building moderation policy"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending || !name || !keywords.trim()}
            className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create policy'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
          />
        </Field>
        <Field label="Keywords (comma-separated)">
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
            placeholder="bullying, gun, threat"
          />
        </Field>
        <Field label="Action">
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {(['BLOCK', 'FLAG_FOR_REVIEW', 'ESCALATE_TO_COUNSELLOR'] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setKeywordAction(a)}
                className={
                  'rounded-md border px-3 py-2 text-sm font-semibold transition ' +
                  (keywordAction === a
                    ? 'border-campus-700 bg-campus-50 text-campus-900'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
                }
              >
                {a.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function EditPolicyModal({
  policy,
  onClose,
}: {
  policy: ModerationPolicyDto;
  onClose: () => void;
}) {
  const update = useUpdateModerationPolicy(policy.id);
  const [name, setName] = useState(policy.name ?? '');
  const [description, setDescription] = useState(policy.description ?? '');
  const [keywords, setKeywords] = useState(policy.keywords.join(', '));
  const [keywordAction, setKeywordAction] = useState<ModerationPolicyAction>(policy.keywordAction);

  async function submit() {
    const list = keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    await update.mutateAsync({
      name,
      description: description || undefined,
      keywords: list,
      keywordAction,
    });
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit policy"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={update.isPending}
            className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
          />
        </Field>
        <Field label="Keywords (comma-separated)">
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
          />
        </Field>
        <Field label="Action">
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {(['BLOCK', 'FLAG_FOR_REVIEW', 'ESCALATE_TO_COUNSELLOR'] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setKeywordAction(a)}
                className={
                  'rounded-md border px-3 py-2 text-sm font-semibold transition ' +
                  (keywordAction === a
                    ? 'border-campus-700 bg-campus-50 text-campus-900'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
                }
              >
                {a.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}
