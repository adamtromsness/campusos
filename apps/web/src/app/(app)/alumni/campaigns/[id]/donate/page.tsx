'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader, EmptyState } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import {
  useAlumniCampaign,
  useCampaignRaised,
  useDonate,
  useMyAlumniProfile,
} from '@/hooks/use-alumni';
import { COMMON_CURRENCIES, formatCampaignProgress, formatCurrency } from '@/lib/alumni-format';

export default function DonatePage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { toast } = useToast();

  const campaignQ = useAlumniCampaign(id);
  const raisedQ = useCampaignRaised(id);
  const myProfileQ = useMyAlumniProfile();
  const donate = useDonate(id);

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [fxRate, setFxRate] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);

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

  if (campaign.status !== 'ACTIVE') {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <PageHeader title={campaign.title} />
        <EmptyState
          title="Not accepting donations"
          description={`This campaign is currently ${campaign.status}.`}
        />
        <Link href={`/alumni/campaigns/${id}`} className="text-sm text-campus-700 hover:underline">
          ← Back to campaign
        </Link>
      </div>
    );
  }

  const needsFx = currency !== campaign.reportingCurrency;

  const submit = async () => {
    if (!myProfileQ.data) {
      toast(
        "We can't find your alumni profile at this school. Please contact the alumni office.",
        'error',
      );
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast('Amount must be greater than zero.', 'error');
      return;
    }
    if (needsFx) {
      const fx = Number(fxRate);
      if (!Number.isFinite(fx) || fx <= 0) {
        toast(
          `FX rate required when donating in ${currency} (campaign records ${campaign.reportingCurrency}).`,
          'error',
        );
        return;
      }
    }
    try {
      const res = await donate.mutateAsync({
        donorAlumniId: myProfileQ.data.id,
        amount: amt,
        currency,
        fxRateAtDonation: needsFx ? Number(fxRate) : undefined,
        isAnonymous,
      });
      toast(
        `Thank you! Your ${formatCurrency(res.amount, res.currency)} donation has been recorded.`,
        'success',
      );
      router.push(`/alumni/campaigns/${id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader
        title={`Donate to ${campaign.title}`}
        description={campaign.description ?? undefined}
      />

      <Link href={`/alumni/campaigns/${id}`} className="text-sm text-campus-700 hover:underline">
        ← Back to campaign
      </Link>

      <div className="rounded-md border border-gray-200 bg-white p-4">
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
        </div>
        <div className="mt-1 text-xs text-gray-500">
          {formatCampaignProgress(
            raisedQ.data?.raisedAmount ?? campaign.raisedAmount,
            campaign.goalAmount,
          )}
        </div>
        {campaign.goalAmount && campaign.goalAmount > 0 && (
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-3 bg-emerald-500"
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

      {!myProfileQ.isLoading && !myProfileQ.data && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          We can&apos;t find your alumni profile at this school. Donations require a registered
          alumni record — please contact the alumni office.
        </div>
      )}

      {myProfileQ.data && (
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Your donation
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Donating as <strong>{myProfileQ.data.displayName}</strong> (Class of{' '}
            {myProfileQ.data.graduationYear}).
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-500">Amount</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-500">Currency</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {COMMON_CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {needsFx && (
            <div className="mt-3">
              <label className="block text-sm">
                <span className="block text-xs uppercase tracking-wide text-gray-500">
                  FX rate (1 {currency} = ? {campaign.reportingCurrency})
                </span>
                <input
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
                  value={fxRate}
                  onChange={(e) => setFxRate(e.target.value)}
                  placeholder="e.g. 1.27"
                />
              </label>
              <p className="mt-1 text-xs text-gray-500">
                The campaign records totals in {campaign.reportingCurrency}. Your donation will be
                recorded as{' '}
                {amount && fxRate
                  ? formatCurrency(Number(amount) * Number(fxRate), campaign.reportingCurrency)
                  : '— enter amount + fx —'}{' '}
                in the reporting currency.
              </p>
            </div>
          )}

          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isAnonymous}
              onChange={(e) => setIsAnonymous(e.target.checked)}
            />
            <span>
              Make this an anonymous donation. The amount is still public; your name is hidden from
              the public campaign page but the alumni office can audit donor records.
            </span>
          </label>

          <button
            type="button"
            className="mt-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            onClick={submit}
            disabled={donate.isPending}
          >
            {donate.isPending ? 'Recording…' : 'Donate now'}
          </button>
        </div>
      )}
    </div>
  );
}
