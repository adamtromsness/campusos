'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useBannedPersons, useCreateBannedPerson } from '@/hooks/use-visitors';
import type { BanType, CreateBannedPersonPayload } from '@/lib/types';
import { BAN_TYPES, BAN_TYPE_LABEL, formatDate } from '@/lib/visitors-format';

/**
 * /visitors/admin/banned — banned persons management.
 *
 * RESTRICTED — gated on safeguarding_ban:read which only School Admin
 * and Platform Admin hold via everyFunction. Reception staff cannot
 * reach this surface; they only see the silent BLOCKED kiosk outcome.
 */
export default function BannedPersonsPage() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const bannedQ = useBannedPersons(includeInactive);
  const createBan = useCreateBannedPerson();

  const canRead = user ? hasAnyPermission(user, ['safeguarding_ban:read']) : false;

  if (user && !canRead) {
    return (
      <div className="space-y-6">
        <PageHeader title="Banned persons" />
        <EmptyState
          title="Restricted"
          description="The banned-persons registry is restricted to School Admin only. Speak with your safeguarding officer if you believe you should have access."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Banned persons"
        description="Court orders, safeguarding bans, and restraining orders. Consulted by the kiosk on every sign-in via HMAC name_hash blind-index match."
      />

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-800"
        >
          + Add banned person
        </button>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {bannedQ.isLoading ? (
          <LoadingSpinner />
        ) : bannedQ.data && bannedQ.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <th className="py-2 px-3">Name</th>
                <th className="py-2 px-3">DOB</th>
                <th className="py-2 px-3">Type</th>
                <th className="py-2 px-3">Effective</th>
                <th className="py-2 px-3">Last reviewed</th>
                <th className="py-2 px-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {bannedQ.data.map((b) => (
                <tr key={b.id} className="border-b border-gray-100 last:border-0">
                  <td className="py-3 px-3">
                    <div className="font-medium text-gray-900">
                      {b.firstName} {b.lastName}
                    </div>
                    <div className="text-xs text-gray-500 line-clamp-2">{b.banReason}</div>
                  </td>
                  <td className="py-3 px-3 text-gray-700">{b.dateOfBirth ?? '—'}</td>
                  <td className="py-3 px-3">
                    <span className="inline-flex rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">
                      {BAN_TYPE_LABEL[b.banType]}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-gray-700">
                    {formatDate(b.effectiveFrom)} →{' '}
                    {b.effectiveTo ? formatDate(b.effectiveTo) : 'indefinite'}
                  </td>
                  <td className="py-3 px-3 text-gray-700">
                    {b.lastReviewedAt ? formatDate(b.lastReviewedAt) : '—'}
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={
                        b.isActive
                          ? 'inline-flex rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800'
                          : 'inline-flex rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700'
                      }
                    >
                      {b.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No banned persons"
            description="Add a banned person to enable kiosk-level blocking on sign-in."
          />
        )}
      </div>

      {showAdd && (
        <AddBannedModal
          onClose={() => setShowAdd(false)}
          onSubmit={async (payload) => {
            try {
              await createBan.mutateAsync(payload);
              toast('Banned person added', 'success');
              setShowAdd(false);
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function AddBannedModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (payload: CreateBannedPersonPayload) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');
  const [banType, setBanType] = useState<BanType>('SCHOOL_DECISION');
  const [banReason, setBanReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [banOrderS3Key, setBanOrderS3Key] = useState('');

  function handleSubmit() {
    if (banReason.trim().length < 11) {
      alert('Ban reason must be more than 10 characters');
      return;
    }
    if ((banType === 'COURT_ORDER' || banType === 'RESTRAINING_ORDER') && !banOrderS3Key.trim()) {
      alert(BAN_TYPE_LABEL[banType] + ' bans require a supporting document reference');
      return;
    }
    const payload: CreateBannedPersonPayload = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      banType,
      banReason: banReason.trim(),
      effectiveFrom,
    };
    if (dob) payload.dateOfBirth = dob;
    if (banOrderS3Key.trim()) payload.banOrderS3Key = banOrderS3Key.trim();
    onSubmit(payload);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add banned person"
      footer={
        <>
          <button onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="rounded bg-rose-700 px-3 py-1.5 text-sm text-white"
          >
            Add
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <input
            type="text"
            placeholder="First name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <input
          type="date"
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          placeholder="Date of birth"
        />
        <select
          value={banType}
          onChange={(e) => setBanType(e.target.value as BanType)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        >
          {BAN_TYPES.map((t) => (
            <option key={t} value={t}>
              {BAN_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <textarea
          placeholder="Reason (more than 10 characters)"
          value={banReason}
          onChange={(e) => setBanReason(e.target.value)}
          rows={3}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          type="text"
          placeholder="Court order S3 key (required for COURT_ORDER / RESTRAINING_ORDER)"
          value={banOrderS3Key}
          onChange={(e) => setBanOrderS3Key(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono"
        />
        <div>
          <label className="block text-xs text-gray-600 mb-1">Effective from</label>
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </div>
    </Modal>
  );
}
