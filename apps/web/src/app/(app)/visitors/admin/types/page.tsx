'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateVisitorType, useUpdateVisitorType, useVisitorTypes } from '@/hooks/use-visitors';
import type { CreateVisitorTypePayload, VisitorBadgeColor, VisitorTypeDto } from '@/lib/types';
import { BADGE_COLORS, BADGE_COLOR_PILL } from '@/lib/visitors-format';

export default function VisitorTypesAdminPage() {
  const typesQ = useVisitorTypes(true);
  const createType = useCreateVisitorType();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<VisitorTypeDto | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visitor types"
        description="Per-school visitor categories. requiresSafeguardingCheck drives the kiosk safeguarding gate."
      />

      <div className="flex justify-end">
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-800"
        >
          + Add visitor type
        </button>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {typesQ.isLoading ? (
          <LoadingSpinner />
        ) : typesQ.data && typesQ.data.length > 0 ? (
          <ul className="divide-y divide-gray-100">
            {typesQ.data.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 p-4">
                <div className="flex items-center gap-3">
                  <span
                    className={
                      'inline-flex rounded px-2 py-0.5 text-xs font-medium ' +
                      (BADGE_COLOR_PILL[t.badgeColor] ?? '')
                    }
                  >
                    {t.name}
                  </span>
                  <div className="text-sm text-gray-700">
                    {t.requiresSafeguardingCheck
                      ? 'Safeguarding required'
                      : 'Safeguarding not required'}
                    {!t.isActive && <span className="ml-2 text-gray-500">(inactive)</span>}
                  </div>
                </div>
                <button
                  onClick={() => setEditing(t)}
                  className="text-sm font-medium text-campus-700 hover:underline"
                >
                  Edit
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No visitor types yet" description="Add one to get started." />
        )}
      </div>

      {showAdd && (
        <TypeModal
          onClose={() => setShowAdd(false)}
          onSubmit={async (payload) => {
            try {
              await createType.mutateAsync(payload);
              toast('Visitor type added', 'success');
              setShowAdd(false);
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
        />
      )}
      {editing && <EditTypeModal type={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TypeModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (payload: CreateVisitorTypePayload) => void;
}) {
  const [name, setName] = useState('');
  const [requires, setRequires] = useState(true);
  const [color, setColor] = useState<VisitorBadgeColor>('blue');
  return (
    <Modal
      open
      onClose={onClose}
      title="Add visitor type"
      footer={
        <>
          <button onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={() =>
              onSubmit({
                name: name.trim(),
                requiresSafeguardingCheck: requires,
                badgeColor: color,
              })
            }
            className="rounded bg-campus-700 px-3 py-1.5 text-sm text-white"
          >
            Add
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          type="text"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          value={color}
          onChange={(e) => setColor(e.target.value as VisitorBadgeColor)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        >
          {BADGE_COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requires}
            onChange={(e) => setRequires(e.target.checked)}
          />
          Requires safeguarding check
        </label>
      </div>
    </Modal>
  );
}

function EditTypeModal({ type, onClose }: { type: VisitorTypeDto; onClose: () => void }) {
  const update = useUpdateVisitorType(type.id);
  const { toast } = useToast();
  const [name, setName] = useState(type.name);
  const [requires, setRequires] = useState(type.requiresSafeguardingCheck);
  const [color, setColor] = useState<VisitorBadgeColor>(type.badgeColor);
  const [isActive, setIsActive] = useState(type.isActive);
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit visitor type"
      footer={
        <>
          <button onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={async () => {
              try {
                await update.mutateAsync({
                  name,
                  requiresSafeguardingCheck: requires,
                  badgeColor: color,
                  isActive,
                });
                toast('Saved', 'success');
                onClose();
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm text-white"
          >
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          value={color}
          onChange={(e) => setColor(e.target.value as VisitorBadgeColor)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        >
          {BADGE_COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requires}
            onChange={(e) => setRequires(e.target.checked)}
          />
          Requires safeguarding check
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Active
        </label>
      </div>
    </Modal>
  );
}
