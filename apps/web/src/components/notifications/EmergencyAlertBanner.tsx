'use client';

import { useEmergencyAlerts, useAcknowledgeDelivery } from '@/hooks/use-emergency-alerts';
import { useAuthStore, hasPermission } from '@/lib/auth-store';
import type { EmergencyAlertDto } from '@/lib/types';

/**
 * EmergencyAlertBanner — Cycle 14 Step 8.
 *
 * Persistent rose-tinted banner that renders at the top of every
 * authenticated route when an ACTIVE emergency alert exists for the
 * current user that they have not yet acknowledged. Dismiss-proof
 * until acknowledged.
 *
 * Polls /messaging/emergency-alerts?status=ACTIVE every 30s and
 * refetches on window focus. Renders nothing when no unack'd ACTIVE
 * alerts exist OR the user does not hold com-003:read.
 */
export function EmergencyAlertBanner() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasPermission(user, 'com-003:read');
  const { data: alerts } = useEmergencyAlerts({ status: 'ACTIVE' }, canRead);
  const ack = useAcknowledgeDelivery();

  if (!canRead || !alerts || alerts.length === 0) return null;

  // Render only alerts that need this user's acknowledgement —
  // alert.requiresAcknowledgement === true AND myDelivery exists AND
  // myDelivery.acknowledgedAt is null. Admins see the banner once
  // per active ack-required alert (their own delivery row drives it).
  const unack = alerts.filter(
    (a) => a.requiresAcknowledgement && a.myDelivery && a.myDelivery.acknowledgedAt === null,
  );
  if (unack.length === 0) return null;

  return (
    <div className="sticky top-0 z-40 w-full border-b border-rose-700 bg-rose-100">
      {unack.map((alert) => (
        <BannerRow
          key={alert.id}
          alert={alert}
          onAcknowledge={() => {
            if (alert.myDelivery) {
              ack.mutate(alert.myDelivery.id);
            }
          }}
          ackPending={ack.isPending}
        />
      ))}
    </div>
  );
}

function BannerRow({
  alert,
  onAcknowledge,
  ackPending,
}: {
  alert: EmergencyAlertDto;
  onAcknowledge: () => void;
  ackPending: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-700"
          />
          <span className="text-xs font-semibold uppercase tracking-wider text-rose-800">
            {alert.alertSeverity} · {alert.alertTypeName ?? 'Emergency'}
          </span>
        </div>
        <h2 className="mt-1 text-sm font-bold text-rose-900">{alert.title}</h2>
        <p className="mt-0.5 text-sm text-rose-900/90">{alert.body}</p>
        {alert.issuedByName && (
          <p className="mt-1 text-xs text-rose-700">Issued by {alert.issuedByName}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onAcknowledge}
        disabled={ackPending}
        className="shrink-0 rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {ackPending ? 'Acknowledging…' : 'Acknowledge'}
      </button>
    </div>
  );
}
