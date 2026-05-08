'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/lib/api-client';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useFacCreateBuilding,
  useFacCreateSpace,
  useFacUpdateBuilding,
  useFacUpdateSpace,
} from '@/hooks/use-facilities';
import {
  useDeleteBuilding,
  useDeleteSpace,
  useFacilityTree,
  useImportRooms,
  type FacilityTreeBuildingDto,
  type FacilityTreeSpaceDto,
  type ImportRoomRow,
  type ImportRoomsResponseDto,
} from '@/hooks/use-configuration';

/**
 * Step 2 — Facility Structure Manager.
 *
 * Two-column layout: collapsible tree on the left, detail panel on
 * the right. Add Building / Add Room / Import Rooms modals + delete
 * with dependency check.
 *
 * Per docs/campusos-school-configuration-admin.html step 02. Gated
 * on sys-001:admin (Platform Admin + School Admin via everyFunction).
 */

// ─── Space-type pill palette ─────────────────────────────────────

const SPACE_TYPE_PILL: Record<string, string> = {
  CLASSROOM: 'bg-emerald-100 text-emerald-700',
  GYM: 'bg-violet-100 text-violet-700',
  CAFETERIA: 'bg-amber-100 text-amber-700',
  OFFICE: 'bg-sky-100 text-sky-700',
  STORAGE: 'bg-gray-100 text-gray-700',
  CORRIDOR: 'bg-gray-100 text-gray-600',
  STAIRWELL: 'bg-gray-100 text-gray-600',
  MECHANICAL: 'bg-orange-100 text-orange-700',
  BATHROOM: 'bg-blue-100 text-blue-700',
  GROUNDS: 'bg-lime-100 text-lime-700',
  COMMON_AREA: 'bg-teal-100 text-teal-700',
  OTHER: 'bg-gray-100 text-gray-700',
};

const ALL_SPACE_TYPES = [
  'CLASSROOM',
  'BATHROOM',
  'CORRIDOR',
  'STAIRWELL',
  'MECHANICAL',
  'STORAGE',
  'OFFICE',
  'GROUNDS',
  'COMMON_AREA',
  'GYM',
  'CAFETERIA',
  'OTHER',
];

interface SelectedNode {
  kind: 'building' | 'space';
  id: string;
}

export default function FacilitiesPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const tree = useFacilityTree(isAdmin);

  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [expandedBuildings, setExpandedBuildings] = useState<Set<string>>(new Set());
  const [showAddBuilding, setShowAddBuilding] = useState(false);
  const [showAddRoomFor, setShowAddRoomFor] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  const buildings = tree.data?.buildings ?? [];
  const firstBuildingId = buildings[0]?.id ?? null;

  // Auto-expand the first building once the tree loads so the page is
  // never empty on first paint. Only fires when the set is still empty;
  // user collapses after that are sticky. Hook lives BEFORE any early
  // return so the call order stays stable across renders.
  useEffect(() => {
    if (firstBuildingId && expandedBuildings.size === 0) {
      setExpandedBuildings(new Set([firstBuildingId]));
    }
  }, [firstBuildingId, expandedBuildings.size]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Facility Structure" />
        <EmptyState
          title="Admin access required"
          description="The Facility Manager is gated on the SYS-001:admin permission, held by Platform Admin and School Admin roles."
        />
      </div>
    );
  }

  const selectedBuilding =
    selected?.kind === 'building' ? (buildings.find((b) => b.id === selected.id) ?? null) : null;
  const selectedSpace =
    selected?.kind === 'space'
      ? (buildings
          .flatMap((b) => b.floors.flatMap((f) => f.spaces))
          .find((s) => s.id === selected.id) ?? null)
      : null;
  const selectedSpaceParentBuilding =
    selectedSpace !== null
      ? (buildings.find((b) =>
          b.floors.some((f) => f.spaces.some((s) => s.id === selectedSpace.id)),
        ) ?? null)
      : null;
  // The floor is keyed at the FloorDto level — resolve it for the detail panel.
  const selectedSpaceFloor =
    selectedSpace !== null
      ? (selectedSpaceParentBuilding?.floors.find((f) =>
          f.spaces.some((s) => s.id === selectedSpace.id),
        )?.floor ?? null)
      : null;

  const toggleBuilding = (id: string) => {
    setExpandedBuildings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageHeader title="Facility Structure" />
          <p className="-mt-1 text-sm text-gray-600">
            <Link href="/admin/configuration" className="text-campus-700 hover:underline">
              ← Configuration
            </Link>
            {' · '}Buildings, floors, and rooms.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-campus-300 hover:bg-campus-50"
          >
            Import rooms (CSV)
          </button>
          <button
            type="button"
            onClick={() => setShowAddBuilding(true)}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            + Add building
          </button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[2fr_3fr]">
        {/* Left: tree */}
        <section className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
          {tree.isLoading && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading facility tree…
            </div>
          )}
          {tree.isError && <p className="text-sm text-rose-600">Failed to load tree.</p>}
          {tree.data && (
            <>
              <div className="mb-3 text-sm font-semibold text-gray-900">{tree.data.schoolName}</div>
              {buildings.length === 0 ? (
                <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-600">
                  No buildings yet — start by adding one.
                </p>
              ) : (
                <ul className="space-y-1">
                  {buildings.map((b) => (
                    <BuildingNode
                      key={b.id}
                      building={b}
                      expanded={expandedBuildings.has(b.id)}
                      selectedId={selected?.id ?? null}
                      onToggle={() => toggleBuilding(b.id)}
                      onSelectBuilding={() => setSelected({ kind: 'building', id: b.id })}
                      onSelectSpace={(spaceId) => setSelected({ kind: 'space', id: spaceId })}
                      onAddRoom={() => setShowAddRoomFor(b.id)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {/* Right: detail */}
        <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
          {!selected && (
            <p className="text-sm text-gray-500">
              Select a building or room from the tree on the left to view details.
            </p>
          )}
          {selectedBuilding && (
            <BuildingDetail
              building={selectedBuilding}
              onAddRoom={() => setShowAddRoomFor(selectedBuilding.id)}
              onDeleted={() => setSelected(null)}
            />
          )}
          {selectedSpace && selectedSpaceParentBuilding && (
            <SpaceDetail
              space={selectedSpace}
              floor={selectedSpaceFloor}
              parentBuilding={selectedSpaceParentBuilding}
              onDeleted={() => setSelected(null)}
            />
          )}
        </section>
      </div>

      {showAddBuilding && <AddBuildingModal onClose={() => setShowAddBuilding(false)} />}

      {showAddRoomFor && (
        <AddRoomModal
          buildingId={showAddRoomFor}
          building={buildings.find((b) => b.id === showAddRoomFor) ?? null}
          onClose={() => setShowAddRoomFor(null)}
        />
      )}

      {showImport && <ImportRoomsModal onClose={() => setShowImport(false)} />}
    </div>
  );
}

// ─── Tree nodes ───────────────────────────────────────────────────

function BuildingNode({
  building,
  expanded,
  selectedId,
  onToggle,
  onSelectBuilding,
  onSelectSpace,
  onAddRoom,
}: {
  building: FacilityTreeBuildingDto;
  expanded: boolean;
  selectedId: string | null;
  onToggle: () => void;
  onSelectBuilding: () => void;
  onSelectSpace: (spaceId: string) => void;
  onAddRoom: () => void;
}) {
  const isSelected = selectedId === building.id;
  return (
    <li>
      <div
        className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${
          isSelected ? 'bg-campus-50' : 'hover:bg-gray-50'
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="text-gray-400 hover:text-gray-700"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onSelectBuilding}
          className={`flex flex-1 items-center justify-between gap-2 text-left text-sm ${
            isSelected ? 'font-semibold text-campus-800' : 'font-medium text-gray-800'
          }`}
        >
          <span className="truncate">{building.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-gray-500">
            {building.spaceCount} {building.spaceCount === 1 ? 'space' : 'spaces'}
          </span>
        </button>
        <button
          type="button"
          onClick={onAddRoom}
          className="hidden text-xs text-campus-700 hover:underline group-hover:inline"
          title="Add room to this building"
        >
          + Room
        </button>
      </div>
      {expanded && (
        <ul className="ml-6 mt-1 space-y-1 border-l border-gray-200 pl-2">
          {building.floors.length === 0 && (
            <li className="px-2 py-1 text-xs italic text-gray-500">
              No spaces in this building yet.
            </li>
          )}
          {building.floors.map((floor, idx) => (
            <li key={floor.floor ?? `null-${idx}`}>
              <p className="mt-1 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {floor.floor ? `Floor ${floor.floor}` : 'Unassigned floor'}
              </p>
              <ul className="space-y-0.5">
                {floor.spaces.map((sp) => (
                  <SpaceNode
                    key={sp.id}
                    space={sp}
                    isSelected={selectedId === sp.id}
                    onSelect={() => onSelectSpace(sp.id)}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SpaceNode({
  space,
  isSelected,
  onSelect,
}: {
  space: FacilityTreeSpaceDto;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const pill = SPACE_TYPE_PILL[space.spaceType] ?? 'bg-gray-100 text-gray-700';
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm ${
          isSelected ? 'bg-campus-50 font-semibold text-campus-800' : 'hover:bg-gray-50'
        }`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`truncate ${space.isActive ? '' : 'text-gray-400 line-through'}`}>
            {space.name}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${pill}`}>
            {space.spaceType}
          </span>
        </span>
      </button>
    </li>
  );
}

// ─── Detail panel: Building ──────────────────────────────────────

function BuildingDetail({
  building,
  onAddRoom,
  onDeleted,
}: {
  building: FacilityTreeBuildingDto;
  onAddRoom: () => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const update = useFacUpdateBuilding(building.id);
  const del = useDeleteBuilding();
  const { toast } = useToast();

  // Build a small breakdown by spaceType for the room composition card.
  const breakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of building.floors) {
      for (const s of f.spaces) {
        counts[s.spaceType] = (counts[s.spaceType] ?? 0) + 1;
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [building.floors]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{building.name}</h2>
          <p className="mt-1 text-xs uppercase tracking-wide text-gray-500">Building</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAddRoom}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-campus-300 hover:bg-campus-50"
          >
            + Add room
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-campus-300 hover:bg-campus-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setShowDelete(true)}
            className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
          >
            Delete
          </button>
        </div>
      </div>

      {!editing ? (
        <dl className="grid gap-3 sm:grid-cols-2">
          <DetailRow label="Code" value={building.code ?? '—'} />
          <DetailRow label="Year built" value={building.yearBuilt?.toString() ?? '—'} />
          <DetailRow label="Total floors" value={building.totalFloors?.toString() ?? '—'} />
          <DetailRow
            label="Status"
            value={
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  building.isActive
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {building.isActive ? 'Active' : 'Archived'}
              </span>
            }
          />
        </dl>
      ) : (
        <BuildingEditForm
          building={building}
          onCancel={() => setEditing(false)}
          onSubmit={async (payload) => {
            try {
              await update.mutateAsync(payload);
              toast('Building updated', 'success');
              setEditing(false);
            } catch (e) {
              toast(messageFor(e, 'Update failed'), 'error');
            }
          }}
        />
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Room breakdown</h3>
        {breakdown.length === 0 ? (
          <p className="text-sm text-gray-500">No rooms yet.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {breakdown.map(([type, count]) => (
              <li
                key={type}
                className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2"
              >
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SPACE_TYPE_PILL[type] ?? 'bg-gray-100 text-gray-700'}`}
                >
                  {type}
                </span>
                <span className="text-sm font-semibold tabular-nums text-gray-900">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showDelete && (
        <Modal
          open
          onClose={() => setShowDelete(false)}
          title="Delete building"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
                onClick={() => setShowDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
                disabled={del.isPending}
                onClick={async () => {
                  try {
                    await del.mutateAsync(building.id);
                    toast('Building deleted', 'success');
                    setShowDelete(false);
                    onDeleted();
                  } catch (e) {
                    toast(messageFor(e, 'Delete failed'), 'error');
                  }
                }}
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Delete <strong>{building.name}</strong>?
          </p>
          {building.spaceCount > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              This building has <strong>{building.spaceCount}</strong> spaces. The delete will fail
              — remove all spaces first or archive the building (set inactive).
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function BuildingEditForm({
  building,
  onCancel,
  onSubmit,
}: {
  building: FacilityTreeBuildingDto;
  onCancel: () => void;
  onSubmit: (payload: {
    name?: string;
    code?: string;
    yearBuilt?: number;
    totalFloors?: number;
    isActive?: boolean;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(building.name);
  const [code, setCode] = useState(building.code ?? '');
  const [yearBuilt, setYearBuilt] = useState(building.yearBuilt?.toString() ?? '');
  const [totalFloors, setTotalFloors] = useState(building.totalFloors?.toString() ?? '');
  const [isActive, setIsActive] = useState(building.isActive);
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        await onSubmit({
          name: name !== building.name ? name : undefined,
          code: code !== (building.code ?? '') ? code || undefined : undefined,
          yearBuilt:
            yearBuilt !== (building.yearBuilt?.toString() ?? '')
              ? yearBuilt
                ? Number(yearBuilt)
                : undefined
              : undefined,
          totalFloors:
            totalFloors !== (building.totalFloors?.toString() ?? '')
              ? totalFloors
                ? Number(totalFloors)
                : undefined
              : undefined,
          isActive: isActive !== building.isActive ? isActive : undefined,
        });
        setSubmitting(false);
      }}
    >
      <FormField label="Name" required>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </FormField>
      <FormField label="Code">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Year built">
          <input
            type="number"
            min={1800}
            max={2100}
            value={yearBuilt}
            onChange={(e) => setYearBuilt(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </FormField>
        <FormField label="Total floors">
          <input
            type="number"
            min={1}
            max={200}
            value={totalFloors}
            onChange={(e) => setTotalFloors(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─── Detail panel: Space ─────────────────────────────────────────

function SpaceDetail({
  space,
  floor,
  parentBuilding,
  onDeleted,
}: {
  space: FacilityTreeSpaceDto;
  floor: string | null;
  parentBuilding: FacilityTreeBuildingDto;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const update = useFacUpdateSpace(space.id);
  const del = useDeleteSpace();
  const { toast } = useToast();
  const pill = SPACE_TYPE_PILL[space.spaceType] ?? 'bg-gray-100 text-gray-700';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{space.name}</h2>
          <p className="mt-1 text-xs uppercase tracking-wide text-gray-500">
            Room in {parentBuilding.name}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-campus-300 hover:bg-campus-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setShowDelete(true)}
            className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
          >
            Delete
          </button>
        </div>
      </div>

      {!editing ? (
        <dl className="grid gap-3 sm:grid-cols-2">
          <DetailRow
            label="Type"
            value={
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${pill}`}>
                {space.spaceType}
              </span>
            }
          />
          <DetailRow label="Floor" value={floor ?? '—'} />
          <DetailRow
            label="Area"
            value={space.areaSqft != null ? `${space.areaSqft.toLocaleString()} sqft` : '—'}
          />
          <DetailRow
            label="Status"
            value={
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  space.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {space.isActive ? 'Active' : 'Archived'}
              </span>
            }
          />
          <DetailRow
            label="Scheduling link"
            value={
              space.schRoomId ? (
                <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                  Linked → {space.schRoomName}
                </span>
              ) : (
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                  Not linked
                </span>
              )
            }
          />
          {space.scheduledClassCount > 0 && (
            <DetailRow
              label="Classes scheduled here"
              value={
                <span className="font-semibold text-campus-700">{space.scheduledClassCount}</span>
              }
            />
          )}
        </dl>
      ) : (
        <SpaceEditForm
          space={space}
          floor={floor}
          onCancel={() => setEditing(false)}
          onSubmit={async (payload) => {
            try {
              // Cast spaceType through the FacSpaceType union — the
              // backend CHECK is the actual gate, the web union is just
              // an enum hint.
              await update.mutateAsync(
                payload as unknown as Parameters<typeof update.mutateAsync>[0],
              );
              toast('Room updated', 'success');
              setEditing(false);
            } catch (e) {
              toast(messageFor(e, 'Update failed'), 'error');
            }
          }}
        />
      )}

      {showDelete && (
        <Modal
          open
          onClose={() => setShowDelete(false)}
          title="Delete room"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
                onClick={() => setShowDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
                disabled={del.isPending}
                onClick={async () => {
                  try {
                    await del.mutateAsync(space.id);
                    toast('Room deleted', 'success');
                    setShowDelete(false);
                    onDeleted();
                  } catch (e) {
                    toast(messageFor(e, 'Delete failed'), 'error');
                  }
                }}
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Delete <strong>{space.name}</strong> in <strong>{parentBuilding.name}</strong>?
          </p>
          {space.scheduledClassCount > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              This room has <strong>{space.scheduledClassCount}</strong> active class
              {space.scheduledClassCount === 1 ? '' : 'es'} scheduled here. The delete will fail —
              reassign or remove those classes first.
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function SpaceEditForm({
  space,
  floor: initialFloor,
  onCancel,
  onSubmit,
}: {
  space: FacilityTreeSpaceDto;
  floor: string | null;
  onCancel: () => void;
  onSubmit: (payload: {
    name?: string;
    floor?: string;
    spaceType?: string;
    areaSqft?: number;
    isActive?: boolean;
  }) => Promise<void>;
}) {
  const initialFloorStr = initialFloor ?? '';
  const [name, setName] = useState(space.name);
  const [floor, setFloor] = useState(initialFloorStr);
  const [spaceType, setSpaceType] = useState(space.spaceType);
  const [areaSqft, setAreaSqft] = useState(space.areaSqft?.toString() ?? '');
  const [isActive, setIsActive] = useState(space.isActive);
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        // The web FacUpdateSpacePayload's spaceType is FacSpaceType union;
        // we treat it as string at the boundary since the schema CHECK is
        // the actual gate.
        await onSubmit({
          name: name !== space.name ? name : undefined,
          floor: floor !== initialFloorStr ? floor : undefined,
          spaceType: spaceType !== space.spaceType ? spaceType : undefined,
          areaSqft:
            areaSqft !== (space.areaSqft?.toString() ?? '')
              ? areaSqft
                ? Number(areaSqft)
                : undefined
              : undefined,
          isActive: isActive !== space.isActive ? isActive : undefined,
        });
        setSubmitting(false);
      }}
    >
      <FormField label="Name" required>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Floor">
          <input
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </FormField>
        <FormField label="Type" required>
          <select
            value={spaceType}
            onChange={(e) => setSpaceType(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            {ALL_SPACE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="Area (sqft)">
        <input
          type="number"
          min={0}
          step={0.5}
          value={areaSqft}
          onChange={(e) => setAreaSqft(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </FormField>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─── Modals: Add Building / Add Room / Import ─────────────────────

function AddBuildingModal({ onClose }: { onClose: () => void }) {
  const create = useFacCreateBuilding();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [yearBuilt, setYearBuilt] = useState('');
  const [totalFloors, setTotalFloors] = useState('');
  const [submitting, setSubmitting] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title="Add building"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name || submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await create.mutateAsync({
                  name,
                  code: code || undefined,
                  yearBuilt: yearBuilt ? Number(yearBuilt) : undefined,
                  totalFloors: totalFloors ? Number(totalFloors) : undefined,
                });
                toast(`Building "${name}" added`, 'success');
                onClose();
              } catch (e) {
                toast(messageFor(e, 'Create failed'), 'error');
              } finally {
                setSubmitting(false);
              }
            }}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add building'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Name" required>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Main Building"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </FormField>
        <FormField label="Code">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="MB"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Year built">
            <input
              type="number"
              min={1800}
              max={2100}
              value={yearBuilt}
              onChange={(e) => setYearBuilt(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </FormField>
          <FormField label="Total floors">
            <input
              type="number"
              min={1}
              max={200}
              value={totalFloors}
              onChange={(e) => setTotalFloors(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

function AddRoomModal({
  buildingId,
  building,
  onClose,
}: {
  buildingId: string;
  building: FacilityTreeBuildingDto | null;
  onClose: () => void;
}) {
  const create = useFacCreateSpace(buildingId);
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [floorMode, setFloorMode] = useState<'select' | 'custom'>('select');
  const [floorPick, setFloorPick] = useState<string>('');
  const [floorCustom, setFloorCustom] = useState('');
  const [spaceType, setSpaceType] = useState('CLASSROOM');
  const [areaSqft, setAreaSqft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const existingFloors = useMemo(() => {
    if (!building) return [] as string[];
    const set = new Set<string>();
    for (const f of building.floors) {
      if (f.floor) set.add(f.floor);
    }
    return Array.from(set).sort();
  }, [building]);

  // Initialise the floor picker from existing floors when the modal mounts.
  useEffect(() => {
    const firstFloor = existingFloors[0];
    if (floorMode === 'select' && !floorPick && firstFloor) {
      setFloorPick(firstFloor);
    }
  }, [existingFloors, floorMode, floorPick]);

  const resolveFloor = (): string | undefined => {
    if (floorMode === 'custom') return floorCustom || undefined;
    return floorPick || undefined;
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={building ? `Add room to ${building.name}` : 'Add room'}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name || submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await create.mutateAsync({
                  name,
                  floor: resolveFloor(),
                  spaceType: spaceType as never, // FacSpaceType union; backend CHECK is the gate
                  areaSqft: areaSqft ? Number(areaSqft) : undefined,
                });
                toast(`Room "${name}" added`, 'success');
                onClose();
              } catch (e) {
                toast(messageFor(e, 'Create failed'), 'error');
              } finally {
                setSubmitting(false);
              }
            }}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add room'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Name" required>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Room 101"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </FormField>
        <FormField label="Floor">
          {existingFloors.length > 0 && floorMode === 'select' ? (
            <div className="flex gap-2">
              <select
                value={floorPick}
                onChange={(e) => setFloorPick(e.target.value)}
                className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              >
                {existingFloors.map((f) => (
                  <option key={f} value={f}>
                    Floor {f}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setFloorMode('custom')}
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
              >
                Custom…
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                value={floorCustom}
                onChange={(e) => setFloorCustom(e.target.value)}
                placeholder="e.g. 3 / Basement / Wing A"
                className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
              {existingFloors.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setFloorMode('select');
                    setFloorCustom('');
                  }}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  Pick existing
                </button>
              )}
            </div>
          )}
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Type" required>
            <select
              value={spaceType}
              onChange={(e) => setSpaceType(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              {ALL_SPACE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Area (sqft)">
            <input
              type="number"
              min={0}
              step={0.5}
              value={areaSqft}
              onChange={(e) => setAreaSqft(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

function ImportRoomsModal({ onClose }: { onClose: () => void }) {
  const importRooms = useImportRooms();
  const { toast } = useToast();
  const [csvText, setCsvText] = useState('building_name,room_name,floor,space_type,area_sqft\n');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportRoomsResponseDto | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const parsed = useMemo(() => parseCsv(csvText), [csvText]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Import rooms (CSV)"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            disabled={parsed.rows.length === 0 || submitting}
            onClick={async () => {
              setSubmitting(true);
              setErrors([]);
              setResult(null);
              try {
                const res = await importRooms.mutateAsync(parsed.rows);
                setResult(res);
                if (res.created > 0) {
                  toast(
                    `${res.created} room${res.created === 1 ? '' : 's'} imported${
                      res.skipped > 0 ? ` · ${res.skipped} skipped (already existed)` : ''
                    }`,
                    'success',
                  );
                } else if (res.skipped > 0) {
                  toast('All rows already existed — nothing to do', 'info');
                }
              } catch (e) {
                if (
                  e instanceof ApiError &&
                  Array.isArray((e.body as { rowErrors?: string[] })?.rowErrors)
                ) {
                  setErrors((e.body as { rowErrors: string[] }).rowErrors);
                  toast('Some rows failed — see details below', 'error');
                } else {
                  toast(messageFor(e, 'Import failed'), 'error');
                }
              } finally {
                setSubmitting(false);
              }
            }}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {submitting
              ? 'Importing…'
              : `Import ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-700">
          Paste CSV with header row. Required columns:{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">building_name</code>,{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">room_name</code>,{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">space_type</code>. Optional:{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">floor</code>,{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">area_sqft</code>.
        </p>
        <textarea
          rows={8}
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
          placeholder="building_name,room_name,floor,space_type,area_sqft&#10;Main Building,Room 401,4,CLASSROOM,640"
        />
        {parsed.parseErrors.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">Parse warnings:</p>
            <ul className="ml-4 list-disc">
              {parsed.parseErrors.slice(0, 5).map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {parsed.rows.length > 0 && (
          <div className="rounded-md border border-gray-200">
            <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-600">
              Preview ({parsed.rows.length} rows)
            </div>
            <div className="max-h-40 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="border-b border-gray-200 text-left">
                    <th className="px-3 py-1.5">Building</th>
                    <th className="px-3 py-1.5">Room</th>
                    <th className="px-3 py-1.5">Floor</th>
                    <th className="px-3 py-1.5">Type</th>
                    <th className="px-3 py-1.5">Area</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="px-3 py-1">{r.buildingName}</td>
                      <td className="px-3 py-1">{r.roomName}</td>
                      <td className="px-3 py-1">{r.floor ?? ''}</td>
                      <td className="px-3 py-1">{r.spaceType}</td>
                      <td className="px-3 py-1 tabular-nums">{r.areaSqft ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {errors.length > 0 && (
          <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
            <p className="font-semibold">Some rows were rejected:</p>
            <ul className="ml-4 list-disc">
              {errors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {result && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
            <p>
              <strong>{result.created}</strong> created · <strong>{result.skipped}</strong> skipped
              (already existed)
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-600">
        {label} {required && <span className="text-rose-600">*</span>}
      </span>
      {children}
    </label>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900">{value}</dd>
    </div>
  );
}

function messageFor(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: string } | undefined;
    return body?.message ?? e.message ?? fallback;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}

function parseCsv(text: string): {
  rows: ImportRoomRow[];
  parseErrors: string[];
} {
  const rows: ImportRoomRow[] = [];
  const parseErrors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows, parseErrors };
  const headerLine = lines[0];
  if (!headerLine) return { rows, parseErrors };
  const header = headerLine.split(',').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iBuilding = idx('building_name');
  const iRoom = idx('room_name');
  const iFloor = idx('floor');
  const iType = idx('space_type');
  const iArea = idx('area_sqft');
  if (iBuilding === -1 || iRoom === -1 || iType === -1) {
    parseErrors.push('Header missing — required: building_name, room_name, space_type.');
    return { rows, parseErrors };
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split(',').map((c) => c.trim());
    const buildingName = cells[iBuilding];
    const roomName = cells[iRoom];
    const spaceType = cells[iType]?.toUpperCase();
    if (!buildingName || !roomName || !spaceType) {
      parseErrors.push(`Line ${i + 1}: missing required field.`);
      continue;
    }
    const floor = iFloor !== -1 ? cells[iFloor] || null : null;
    const areaCell = iArea !== -1 ? (cells[iArea] ?? '') : '';
    const areaSqft = areaCell ? Number(areaCell) : null;
    if (areaCell && Number.isNaN(areaSqft)) {
      parseErrors.push(`Line ${i + 1}: area_sqft "${areaCell}" is not a number.`);
      continue;
    }
    rows.push({
      buildingName,
      roomName,
      floor,
      spaceType,
      areaSqft: areaSqft != null && !Number.isNaN(areaSqft) ? areaSqft : null,
    });
  }
  return { rows, parseErrors };
}
