'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useActivateAlumniCampaign,
  useAddRecipientsByTag,
  useAlumniCampaign,
  useCampaignDonations,
  useCampaignFunnel,
  useCampaignRaised,
  useCampaignRecipients,
  useSendOutreach,
  useUpdateAlumniCampaign,
} from '@/hooks/use-alumni';
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_PILL,
  COMMON_ALUMNI_TAGS,
  OUTREACH_STATUS_LABEL,
  OUTREACH_STATUS_PILL,
  formatCampaignProgress,
  formatCurrency,
  formatDateOnly,
} from '@/lib/alumni-format';

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { toast } = useToast();
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const campaignQ = useAlumniCampaign(id);
  const raisedQ = useCampaignRaised(id);
  const funnelQ = useCampaignFunnel(showStaffSurfaces ? id : null);
  const recipientsQ = useCampaignRecipients(showStaffSurfaces ? id : null);
  const donationsQ = useCampaignDonations(id);

  const activate = useActivateAlumniCampaign(id);
  const sendOutreach = useSendOutreach(id);
  const update = useUpdateAlumniCampaign(id);
  const [recipientsModalOpen, setRecipientsModalOpen] = useState(false);

  if (campaignQ.isLoading) return <p className="p-6 text-sm text-gray-500">Loading…</p>;
  if (!campaignQ.data) {
    return (
      <div className="p-6">
        <EmptyState
          title="Campaign not found"
          description="It may have been removed or you don't have access."
        />
      </div>
    );
  }
  const campaign = campaignQ.data;

  const doActivate = async () => {
    if (
      !window.confirm('Activate this campaign? An alm.campaign.activated event will be emitted.')
    ) {
      return;
    }
    try {
      await activate.mutateAsync();
      toast('Campaign activated.', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const doSendOutreach = async () => {
    if (
      !window.confirm(
        'Send outreach to all PENDING recipients? They will be marked SENT immediately.',
      )
    ) {
      return;
    }
    try {
      const res = await sendOutreach.mutateAsync();
      toast(`${res.sent} outreach email(s) marked sent.`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const completeCampaign = async () => {
    if (!window.confirm('Mark this campaign COMPLETED? It will stop accepting donations.')) return;
    try {
      await update.mutateAsync({ status: 'COMPLETED' });
      toast('Campaign completed.', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader title={campaign.title} description={campaign.description ?? undefined} />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/alumni/campaigns"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Campaigns
        </Link>
        {campaign.status === 'DRAFT' && showStaffSurfaces && (
          <button
            type="button"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700"
            onClick={doActivate}
            disabled={activate.isPending}
          >
            Activate campaign
          </button>
        )}
        {campaign.status === 'ACTIVE' && (
          <button
            type="button"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700"
            onClick={() => router.push(`/alumni/campaigns/${id}/donate`)}
          >
            Donate
          </button>
        )}
        {campaign.status === 'ACTIVE' && showStaffSurfaces && (
          <>
            <button
              type="button"
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
              onClick={() => setRecipientsModalOpen(true)}
            >
              Add recipients by tag
            </button>
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={doSendOutreach}
              disabled={sendOutreach.isPending}
            >
              Send outreach
            </button>
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={completeCampaign}
              disabled={update.isPending}
            >
              Mark completed
            </button>
          </>
        )}
      </div>

      {/* Header card */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={
                'rounded px-2 py-0.5 text-xs font-medium ' + CAMPAIGN_STATUS_PILL[campaign.status]
              }
            >
              {CAMPAIGN_STATUS_LABEL[campaign.status]}
            </span>
            <span className="text-gray-500">
              {campaign.startDate ? formatDateOnly(campaign.startDate) : '—'} →{' '}
              {campaign.endDate ? formatDateOnly(campaign.endDate) : '—'}
            </span>
          </div>
          <div className="mt-3">
            <div className="text-3xl font-semibold text-gray-900">
              {formatCurrency(
                raisedQ.data?.raisedAmount ?? campaign.raisedAmount,
                campaign.reportingCurrency,
              )}
            </div>
            <div className="text-sm text-gray-500">
              raised
              {campaign.goalAmount
                ? ' of ' + formatCurrency(campaign.goalAmount, campaign.reportingCurrency)
                : ''}
              {raisedQ.data?.cached ? ' (cached)' : ''}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {formatCampaignProgress(
                raisedQ.data?.raisedAmount ?? campaign.raisedAmount,
                campaign.goalAmount,
              )}
            </div>
            {campaign.goalAmount && campaign.goalAmount > 0 && (
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-2 bg-emerald-500"
                  style={{
                    width:
                      Math.min(
                        100,
                        Math.round(
                          ((raisedQ.data?.raisedAmount ?? campaign.raisedAmount) /
                            campaign.goalAmount) *
                            100,
                        ),
                      ) + '%',
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Funnel (staff only) */}
        {showStaffSurfaces && funnelQ.data && (
          <div className="rounded-md border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Outreach funnel
            </h2>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <FunnelStat label="Pending" value={funnelQ.data.pending} />
              <FunnelStat label="Sent" value={funnelQ.data.sent} />
              <FunnelStat label="Opened" value={funnelQ.data.opened} />
              <FunnelStat label="Responded" value={funnelQ.data.responded} />
              <FunnelStat label="Donated" value={funnelQ.data.donated} highlight />
              <FunnelStat label="Unsubscribed" value={funnelQ.data.unsubscribed} />
            </div>
            <p className="mt-2 text-xs text-gray-500">Total recipients: {funnelQ.data.total}</p>
          </div>
        )}
      </div>

      {/* Recipients (staff only) */}
      {showStaffSurfaces && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Recipients ({recipientsQ.data?.length ?? 0})
          </h2>
          {(recipientsQ.data?.length ?? 0) === 0 ? (
            <EmptyState
              title="No recipients yet"
              description="Add recipients by tag to start the outreach funnel."
            />
          ) : (
            <ul className="space-y-1">
              {recipientsQ.data!.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
                >
                  <code className="text-xs text-gray-500">{r.alumniId.slice(0, 8)}…</code>
                  <span
                    className={
                      'rounded px-1.5 py-0.5 text-xs font-medium ' +
                      OUTREACH_STATUS_PILL[r.outreachStatus]
                    }
                  >
                    {OUTREACH_STATUS_LABEL[r.outreachStatus]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Donations */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Donations ({donationsQ.data?.length ?? 0})
        </h2>
        {(donationsQ.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No donations yet"
            description={
              campaign.status === 'ACTIVE'
                ? 'Be the first — use the Donate button above.'
                : 'This campaign is not currently accepting donations.'
            }
          />
        ) : (
          <ul className="space-y-1">
            {donationsQ.data!.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-gray-900">
                    {d.donorDisplayName ?? 'Anonymous'}
                    {d.isAnonymous && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700 ring-1 ring-gray-200">
                        Anonymous
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">{formatDateOnly(d.donatedAt)}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-900">
                    {formatCurrency(d.amount, d.currency)}
                  </p>
                  {d.currency !== campaign.reportingCurrency && (
                    <p className="text-xs text-gray-500">
                      = {formatCurrency(d.amountInReportingCurrency, campaign.reportingCurrency)} @{' '}
                      {d.fxRateAtDonation?.toFixed(4)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AddRecipientsModal
        open={recipientsModalOpen}
        onClose={() => setRecipientsModalOpen(false)}
        campaignId={id}
      />
    </div>
  );
}

function FunnelStat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        'rounded-md p-2 ' +
        (highlight ? 'bg-emerald-50 ring-1 ring-emerald-200' : 'bg-gray-50 ring-1 ring-gray-200')
      }
    >
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function AddRecipientsModal({
  open,
  onClose,
  campaignId,
}: {
  open: boolean;
  onClose: () => void;
  campaignId: string;
}) {
  const { toast } = useToast();
  const addRecipients = useAddRecipientsByTag(campaignId);
  const [tag, setTag] = useState('STEM_MENTOR');

  const submit = async () => {
    try {
      const res = await addRecipients.mutateAsync({ tag });
      toast(
        `Added ${res.created} new recipient(s) — ${res.skipped} were already in the list.`,
        'success',
      );
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add recipients by tag"
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
            disabled={addRecipients.isPending}
          >
            {addRecipients.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-gray-600">
          Every alumnus carrying this tag is added to the campaign recipient list as PENDING. The
          insert is idempotent — duplicates are skipped.
        </p>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Tag</span>
          <select
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            {COMMON_ALUMNI_TAGS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}
