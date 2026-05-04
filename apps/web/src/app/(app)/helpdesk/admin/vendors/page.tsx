'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCreateTicketVendor,
  useTicketVendors,
  useUpdateTicketVendor,
} from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { VENDOR_TYPE_LABELS } from '@/lib/tickets-format';
import type { TicketVendorDto, VendorType } from '@/lib/types';

const VENDOR_TYPES: VendorType[] = [
  'IT_REPAIR',
  'FACILITIES_MAINTENANCE',
  'CLEANING',
  'ELECTRICAL',
  'PLUMBING',
  'HVAC',
  'SECURITY',
  'GROUNDS',
  'OTHER',
];

export default function HelpdeskVendorsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['it-001:admin', 'sch-001:admin']);
  const vendors = useTicketVendors(isAdmin, true);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TicketVendorDto | null>(null);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Vendors" />
        <EmptyState
          title="Admin only"
          description="Vendor management is visible to school administrators only."
        />
      </div>
    );
  }

  const list = vendors.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Vendors"
        description="External vendors the helpdesk can escalate tickets to. Preferred vendors are listed first in the Assign vendor modal."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/helpdesk/admin" className="text-sm text-campus-700 hover:underline">
              ← Back to queue
            </Link>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
            >
              New vendor
            </button>
          </div>
        }
      />

      {vendors.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState title="No vendors yet" description="Add a vendor to enable ticket escalation." />
      ) : (
        <ul className="space-y-2">
          {list.map((v) => (
            <li
              key={v.id}
              className={cn(
                'rounded-lg border border-gray-200 bg-white p-4',
                !v.isActive && 'opacity-60',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {v.isPreferred && (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        ★ Preferred
                      </span>
                    )}
                    <span className="font-semibold text-gray-900">{v.vendorName}</span>
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      {VENDOR_TYPE_LABELS[v.vendorType]}
                    </span>
                    {!v.isActive && (
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        Inactive
                      </span>
                    )}
                  </div>
                  <div className="mt-1 grid grid-cols-1 gap-1 text-xs text-gray-600 sm:grid-cols-2">
                    {v.contactName && <div>Contact: {v.contactName}</div>}
                    {v.contactEmail && <div>Email: {v.contactEmail}</div>}
                    {v.contactPhone && <div>Phone: {v.contactPhone}</div>}
                    {v.website && (
                      <div>
                        Website:{' '}
                        <a className="text-campus-700 hover:underline" href={v.website}>
                          {v.website.replace(/^https?:\/\//, '')}
                        </a>
                      </div>
                    )}
                  </div>
                  {v.notes && <p className="mt-1 text-xs text-gray-500">{v.notes}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => setEditTarget(v)}
                  className="rounded-md px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Edit
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {createOpen && <VendorModal mode="create" onClose={() => setCreateOpen(false)} />}
      {editTarget && (
        <VendorModal mode="edit" vendor={editTarget} onClose={() => setEditTarget(null)} />
      )}
    </div>
  );
}

function VendorModal({
  mode,
  vendor,
  onClose,
}: {
  mode: 'create' | 'edit';
  vendor?: TicketVendorDto;
  onClose: () => void;
}) {
  const create = useCreateTicketVendor();
  const update = useUpdateTicketVendor(vendor?.id ?? '');
  const { toast } = useToast();
  const [vendorName, setVendorName] = useState(vendor?.vendorName ?? '');
  const [vendorType, setVendorType] = useState<VendorType>(vendor?.vendorType ?? 'IT_REPAIR');
  const [contactName, setContactName] = useState(vendor?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(vendor?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(vendor?.contactPhone ?? '');
  const [website, setWebsite] = useState(vendor?.website ?? '');
  const [isPreferred, setIsPreferred] = useState(vendor?.isPreferred ?? false);
  const [notes, setNotes] = useState(vendor?.notes ?? '');
  const [isActive, setIsActive] = useState(vendor?.isActive ?? true);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      if (mode === 'create') {
        await create.mutateAsync({
          vendorName: vendorName.trim(),
          vendorType,
          contactName: contactName.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
          contactPhone: contactPhone.trim() || undefined,
          website: website.trim() || undefined,
          isPreferred,
          notes: notes.trim() || undefined,
        });
        toast('Vendor created', 'success');
      } else if (vendor) {
        await update.mutateAsync({
          vendorName: vendorName.trim() !== vendor.vendorName ? vendorName.trim() : undefined,
          vendorType: vendorType !== vendor.vendorType ? vendorType : undefined,
          contactName:
            contactName.trim() !== (vendor.contactName ?? '') ? contactName.trim() || null : undefined,
          contactEmail:
            contactEmail.trim() !== (vendor.contactEmail ?? '') ? contactEmail.trim() || null : undefined,
          contactPhone:
            contactPhone.trim() !== (vendor.contactPhone ?? '') ? contactPhone.trim() || null : undefined,
          website: website.trim() !== (vendor.website ?? '') ? website.trim() || null : undefined,
          isPreferred: isPreferred !== vendor.isPreferred ? isPreferred : undefined,
          notes: notes.trim() !== (vendor.notes ?? '') ? notes.trim() || null : undefined,
          isActive: isActive !== vendor.isActive ? isActive : undefined,
        });
        toast('Vendor updated', 'success');
      }
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={mode === 'create' ? 'New vendor' : 'Edit ' + (vendor?.vendorName ?? '')}
      size="lg"
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700">Vendor name</label>
            <input
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              required
              maxLength={120}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Type</label>
            <select
              value={vendorType}
              onChange={(e) => setVendorType(e.target.value as VendorType)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              {VENDOR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {VENDOR_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={isPreferred}
                onChange={(e) => setIsPreferred(e.target.checked)}
                className="rounded border-gray-300 text-campus-600 focus:ring-campus-300"
              />
              Preferred
            </label>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Contact name</label>
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              maxLength={120}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              maxLength={200}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Phone</label>
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              maxLength={40}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Website</label>
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              maxLength={200}
              placeholder="https://example.com"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={1000}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          {mode === 'edit' && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 sm:col-span-2">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="rounded border-gray-300 text-campus-600 focus:ring-campus-300"
              />
              Active (uncheck to soft-deactivate without affecting historical tickets)
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!vendorName.trim() || create.isPending || update.isPending}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
