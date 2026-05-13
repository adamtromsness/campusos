'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useAlumniCampaigns, useCreateAlumniCampaign } from '@/hooks/use-alumni';
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_PILL,
  COMMON_CURRENCIES,
  formatCampaignProgress,
  formatCurrency,
  formatDateOnly,
} from '@/lib/alumni-format';
import type { CampaignStatus } from '@/lib/types';

const STATUS_FILTERS: ('ALL' | CampaignStatus)[] = [
  'ALL',
  'ACTIVE',
  'DRAFT',
  'COMPLETED',
  'CANCELLED',
];

export default function CampaignsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;
  const [statusFilter, setStatusFilter] = useState<'ALL' | CampaignStatus>('ALL');
  const campaignsQ = useAlumniCampaigns(statusFilter === 'ALL' ? undefined : statusFilter);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Campaigns"
        description={
          showStaffSurfaces
            ? 'Fundraising campaigns. Activate to begin outreach; recipients are added by tag segmentation.'
            : 'Active fundraising campaigns supported by your community.'
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/alumni"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Directory
        </Link>
        {showStaffSurfaces && (
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={() => setCreateOpen(true)}
          >
            New campaign
          </button>
        )}
      </div>

      {/* Filters */}
      {showStaffSurfaces && (
        <div className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className={
                'rounded-full border px-3 py-1 text-xs ' +
                (statusFilter === s
                  ? 'border-campus-600 bg-campus-50 text-campus-700'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
              }
              onClick={() => setStatusFilter(s)}
            >
              {s === 'ALL' ? 'All' : CAMPAIGN_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      )}

      {/* List */}
      {campaignsQ.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (campaignsQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No campaigns"
          description={showStaffSurfaces ? 'Create one to start fundraising.' : 'Check back soon.'}
        />
      ) : (
        <ul className="space-y-3">
          {campaignsQ.data!.map((c) => (
            <li key={c.id} className="rounded-md border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/alumni/campaigns/${c.id}`}
                    className="text-base font-semibold text-campus-700 hover:underline"
                  >
                    {c.title}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={
                        'rounded px-1.5 py-0.5 font-medium ' + CAMPAIGN_STATUS_PILL[c.status]
                      }
                    >
                      {CAMPAIGN_STATUS_LABEL[c.status]}
                    </span>
                    <span className="text-gray-500">
                      {c.startDate ? formatDateOnly(c.startDate) : '—'} →{' '}
                      {c.endDate ? formatDateOnly(c.endDate) : '—'}
                    </span>
                  </div>
                  {c.description && (
                    <p className="mt-2 line-clamp-2 text-sm text-gray-700">{c.description}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-2xl font-semibold text-gray-900">
                    {formatCurrency(c.raisedAmount, c.reportingCurrency)}
                  </div>
                  <div className="text-xs text-gray-500">
                    raised
                    {c.goalAmount ? ' of ' + formatCurrency(c.goalAmount, c.reportingCurrency) : ''}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {formatCampaignProgress(c.raisedAmount, c.goalAmount)}
                  </div>
                </div>
              </div>

              {c.goalAmount && c.goalAmount > 0 && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200">
                  <div
                    className="h-2 bg-emerald-500"
                    style={{
                      width: Math.min(100, Math.round((c.raisedAmount / c.goalAmount) * 100)) + '%',
                    }}
                  />
                </div>
              )}

              <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                <div>
                  {c.donationCount} donations · {c.recipientCount} recipients
                </div>
                {c.status === 'ACTIVE' && (
                  <Link
                    href={`/alumni/campaigns/${c.id}/donate`}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                  >
                    Donate →
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showStaffSurfaces && (
        <CreateCampaignModal open={createOpen} onClose={() => setCreateOpen(false)} />
      )}
    </div>
  );
}

function CreateCampaignModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateAlumniCampaign();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [goalAmount, setGoalAmount] = useState('');
  const [reportingCurrency, setReportingCurrency] = useState('USD');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const submit = async () => {
    if (!title.trim()) {
      toast('Title is required.', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        title: title.trim(),
        description: description || undefined,
        goalAmount: goalAmount ? Number(goalAmount) : undefined,
        reportingCurrency,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      toast('Campaign created as DRAFT. Activate it from the detail page.', 'success');
      setTitle('');
      setDescription('');
      setGoalAmount('');
      setStartDate('');
      setEndDate('');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={submit}
            disabled={create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create DRAFT'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Title">
          <input
            type="text"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Description">
          <textarea
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Goal amount">
            <input
              type="number"
              min="0"
              step="0.01"
              className="w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={goalAmount}
              onChange={(e) => setGoalAmount(e.target.value)}
            />
          </Field>
          <Field label="Reporting currency">
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={reportingCurrency}
              onChange={(e) => setReportingCurrency(e.target.value)}
            >
              {COMMON_CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <input
              type="date"
              className="w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              className="w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
