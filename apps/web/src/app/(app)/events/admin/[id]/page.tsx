'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState, LoadingSpinner, Modal, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui';
import {
  useAddCompEntry,
  useCompList,
  useCompleteEvent,
  useCreateTier,
  useEvent,
  useEventRevenue,
  useOrders,
  useRemoveCompEntry,
  useSignUpVolunteer,
  useUpdateEvent,
  useUpdateVolunteer,
  useVolunteers,
} from '@/hooks/use-events';
import {
  EVT_COMP_TYPES,
  EVT_COMP_TYPE_LABELS,
  EVT_COMP_TYPE_PILL,
  EVT_EVENT_STATUS_LABELS,
  EVT_EVENT_STATUS_PILL,
  EVT_EVENT_TYPE_LABELS,
  EVT_ORDER_STATUS_LABELS,
  EVT_ORDER_STATUS_PILL,
  EVT_VOLUNTEER_STATUSES,
  EVT_VOLUNTEER_STATUS_LABELS,
  formatCurrency,
  formatDateTime,
  formatEventDate,
  formatEventTime,
  tierAvailabilityLabel,
  tierAvailabilityTone,
} from '@/lib/events-format';
import type {
  CreateEvtTierPayload,
  EvtCompType,
  EvtEventStatus,
  EvtVolunteerStatus,
} from '@/lib/types';
import { ApiError } from '@/lib/api-client';

type Tab = 'tiers' | 'orders' | 'comp' | 'volunteers' | 'revenue';

const TAB_LABELS: Record<Tab, string> = {
  tiers: 'Tiers',
  orders: 'Orders',
  comp: 'Comp list',
  volunteers: 'Volunteers',
  revenue: 'Revenue',
};

export default function EventAdminDetailPage() {
  const params = useParams<{ id: string }>();
  const eventId = params?.id ?? '';
  const eventQ = useEvent(eventId || null);
  const update = useUpdateEvent(eventId);
  const complete = useCompleteEvent(eventId);
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('tiers');

  if (!eventId) return null;
  if (eventQ.isLoading) return <LoadingSpinner />;
  if (!eventQ.data) {
    return <EmptyState title="Event not found" description="" />;
  }
  const ev = eventQ.data;

  async function setStatus(status: EvtEventStatus) {
    try {
      await update.mutateAsync({ status });
      toast(`Status set to ${EVT_EVENT_STATUS_LABELS[status]}.`, 'success');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast(`Status change failed: ${msg}`, 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title={ev.title}
        description={`${EVT_EVENT_TYPE_LABELS[ev.eventType]} · ${formatEventDate(ev.eventDate)} · ${formatEventTime(ev.startTime)}${
          ev.endTime ? ` – ${formatEventTime(ev.endTime)}` : ''
        }${ev.venueName ? ` · ${ev.venueName}` : ''}`}
        actions={
          <Link href="/events/admin" className="text-sm text-blue-700 hover:underline">
            ← All events
          </Link>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            EVT_EVENT_STATUS_PILL[ev.status]
          }`}
        >
          {EVT_EVENT_STATUS_LABELS[ev.status]}
        </span>
        {ev.status === 'DRAFT' && (
          <button
            type="button"
            onClick={() => setStatus('ON_SALE')}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            Publish &amp; open sales
          </button>
        )}
        {(ev.status === 'ON_SALE' || ev.status === 'SOLD_OUT') && (
          <>
            <button
              type="button"
              onClick={async () => {
                if (
                  window.confirm('Mark event COMPLETED? This emits evt.event.completed for GL.')
                ) {
                  try {
                    await complete.mutateAsync();
                    toast('Event marked COMPLETED.', 'success');
                  } catch (err) {
                    const msg = err instanceof ApiError ? err.message : String(err);
                    toast(`Complete failed: ${msg}`, 'error');
                  }
                }
              }}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Mark completed
            </button>
            <button
              type="button"
              onClick={() => setStatus('CANCELLED')}
              className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700"
            >
              Cancel event
            </button>
          </>
        )}
        {ev.totalCapacity && (
          <span className="text-sm text-gray-600">
            Capacity {ev.totalCapacity} · {ev.totalTierQuantity} tier seats
          </span>
        )}
      </div>

      <div className="mt-6 border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-4">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`border-b-2 px-1 pb-2 text-sm font-medium ${
                tab === t
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-6">
        {tab === 'tiers' && <TiersTab eventId={eventId} />}
        {tab === 'orders' && <OrdersTab eventId={eventId} />}
        {tab === 'comp' && <CompTab eventId={eventId} />}
        {tab === 'volunteers' && <VolunteersTab eventId={eventId} />}
        {tab === 'revenue' && <RevenueTab eventId={eventId} />}
      </div>
    </div>
  );
}

function TiersTab({ eventId }: { eventId: string }) {
  const eventQ = useEvent(eventId);
  const create = useCreateTier(eventId);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState<number | ''>('');
  const [qty, setQty] = useState<number | ''>('');

  async function submit() {
    if (!name.trim() || typeof price !== 'number' || typeof qty !== 'number') return;
    const body: CreateEvtTierPayload = {
      name: name.trim(),
      price,
      quantity: qty,
      isActive: true,
    };
    try {
      await create.mutateAsync(body);
      toast('Tier created.', 'success');
      setOpen(false);
      setName('');
      setPrice('');
      setQty('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast(`Create tier failed: ${msg}`, 'error');
    }
  }

  const tiers = eventQ.data?.tiers ?? [];

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          Add tier
        </button>
      </div>
      {tiers.length === 0 ? (
        <EmptyState title="No tiers yet" description="Add a tier to open sales." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Price
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Sold
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Quantity
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Remaining
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Active
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {tiers.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-2 font-medium text-gray-900">{t.name}</td>
                  <td className="px-3 py-2 text-gray-700">{formatCurrency(t.price)}</td>
                  <td className="px-3 py-2 text-gray-700">{t.quantitySold}</td>
                  <td className="px-3 py-2 text-gray-700">{t.quantity}</td>
                  <td className={`px-3 py-2 ${tierAvailabilityTone(t.remaining, t.quantity)}`}>
                    {tierAvailabilityLabel(t.remaining, t.quantity)}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{t.isActive ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add tier"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Add tier
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs font-medium text-gray-600">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="General Admission"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Price (USD)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Quantity</span>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value === '' ? '' : Number(e.target.value))}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </label>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Adding a tier whose total quantity would push past the event capacity is blocked by the
          schema CHECK constraint.
        </p>
      </Modal>
    </div>
  );
}

function OrdersTab({ eventId }: { eventId: string }) {
  const ordersQ = useOrders({ eventId });
  if (ordersQ.isLoading) return <LoadingSpinner />;
  const orders = ordersQ.data ?? [];
  if (orders.length === 0) {
    return <EmptyState title="No orders" description="" />;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
              Purchaser
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
              Status
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
              Tickets
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
              Total
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
              Placed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="px-3 py-2 text-gray-700">{o.purchaserName ?? o.purchaserId}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    EVT_ORDER_STATUS_PILL[o.status]
                  }`}
                >
                  {EVT_ORDER_STATUS_LABELS[o.status]}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-700">{o.tickets.length}</td>
              <td className="px-3 py-2 text-gray-700">{formatCurrency(o.totalAmount)}</td>
              <td className="px-3 py-2 text-gray-600">{formatDateTime(o.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompTab({ eventId }: { eventId: string }) {
  const listQ = useCompList(eventId);
  const add = useAddCompEntry(eventId);
  const remove = useRemoveCompEntry(eventId);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState('');
  const [compType, setCompType] = useState<EvtCompType>('VIP');
  const [notes, setNotes] = useState('');

  async function submit() {
    if (!personId.trim()) return;
    try {
      await add.mutateAsync({ compType, personId: personId.trim(), notes });
      toast('Comp added.', 'success');
      setOpen(false);
      setPersonId('');
      setNotes('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast(`Add comp failed: ${msg}`, 'error');
    }
  }

  const list = listQ.data ?? [];

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          Add comp entry
        </button>
      </div>
      {list.length === 0 ? (
        <EmptyState title="Comp list is empty" description="" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Type
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Person
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Added
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        EVT_COMP_TYPE_PILL[c.compType]
                      }`}
                    >
                      {EVT_COMP_TYPE_LABELS[c.compType]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{c.personName ?? c.personId}</td>
                  <td className="px-3 py-2 text-gray-500">{formatDateTime(c.addedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Remove this comp entry?')) {
                          void remove.mutateAsync(c.id);
                        }
                      }}
                      className="text-xs text-rose-700 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add comp entry"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Add
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Type</span>
            <select
              value={compType}
              onChange={(e) => setCompType(e.target.value as EvtCompType)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              {EVT_COMP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EVT_COMP_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Person UUID</span>
            <input
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              placeholder="Paste platform.iam_person.id"
              className="rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Notes (optional)</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}

function VolunteersTab({ eventId }: { eventId: string }) {
  const listQ = useVolunteers(eventId);
  const signUp = useSignUpVolunteer(eventId);
  const update = useUpdateVolunteer(eventId);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState('');

  async function submit() {
    if (!personId.trim()) return;
    try {
      await signUp.mutateAsync({
        personId: personId.trim(),
        role: role.trim() || undefined,
      });
      toast('Volunteer signed up.', 'success');
      setOpen(false);
      setPersonId('');
      setRole('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast(`Sign-up failed: ${msg}`, 'error');
    }
  }

  async function patchStatus(volunteerId: string, status: EvtVolunteerStatus) {
    try {
      await update.mutateAsync({
        volunteerId,
        patch: { status, checkIn: status === 'CONFIRMED' ? true : undefined },
      });
      toast('Volunteer updated.', 'success');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast(`Update failed: ${msg}`, 'error');
    }
  }

  const list = listQ.data ?? [];

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          Sign up volunteer
        </button>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No volunteers yet" description="" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Person
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Role
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Status
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                  Check-in
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((v) => (
                <tr key={v.id}>
                  <td className="px-3 py-2 text-gray-700">{v.personName ?? v.personId}</td>
                  <td className="px-3 py-2 text-gray-600">{v.role ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700">
                    {EVT_VOLUNTEER_STATUS_LABELS[v.status]}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {v.checkInAt ? formatDateTime(v.checkInAt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <select
                      value=""
                      onChange={(e) => {
                        const status = e.target.value as EvtVolunteerStatus;
                        if (EVT_VOLUNTEER_STATUSES.includes(status)) {
                          void patchStatus(v.id, status);
                        }
                      }}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
                    >
                      <option value="">Change…</option>
                      {EVT_VOLUNTEER_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {EVT_VOLUNTEER_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Sign up volunteer"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Sign up
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Person UUID</span>
            <input
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              placeholder="Paste platform.iam_person.id"
              className="rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Role (optional)</span>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Gate, usher, concessions…"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}

function RevenueTab({ eventId }: { eventId: string }) {
  const revenueQ = useEventRevenue(eventId);
  if (revenueQ.isLoading) return <LoadingSpinner />;
  const r = revenueQ.data;
  if (!r) {
    return <EmptyState title="No revenue data" description="" />;
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card label="Gross sales" value={formatCurrency(r.grossTicketSales)} tone="emerald" />
        <Card label="Refunds" value={formatCurrency(r.refundsIssued)} tone="rose" />
        <Card label="Est. Stripe fees" value={formatCurrency(r.estimatedStripeFees)} tone="amber" />
        <Card label="Net revenue" value={formatCurrency(r.netRevenue)} tone="default" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card label="Tickets sold" value={String(r.totalTicketsSold)} tone="default" />
        <Card label="Tickets scanned" value={String(r.totalTicketsScanned)} tone="default" />
        <Card label="Season pass admits" value={String(r.seasonPassAdmissions)} tone="default" />
        <Card label="Comp admits" value={String(r.compAdmissions)} tone="default" />
      </div>
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Tier
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Price
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Sold
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Scanned
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                Gross
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {r.tiers.map((row) => (
              <tr key={row.tierId}>
                <td className="px-3 py-2 font-medium text-gray-900">{row.tierName}</td>
                <td className="px-3 py-2 text-gray-700">{formatCurrency(row.price)}</td>
                <td className="px-3 py-2 text-gray-700">{row.quantitySold}</td>
                <td className="px-3 py-2 text-gray-700">{row.ticketsScanned}</td>
                <td className="px-3 py-2 text-gray-700">{formatCurrency(row.grossRevenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'rose' | 'amber' | 'default';
}) {
  const cls =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'rose'
        ? 'text-rose-700'
        : tone === 'amber'
          ? 'text-amber-700'
          : 'text-gray-900';
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 shadow-sm">
      <div className={`text-xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
