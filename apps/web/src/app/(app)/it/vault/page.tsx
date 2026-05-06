'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useItVault, useItVaultEntry } from '@/hooks/use-it';
import { IT_TIER_LABELS, IT_TIER_PILL, formatItDate, formatItDateTime } from '@/lib/it-format';

/**
 * /it/vault — credential vault SECURITY KEYSTONE UI.
 *
 * The summary list never shows passwords. Clicking a row opens
 * the detail panel which calls /it/vault/:id — this is the
 * keystone path: the API decrypts the password (refusing if the
 * caller's tier is below the credential tier) AND writes a VIEW
 * row to tech_credential_access_log inside the same tenant tx.
 *
 * The "Reveal password" button toggles whether the plaintext is
 * shown on screen. The detail fetch already happened — the
 * audit row already landed — but hiding by default keeps the
 * password off bystanders' shoulders.
 */
export default function VaultPage() {
  const list = useItVault();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const detail = useItVaultEntry(selectedId);

  function selectEntry(id: string) {
    setSelectedId(id);
    setRevealed(false);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader
        title="Credential Vault"
        description="AES-256-GCM encrypted shared service credentials. Tiered access — STANDARD / ELEVATED / CRITICAL. Every read writes an audit log row."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="p-3">Service</th>
                <th className="p-3">Type</th>
                <th className="p-3">Tier</th>
                <th className="p-3">Rotation due</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.map((c) => (
                <tr
                  key={c.id}
                  className={`cursor-pointer border-t border-gray-100 hover:bg-gray-50 ${
                    selectedId === c.id ? 'bg-campus-50' : ''
                  }`}
                  onClick={() => selectEntry(c.id)}
                >
                  <td className="p-3 font-medium">{c.serviceName}</td>
                  <td className="p-3 text-xs uppercase text-gray-600">
                    {c.credentialType.replace('_', ' ')}
                  </td>
                  <td className="p-3">
                    <span className={`rounded px-2 py-0.5 text-xs ${IT_TIER_PILL[c.accessTier]}`}>
                      {IT_TIER_LABELS[c.accessTier]}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-gray-500">{formatItDate(c.rotationDueAt)}</td>
                </tr>
              ))}
              {!list.isLoading && (list.data?.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-sm text-gray-500">
                    {list.error
                      ? 'Insufficient permissions on the credential vault.'
                      : 'No vault entries.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-gray-200 bg-white p-4">
          {!selectedId ? (
            <p className="text-sm text-gray-500">
              Select a credential on the left to view details.
            </p>
          ) : detail.isLoading ? (
            <p className="text-sm text-gray-500">Decrypting…</p>
          ) : detail.error ? (
            <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              <p className="font-semibold">Access denied.</p>
              <p className="mt-1 text-xs">
                Your access tier is below this credential&apos;s required tier. Ask a CRITICAL-tier
                IT admin or school admin to retrieve it for you.
              </p>
            </div>
          ) : detail.data ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">{detail.data.serviceName}</h2>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${IT_TIER_PILL[detail.data.accessTier]}`}
                >
                  {IT_TIER_LABELS[detail.data.accessTier]}
                </span>
              </div>
              {detail.data.url ? (
                <p>
                  <span className="text-xs uppercase text-gray-500">URL</span>
                  <br />
                  <a
                    href={detail.data.url}
                    className="text-campus-700 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {detail.data.url}
                  </a>
                </p>
              ) : null}
              {detail.data.username ? (
                <p>
                  <span className="text-xs uppercase text-gray-500">Username</span>
                  <br />
                  <span className="font-mono">{detail.data.username}</span>
                </p>
              ) : null}
              <div>
                <p className="text-xs uppercase text-gray-500">Password</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 rounded bg-gray-50 p-2 font-mono text-sm">
                    {revealed
                      ? detail.data.password
                      : '•'.repeat(Math.min(detail.data.password.length, 24))}
                  </code>
                  <button
                    type="button"
                    onClick={() => setRevealed((r) => !r)}
                    className="rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
                  >
                    {revealed ? 'Hide' : 'Reveal'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-amber-700">
                  ⚠️ Viewing this credential was logged to the access log.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-gray-100 pt-3 text-xs text-gray-600">
                <p>Last rotated: {formatItDateTime(detail.data.lastRotatedAt)}</p>
                <p>Rotation due: {formatItDate(detail.data.rotationDueAt)}</p>
                <p>Expiry: {formatItDate(detail.data.expiryDate)}</p>
                <p>Updated: {formatItDateTime(detail.data.updatedAt)}</p>
              </div>
              {detail.data.notes ? (
                <p className="rounded bg-gray-50 p-2 text-xs text-gray-700">{detail.data.notes}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
