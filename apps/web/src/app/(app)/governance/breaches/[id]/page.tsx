'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Modal, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui';
import { useBreach, useNotifySupervisoryAuthority, useResolveBreach } from '@/hooks/use-governance';
import {
  BREACH_RISK_PILL,
  BREACH_STATUS_LABELS,
  BREACH_STATUS_PILL,
  BREACH_TYPE_LABELS,
  formatBreachCountdown,
  formatDateTime,
  tonePill,
} from '@/lib/governance-format';

export default function BreachDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const breach = useBreach(id);
  const notifySa = useNotifySupervisoryAuthority(id);
  const resolveBreach = useResolveBreach(id);
  const { toast } = useToast();
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [reference, setReference] = useState('');

  if (breach.isLoading || !breach.data) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  const b = breach.data;
  const cd = formatBreachCountdown(b.hoursRemainingTo72);

  return (
    <div>
      <PageHeader title={b.breachTitle} description="GDPR Article 33 breach response." />

      <Link
        href="/governance/breaches"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-campus-700"
      >
        ← Back to register
      </Link>

      <section
        className={`mb-6 rounded-card border-2 p-4 ${
          b.isOverdue ? 'border-rose-300 bg-rose-50' : 'border-gray-200 bg-white'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <span
              className={`rounded-full px-2 py-1 font-semibold ${
                BREACH_STATUS_PILL[b.status] ?? 'bg-gray-100 text-gray-700'
              }`}
            >
              {BREACH_STATUS_LABELS[b.status] ?? b.status}
            </span>
            <span
              className={`rounded-full px-2 py-1 font-semibold ${
                BREACH_RISK_PILL[b.riskLevel] ?? 'bg-gray-100 text-gray-700'
              }`}
            >
              Risk {b.riskLevel}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-1 font-semibold text-gray-700">
              {BREACH_TYPE_LABELS[b.breachType] ?? b.breachType}
            </span>
          </div>
          {b.supervisoryAuthorityNotificationRequired && (
            <span className={`rounded-full px-4 py-1.5 text-sm font-bold ${tonePill(cd.tone)}`}>
              {cd.label}
            </span>
          )}
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Discovered" value={formatDateTime(b.discoveryDate)} />
          <Field label="Started" value={b.breachStartDate ?? '—'} />
          <Field
            label="Affected individuals"
            value={String(b.estimatedAffectedIndividuals ?? '—')}
          />
          <Field label="Risk to individuals" value={b.riskToIndividuals} />
          <Field
            label="Supervisory notified"
            value={
              b.supervisoryAuthorityNotifiedAt
                ? `${formatDateTime(b.supervisoryAuthorityNotifiedAt)} (ref ${b.supervisoryAuthorityReference ?? '—'})`
                : b.supervisoryAuthorityNotificationRequired
                  ? 'Required — pending'
                  : 'Not required'
            }
          />
          <Field
            label="Data subjects notified"
            value={
              b.dataSubjectsNotifiedAt
                ? formatDateTime(b.dataSubjectsNotifiedAt)
                : b.dataSubjectsNotificationRequired
                  ? 'Required — pending'
                  : 'Not required'
            }
          />
        </dl>
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">
            Personal data categories involved
          </h4>
          <p className="mt-1 text-sm text-gray-800">
            {b.personalDataCategoriesInvolved.join(', ')}
          </p>
        </div>
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Cause</h4>
          <p className="mt-1 text-sm text-gray-800">{b.breachCause}</p>
        </div>
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">
            Remediation actions
          </h4>
          <p className="mt-1 text-sm text-gray-800">{b.remediationActions}</p>
        </div>
      </section>

      {b.status !== 'RESOLVED' && (
        <section className="flex flex-wrap gap-3">
          {b.supervisoryAuthorityNotificationRequired && !b.supervisoryAuthorityNotifiedAt && (
            <button
              onClick={() => setNotifyOpen(true)}
              className="rounded-md bg-campus-600 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-700"
            >
              Notify supervisory authority
            </button>
          )}
          <button
            onClick={async () => {
              if (!confirm('Mark this breach RESOLVED? This is a final state.')) return;
              try {
                await resolveBreach.mutateAsync({});
                toast('Breach resolved.', 'success');
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Failed to resolve.', 'error');
              }
            }}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:border-emerald-400 hover:text-emerald-700"
            disabled={resolveBreach.isPending}
          >
            Mark resolved
          </button>
        </section>
      )}

      <Modal
        open={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        title="Notify supervisory authority"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setNotifyOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:border-gray-400"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!reference.trim()) {
                  toast('Reference is required.', 'error');
                  return;
                }
                try {
                  await notifySa.mutateAsync({ supervisoryAuthorityReference: reference });
                  toast('Notification recorded.', 'success');
                  setNotifyOpen(false);
                  setReference('');
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed to record notification.', 'error');
                }
              }}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-700"
              disabled={notifySa.isPending}
            >
              Record notification
            </button>
          </div>
        }
      >
        <div className="space-y-2 text-sm">
          <p className="text-gray-600">
            Stamp the supervisory authority notification timestamp + reference number once the
            notification has been filed. This stops the 72-hour countdown.
          </p>
          <input
            type="text"
            placeholder="Reference number"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-campus-200"
            autoFocus
          />
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-gray-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</div>
      <div className="mt-1 text-sm text-gray-900">{value}</div>
    </div>
  );
}
