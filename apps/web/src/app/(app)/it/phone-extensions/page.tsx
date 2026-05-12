'use client';

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCreateItPhoneExtension,
  useItPhoneExtensions,
  useUnassignItPhoneExtension,
} from '@/hooks/use-it-advanced';
import {
  IT_PHONE_EXTENSION_LABELS,
  IT_PHONE_EXTENSION_PILL,
  IT_PHONE_EXTENSION_TYPES,
} from '@/lib/it-advanced-format';
import type { ItPhoneExtensionType } from '@/lib/types';

export default function PhoneExtensionsPage() {
  const user = useAuthStore((s) => s.user);
  const canWrite = hasAnyPermission(user, ['it-007:write']);
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const extensions = useItPhoneExtensions({
    search: search.trim() || undefined,
    department: department.trim() || undefined,
    includeInactive: showInactive,
  });
  const create = useCreateItPhoneExtension();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<{
    extensionNumber: string;
    extensionType: ItPhoneExtensionType;
    displayName: string;
    location: string;
    department: string;
  }>({
    extensionNumber: '',
    extensionType: 'DESK',
    displayName: '',
    location: '',
    department: '',
  });

  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const ext of extensions.data ?? []) {
      if (ext.department) set.add(ext.department);
    }
    return Array.from(set).sort();
  }, [extensions.data]);

  const submit = async () => {
    if (!form.extensionNumber.trim()) {
      toast('Extension number required.', 'warning');
      return;
    }
    try {
      await create.mutateAsync({
        extensionNumber: form.extensionNumber.trim(),
        extensionType: form.extensionType,
        displayName: form.displayName.trim() || undefined,
        location: form.location.trim() || undefined,
        department: form.department.trim() || undefined,
      });
      toast('Extension created.', 'success');
      setForm({
        extensionNumber: '',
        extensionType: 'DESK',
        displayName: '',
        location: '',
        department: '',
      });
      setModalOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create extension', 'error');
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHeader
        title="VOIP directory"
        description="Phone extensions assigned to staff and shared spaces"
      />
      <div className="rounded-md border border-gray-200 bg-white p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Search</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, extension, location…"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Department</label>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="">All</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Include inactive
            </label>
            {canWrite ? (
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
              >
                Add extension
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Ext</th>
              <th className="p-3">Type</th>
              <th className="p-3">Assigned to</th>
              <th className="p-3">Display name</th>
              <th className="p-3">Location</th>
              <th className="p-3">Department</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {extensions.data?.map((e) => (
              <tr key={e.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-3 font-mono font-semibold">{e.extensionNumber}</td>
                <td className="p-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${IT_PHONE_EXTENSION_PILL[e.extensionType]}`}
                  >
                    {IT_PHONE_EXTENSION_LABELS[e.extensionType]}
                  </span>
                </td>
                <td className="p-3 text-gray-700">{e.assignedToName ?? '—'}</td>
                <td className="p-3 text-gray-700">{e.displayName ?? '—'}</td>
                <td className="p-3 text-gray-700">{e.location ?? '—'}</td>
                <td className="p-3 text-gray-700">{e.department ?? '—'}</td>
                <td className="p-3 text-right">
                  {canWrite && e.assignedTo ? (
                    <UnassignButton id={e.id} />
                  ) : !e.isActive ? (
                    <span className="text-xs text-gray-400">Inactive</span>
                  ) : null}
                </td>
              </tr>
            ))}
            {!extensions.isLoading && (extensions.data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-sm text-gray-500">
                  No extensions match the filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add extension"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={create.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-campus-700"
            >
              Add
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Extension #</label>
              <input
                value={form.extensionNumber}
                onChange={(e) => setForm({ ...form, extensionNumber: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
                placeholder="1010"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Type</label>
              <select
                value={form.extensionType}
                onChange={(e) =>
                  setForm({ ...form, extensionType: e.target.value as ItPhoneExtensionType })
                }
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {IT_PHONE_EXTENSION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {IT_PHONE_EXTENSION_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Display name</label>
              <input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="Front Desk"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Department</label>
              <input
                value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="Administration"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Location</label>
            <input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="Main office"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function UnassignButton({ id }: { id: string }) {
  const unassign = useUnassignItPhoneExtension(id);
  const { toast } = useToast();
  const run = async () => {
    if (!window.confirm('Unassign this extension?')) return;
    try {
      await unassign.mutateAsync();
      toast('Extension unassigned.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not unassign', 'error');
    }
  };
  return (
    <button
      type="button"
      onClick={run}
      className="text-xs font-medium text-rose-700 hover:underline"
    >
      Unassign
    </button>
  );
}
