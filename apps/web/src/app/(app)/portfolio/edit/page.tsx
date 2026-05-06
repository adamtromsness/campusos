'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, Modal, useToast } from '@/components/ui';
import {
  useMyPortfolio,
  useUpdatePortfolio,
  useAddPortfolioItem,
  useUpdatePortfolioItem,
  useRemovePortfolioItem,
  useItemSources,
  usePortfolioShares,
  useCreateShare,
  useRevokeShare,
} from '@/hooks/use-portfolio';
import {
  ITEM_TYPE_LABELS,
  ITEM_TYPE_PILL,
  PORTFOLIO_ITEM_TYPES,
  PORTFOLIO_VISIBILITIES,
  SHARE_STATUS_LABELS,
  SHARE_STATUS_PILL,
  VISIBILITY_LABELS,
  VISIBILITY_PILL,
  formatDate,
  formatRelativeShareExpiry,
} from '@/lib/portfolio-format';
import type { PortfolioItemType, PortfolioVisibility } from '@/lib/types';

export default function PortfolioEditPage() {
  const { data: portfolio, isLoading } = useMyPortfolio();
  const { toast } = useToast();
  const updatePortfolio = useUpdatePortfolio(portfolio?.id ?? '');
  const addItem = useAddPortfolioItem(portfolio?.id ?? '');
  const removeItem = useRemovePortfolioItem();
  const updateItem = useUpdatePortfolioItem('');
  const sources = useItemSources(!!portfolio);
  const shares = usePortfolioShares(portfolio?.id ?? null);
  const createShare = useCreateShare(portfolio?.id ?? '');
  const revokeShare = useRevokeShare();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<PortfolioVisibility>('PRIVATE');
  const [synced, setSynced] = useState(false);

  if (!synced && portfolio) {
    setTitle(portfolio.title);
    setDescription(portfolio.description ?? '');
    setVisibility(portfolio.visibility);
    setSynced(true);
  }

  const [showAddItem, setShowAddItem] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  if (isLoading) return <p className="p-6 text-sm text-gray-500">Loading…</p>;
  if (!portfolio) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-gray-500">
          No portfolio yet.{' '}
          <Link href="/portfolio" className="text-campus-700 underline">
            Create one
          </Link>
          .
        </p>
      </div>
    );
  }

  const handleSavePortfolio = async () => {
    try {
      await updatePortfolio.mutateAsync({ title, description, visibility });
      toast('Portfolio saved');
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleToggleFeatured = async (itemId: string, current: boolean) => {
    await fetch(`/api/v1/portfolio-items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isFeatured: !current }),
    });
    // forces re-fetch via cache invalidation
    await updateItem.mutateAsync({ isFeatured: !current }).catch(() => null);
    location.reload();
  };

  const handleRemove = async (itemId: string) => {
    if (!confirm('Remove this item from your portfolio?')) return;
    await removeItem.mutateAsync(itemId);
    toast('Item removed');
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Edit your portfolio"
        description="You control what goes in and who sees it."
      />

      <section className="space-y-3 rounded-md border border-gray-200 bg-white p-4">
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
          <label className="block text-xs font-medium text-gray-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700">Visibility</label>
          <div className="mt-2 space-y-1">
            {PORTFOLIO_VISIBILITIES.map((v) => (
              <label key={v} className="flex items-start gap-2 text-sm">
                <input type="radio" checked={visibility === v} onChange={() => setVisibility(v)} />
                <span>
                  <span
                    className={`mr-2 rounded px-2 py-0.5 text-xs font-medium ${VISIBILITY_PILL[v]}`}
                  >
                    {v}
                  </span>
                  <span className="text-gray-700">{VISIBILITY_LABELS[v]}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={handleSavePortfolio}
          disabled={updatePortfolio.isPending}
          className="rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
        >
          Save changes
        </button>
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Items</h2>
          <button
            type="button"
            onClick={() => setShowAddItem(true)}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Add item
          </button>
        </div>
        {portfolio.items.length === 0 ? (
          <p className="text-sm text-gray-500">No items yet — start curating your work.</p>
        ) : (
          <ul className="space-y-2">
            {portfolio.items.map((it) => (
              <li
                key={it.id}
                className={`rounded-md border p-3 ${it.isFeatured ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200 bg-white'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900">{it.title}</p>
                    {it.sourceTitle && (
                      <p className="text-xs text-gray-500">Source: {it.sourceTitle}</p>
                    )}
                    {it.description && (
                      <p className="mt-1 text-sm text-gray-700">{it.description}</p>
                    )}
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs ${ITEM_TYPE_PILL[it.itemType]}`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => handleToggleFeatured(it.id, it.isFeatured)}
                    className="text-amber-700 hover:underline"
                  >
                    {it.isFeatured ? '★ Featured' : '☆ Feature'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(it.id)}
                    className="text-rose-700 hover:underline"
                  >
                    Remove
                  </button>
                  <span className="text-gray-400">{formatDate(it.addedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Share links
          </h2>
          <button
            type="button"
            onClick={() => setShowShareModal(true)}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Generate link
          </button>
        </div>
        {(shares.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">
            Share links let someone view your portfolio without an account.
          </p>
        ) : (
          <ul className="space-y-2">
            {shares.data!.map((s) => (
              <li key={s.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-gray-700">
                      /portfolio/share/{s.shareToken.slice(0, 12)}…
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {s.recipientEmail ?? 'No recipient'} ·{' '}
                      {formatRelativeShareExpiry(s.expiresAt)}
                      {s.viewedAt ? ` · viewed ${formatDate(s.viewedAt)}` : ' · not yet viewed'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${SHARE_STATUS_PILL[s.status]}`}>
                      {SHARE_STATUS_LABELS[s.status]}
                    </span>
                    {s.status === 'ACTIVE' && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (confirm('Revoke this share link? Anyone using it will get 410 Gone.'))
                            await revokeShare.mutateAsync(s.id);
                        }}
                        className="text-xs text-rose-700 hover:underline"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showAddItem && (
        <AddItemModal
          onClose={() => setShowAddItem(false)}
          sources={sources.data ?? []}
          onAdd={async (payload) => {
            await addItem.mutateAsync(payload);
            toast('Item added');
            setShowAddItem(false);
          }}
        />
      )}

      {showShareModal && (
        <ShareModal
          onClose={() => setShowShareModal(false)}
          onCreate={async (payload) => {
            await createShare.mutateAsync(payload);
            toast('Share link generated');
            setShowShareModal(false);
          }}
        />
      )}
    </div>
  );
}

function AddItemModal({
  onClose,
  sources,
  onAdd,
}: {
  onClose: () => void;
  sources: {
    itemType: PortfolioItemType;
    sourceRefId: string;
    title: string;
    subtitle: string | null;
  }[];
  onAdd: (payload: {
    itemType: PortfolioItemType;
    sourceRefId?: string;
    title: string;
    description?: string;
    isFeatured?: boolean;
  }) => Promise<void>;
}) {
  const [itemType, setItemType] = useState<PortfolioItemType>('REFLECTION');
  const [sourceRefId, setSourceRefId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const sourceCandidates = sources.filter((s) => s.itemType === itemType);

  return (
    <Modal open={true} title="Add item" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700">Type</label>
          <select
            value={itemType}
            onChange={(e) => {
              setItemType(e.target.value as PortfolioItemType);
              setSourceRefId('');
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            {PORTFOLIO_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {ITEM_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {sourceCandidates.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-700">
              Source ({sourceCandidates.length} available)
            </label>
            <select
              value={sourceRefId}
              onChange={(e) => {
                setSourceRefId(e.target.value);
                const m = sourceCandidates.find((s) => s.sourceRefId === e.target.value);
                if (m && !title) setTitle(m.title);
              }}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="">— Pick —</option>
              {sourceCandidates.map((s) => (
                <option key={s.sourceRefId} value={s.sourceRefId}>
                  {s.title}
                  {s.subtitle ? ` · ${s.subtitle}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

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
          <label className="block text-xs font-medium text-gray-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
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
            disabled={!title}
            onClick={() =>
              onAdd({
                itemType,
                sourceRefId: sourceRefId || undefined,
                title,
                description: description || undefined,
              })
            }
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ShareModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (payload: { expiresAt?: string; recipientEmail?: string }) => Promise<void>;
}) {
  const [expiresAt, setExpiresAt] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');

  return (
    <Modal open={true} title="Generate share link" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Anyone with this link can view your portfolio — even without an account. Choose an expiry
          date for safety.
        </p>
        <div>
          <label className="block text-xs font-medium text-gray-700">Expires (optional)</label>
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700">
            Recipient email (optional)
          </label>
          <input
            type="email"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            placeholder="grandma@example.com"
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
            onClick={() =>
              onCreate({
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
                recipientEmail: recipientEmail || undefined,
              })
            }
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Generate
          </button>
        </div>
      </div>
    </Modal>
  );
}
