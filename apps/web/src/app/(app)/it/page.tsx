'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import {
  useItAssets,
  useItLicences,
  useItMdmAlerts,
  useItProcurement,
  useMyItAssignments,
} from '@/hooks/use-it';
import {
  useItFlaggedDeviceUsage,
  useItInfrastructureWarrantyExpiring,
  useItInventoryAudits,
  useItMonitoringAlerts,
} from '@/hooks/use-it-advanced';
import { IT_ASSET_STATUS_PILL, IT_ASSET_STATUS_LABELS } from '@/lib/it-format';
import { formatItDate, formatItRelative } from '@/lib/it-advanced-format';

/**
 * /it — IT landing page.
 *
 * Persona-aware:
 *   - Staff (IT admin): stat panel + quick links to manage assets,
 *     licences, vault, MDM, infrastructure, procurement, device
 *     options, plus the P2-20 IT Advanced surfaces — remote actions
 *     (via device detail), inventory audits, VOIP directory, IT
 *     documentation, uptime monitoring. Flagged device usage and
 *     active monitoring alerts surface at the top of the page so
 *     IT admins see them first.
 *   - Student / Teacher / Parent: own currently-assigned device
 *     plus a link to the parent-active device-selection flow
 *     under /it/my-device.
 */
export default function ItHomePage() {
  const user = useAuthStore((s) => s.user);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const isStudent = user?.activePersona?.type === 'STUDENT';
  const isParent = user?.activePersona?.type === 'PARENT';
  const isAdmin = hasAnyPermission(user, ['it-002:admin', 'sch-001:admin']);

  const myAssignments = useMyItAssignments(!isAdmin && !!user);

  const assets = useItAssets({});
  const licences = useItLicences();
  const alerts = useItMdmAlerts(true);
  const procurement = useItProcurement({});
  const flaggedUsage = useItFlaggedDeviceUsage(isStaff || isAdmin);
  const monitoringAlerts = useItMonitoringAlerts(true);
  const audits = useItInventoryAudits();
  const warranty = useItInfrastructureWarrantyExpiring(30);

  if (isStaff || isAdmin) {
    const totalAssets = assets.data?.length ?? 0;
    const repairCount = assets.data?.filter((a) => a.status === 'REPAIR').length ?? 0;
    const licenceCount = licences.data?.length ?? 0;
    const alertCount = alerts.data?.filter((a) => !a.isResolved).length ?? 0;
    const orderedCount = procurement.data?.filter((p) => p.status === 'ORDERED').length ?? 0;
    const flaggedCount = flaggedUsage.data?.length ?? 0;
    const monitoringDownCount = monitoringAlerts.data?.length ?? 0;
    const inProgressAudits = audits.data?.filter((a) => a.status === 'IN_PROGRESS').length ?? 0;
    const warrantyExpiringSoon = warranty.data?.length ?? 0;

    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <PageHeader title="IT Infrastructure" description="Asset fleet, licences, vault, MDM" />

        {flaggedCount > 0 || monitoringDownCount > 0 ? (
          <div className="space-y-3">
            {monitoringDownCount > 0 ? (
              <div className="rounded-md border border-rose-300 bg-rose-50 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-rose-900">
                    🚨 {monitoringDownCount} active monitoring alert
                    {monitoringDownCount === 1 ? '' : 's'}
                  </p>
                  <Link
                    href="/it/monitoring"
                    className="text-xs font-medium text-rose-700 hover:underline"
                  >
                    Review →
                  </Link>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-rose-800">
                  {monitoringAlerts.data?.slice(0, 3).map((a) => (
                    <li key={a.id}>
                      <strong>{a.systemName}</strong> — {a.alertType} ·{' '}
                      {formatItRelative(a.detectedAt)}
                    </li>
                  ))}
                  {monitoringDownCount > 3 ? (
                    <li className="text-xs text-rose-700">+ {monitoringDownCount - 3} more</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            {flaggedCount > 0 ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-amber-900">
                    ⚠️ {flaggedCount} device{flaggedCount === 1 ? '' : 's'} with flagged activity
                  </p>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-amber-800">
                  {flaggedUsage.data?.slice(0, 5).map((u) => (
                    <li key={u.id} className="flex items-center justify-between">
                      <span>
                        <Link
                          href={`/it/assets/${u.assetId}`}
                          className="font-mono font-semibold hover:underline"
                        >
                          {u.assetTag}
                        </Link>{' '}
                        — {formatItDate(u.summaryDate)}
                        {u.appsUsed.length > 0 ? ` · ${u.appsUsed.join(', ')}` : ''}
                      </span>
                    </li>
                  ))}
                  {flaggedCount > 5 ? (
                    <li className="text-xs text-amber-700">+ {flaggedCount - 5} more</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Assets" value={totalAssets} />
          <Stat
            label="In repair"
            value={repairCount}
            tone={repairCount > 0 ? 'amber' : undefined}
          />
          <Stat label="Licences" value={licenceCount} />
          <Stat
            label="Open MDM alerts"
            value={alertCount}
            tone={alertCount > 0 ? 'amber' : undefined}
          />
        </div>
        <nav className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <NavTile href="/it/assets" label="Assets" sub={`${totalAssets} devices`} />
          <NavTile href="/it/licences" label="Licences" sub={`${licenceCount} software`} />
          <NavTile href="/it/vault" label="Credential Vault" sub="Tiered access" />
          <NavTile href="/it/mdm" label="MDM" sub={`${alertCount} alerts`} />
          <NavTile
            href="/it/infrastructure"
            label="Infrastructure"
            sub={`${warrantyExpiringSoon} expiring`}
          />
          <NavTile href="/it/procurement" label="Procurement" sub={`${orderedCount} ordered`} />
          <NavTile href="/it/device-options" label="Device options" sub="Onboarding catalogue" />
          <NavTile
            href="/it/inventory-audits"
            label="Inventory audits"
            sub={`${inProgressAudits} in progress`}
          />
          <NavTile href="/it/phone-extensions" label="VOIP directory" sub="Phone extensions" />
          <NavTile href="/it/documentation" label="IT documentation" sub="Versioned" />
          <NavTile
            href="/it/monitoring"
            label="Uptime monitoring"
            sub={`${monitoringDownCount} active alerts`}
          />
        </nav>
      </div>
    );
  }

  // Student / Teacher / Parent — show currently-assigned devices
  const rows = myAssignments.data ?? [];
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <PageHeader
        title="My IT"
        description={
          isStudent
            ? 'Your assigned device + onboarding device selection'
            : isParent
              ? "Your child's device selection"
              : 'Your assigned IT equipment'
        }
      />
      {isStudent || isParent ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-4">
          <p className="text-sm font-medium text-sky-800">Onboarding</p>
          <p className="mt-1 text-sm text-sky-700">
            Pick a device for the upcoming year via the parent-active device selection workflow.
          </p>
          <Link
            href="/it/my-device"
            className="mt-2 inline-block rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
          >
            Choose a device →
          </Link>
        </div>
      ) : null}
      <h2 className="text-sm font-semibold text-gray-700">Currently assigned</h2>
      {rows.length === 0 ? (
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-500">
          No devices currently assigned.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded-md border border-gray-200 bg-white p-3"
            >
              <div>
                <p className="font-medium">{r.assetTag}</p>
                <p className="text-xs text-gray-500">
                  Assigned {new Date(r.assignedAt).toLocaleDateString()}
                </p>
              </div>
              <span className={`rounded px-2 py-0.5 text-xs ${IT_ASSET_STATUS_PILL.ASSIGNED}`}>
                {IT_ASSET_STATUS_LABELS.ASSIGNED}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'amber' | 'rose' | 'emerald';
}) {
  const colours: Record<NonNullable<typeof tone>, string> = {
    amber: 'text-amber-700',
    rose: 'text-rose-700',
    emerald: 'text-emerald-700',
  };
  const toneClass = tone ? colours[tone] : 'text-gray-900';
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function NavTile({ href, label, sub }: { href: string; label: string; sub: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-gray-200 bg-white p-4 transition hover:border-campus-400 hover:bg-campus-50"
    >
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-xs text-gray-500">{sub}</p>
    </Link>
  );
}
