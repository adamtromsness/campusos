'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateRoom, useRooms } from '@/hooks/use-scheduling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { ROOM_TYPES, roomTypeLabel } from '@/lib/scheduling-format';
import type { CreateRoomPayload, RoomType } from '@/lib/types';

export default function RoomsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [filterType, setFilterType] = useState<RoomType | ''>('');
  const rooms = useRooms({ includeInactive, roomType: filterType || undefined }, !!user);
  const create = useCreateRoom();
  const { toast } = useToast();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>('CLASSROOM');
  const [capacity, setCapacity] = useState<string>('');
  const [building, setBuilding] = useState('');
  const [floor, setFloor] = useState('');
  const [hasProjector, setHasProjector] = useState(false);
  const [hasAv, setHasAv] = useState(false);

  if (!user) return null;

  function resetForm() {
    setName('');
    setRoomType('CLASSROOM');
    setCapacity('');
    setBuilding('');
    setFloor('');
    setHasProjector(false);
    setHasAv(false);
  }

  async function onCreate() {
    if (!name.trim()) return;
    const payload: CreateRoomPayload = {
      name: name.trim(),
      roomType,
      hasProjector,
      hasAv,
    };
    if (capacity.trim()) {
      const n = Number(capacity);
      if (!Number.isInteger(n) || n < 0) {
        toast('Capacity must be a non-negative whole number.', 'error');
        return;
      }
      payload.capacity = n;
    }
    if (building.trim()) payload.building = building.trim();
    if (floor.trim()) payload.floor = floor.trim();
    try {
      await create.mutateAsync(payload);
      toast('Room created', 'success');
      setShowCreate(false);
      resetForm();
    } catch (e: any) {
      toast(e?.message || 'Could not create room', 'error');
    }
  }

  const list = rooms.data ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Rooms"
        description="Classrooms, labs, halls, and other bookable spaces."
        actions={
          isAdmin ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              New room
            </button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as RoomType | '')}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="">All types</option>
          {ROOM_TYPES.map((t) => (
            <option key={t} value={t}>
              {roomTypeLabel(t)}
            </option>
          ))}
        </select>
        {isAdmin && (
          <label className="inline-flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
            />
            Include inactive
          </label>
        )}
      </div>

      {rooms.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : rooms.isError ? (
        <EmptyState
          title="Couldn't load rooms"
          description="Try refreshing the page."
        />
      ) : list.length === 0 ? (
        <EmptyState
          title="No rooms found"
          description={isAdmin ? 'Add the first room to get started.' : 'Rooms have not been configured yet.'}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">{r.name}</p>
                  <p className="text-xs text-gray-500">
                    {roomTypeLabel(r.roomType)}
                    {r.capacity !== null && ` · capacity ${r.capacity}`}
                  </p>
                </div>
                {!r.isActive && (
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                    Inactive
                  </span>
                )}
              </div>
              {(r.building || r.floor) && (
                <p className="mt-2 text-xs text-gray-500">
                  {[r.building, r.floor].filter(Boolean).join(' · ')}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {r.hasProjector && (
                  <span className="rounded-full bg-campus-100 px-2 py-0.5 text-[10px] font-medium text-campus-700">
                    Projector
                  </span>
                )}
                {r.hasAv && (
                  <span className="rounded-full bg-campus-100 px-2 py-0.5 text-[10px] font-medium text-campus-700">
                    AV
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Link
                  href={`/schedule/timetable?roomId=${r.id}`}
                  className="text-xs font-medium text-campus-700 hover:text-campus-800"
                >
                  View weekly schedule →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New room"
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
              placeholder="e.g. Room 107"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Type</span>
              <select
                value={roomType}
                onChange={(e) => setRoomType(e.target.value as RoomType)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              >
                {ROOM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {roomTypeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Capacity</span>
              <input
                type="number"
                min={0}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                placeholder="optional"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Building</span>
              <input
                value={building}
                onChange={(e) => setBuilding(e.target.value)}
                placeholder="optional"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Floor</span>
              <input
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                placeholder="optional"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
          </div>
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasProjector}
                onChange={(e) => setHasProjector(e.target.checked)}
                className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
              />
              <span className="text-gray-700">Projector</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasAv}
                onChange={(e) => setHasAv(e.target.checked)}
                className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
              />
              <span className="text-gray-700">AV</span>
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
