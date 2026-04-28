'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useBellSchedules,
  useCreateBellSchedule,
  useSetDefaultBellSchedule,
} from '@/hooks/use-scheduling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { scheduleTypeLabel } from '@/lib/scheduling-format';
import type { BellScheduleType, CreateBellSchedulePayload } from '@/lib/types';

const SCHEDULE_TYPES: BellScheduleType[] = [
  'STANDARD',
  'EARLY_DISMISSAL',
  'ASSEMBLY',
  'EXAM',
  'CUSTOM',
];

export default function BellSchedulesPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const schedules = useBellSchedules(!!user);
  const create = useCreateBellSchedule();
  const setDefault = useSetDefaultBellSchedule();
  const { toast } = useToast();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [scheduleType, setScheduleType] = useState<BellScheduleType>('STANDARD');
  const [makeDefault, setMakeDefault] = useState(false);

  if (!user) return null;

  function resetForm() {
    setName('');
    setScheduleType('STANDARD');
    setMakeDefault(false);
  }

  async function onCreate() {
    if (!name.trim()) return;
    const payload: CreateBellSchedulePayload = {
      name: name.trim(),
      scheduleType,
      isDefault: makeDefault,
    };
    try {
      await create.mutateAsync(payload);
      toast('Bell schedule created', 'success');
      setShowCreate(false);
      resetForm();
    } catch (e: any) {
      toast(e?.message || 'Could not create schedule', 'error');
    }
  }

  async function onSetDefault(id: string) {
    try {
      await setDefault.mutateAsync(id);
      toast('Default schedule updated', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not set default', 'error');
    }
  }

  const list = schedules.data ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Bell Schedules"
        description="Define the period grid for school days. Mark one as default — it drives the timetable."
        actions={
          isAdmin ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              New schedule
            </button>
          ) : undefined
        }
      />

      {schedules.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : schedules.isError ? (
        <EmptyState
          title="Couldn't load schedules"
          description="Try refreshing the page. If the issue persists, contact a school admin."
        />
      ) : list.length === 0 ? (
        <EmptyState
          title="No bell schedules yet"
          description="Create the school's first bell schedule to define the period grid."
        />
      ) : (
        <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white shadow-sm">
          {list.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <Link href={`/schedule/bell-schedules/${s.id}`} className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-900">{s.name}</p>
                <p className="text-xs text-gray-500">
                  {scheduleTypeLabel(s.scheduleType)} · {s.periods.length} periods
                </p>
              </Link>
              <div className="flex items-center gap-2">
                {s.isDefault ? (
                  <span className="rounded-full bg-campus-100 px-2 py-0.5 text-xs font-medium text-campus-700">
                    Default
                  </span>
                ) : isAdmin ? (
                  <button
                    type="button"
                    onClick={() => onSetDefault(s.id)}
                    disabled={setDefault.isPending}
                    className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
                  >
                    Set default
                  </button>
                ) : null}
                <Link
                  href={`/schedule/bell-schedules/${s.id}`}
                  className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                >
                  {isAdmin ? 'Edit' : 'View'}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New bell schedule"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onCreate}
              disabled={create.isPending || !name.trim()}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Standard Day"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Type</span>
            <select
              value={scheduleType}
              onChange={(e) => setScheduleType(e.target.value as BellScheduleType)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              {SCHEDULE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {scheduleTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
              className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
            />
            <span className="text-gray-700">Make this the school default</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}
