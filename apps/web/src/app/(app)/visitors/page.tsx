'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useOnSite, usePreRegistrations, useSignOut, useActiveMuster } from '@/hooks/use-visitors';
import {
  BADGE_COLOR_PILL,
  formatDateTime,
  formatRelative,
  SAFEGUARDING_STATUS_LABEL,
  SAFEGUARDING_STATUS_PILL,
} from '@/lib/visitors-format';

/**
 * /visitors — reception dashboard.
 *
 * Three panels:
 *   1. Currently on-site — live count + per-visitor row with sign-out
 *      button. Walks the partial INDEX vis_si_active_idx.
 *   2. Today's pre-registrations — expected visitors with arrival
 *      status.
 *   3. Active emergency muster banner — when an open muster exists,
 *      shows a rose-tinted callout with a deep link to /visitors/muster.
 */
export default function VisitorsDashboard() {
  const user = useAuthStore((s) => s.user);
  const onSiteQ = useOnSite();
  const preRegsQ = usePreRegistrations();
  const activeMusterQ = useActiveMuster();
  const signOut = useSignOut();
  const { toast } = useToast();

  const isAdmin = user ? hasAnyPermission(user, ['sch-001:admin']) : false;
  const canWrite = user ? hasAnyPermission(user, ['saf-002:write']) : false;

  const onSite = onSiteQ.data ?? [];
  const preRegs = preRegsQ.data ?? [];
  const activeMuster = activeMusterQ.data ?? null;

  async function handleSignOut(id: string, name: string) {
    if (!confirm('Sign out ' + name + '?')) return;
    try {
      await signOut.mutateAsync(id);
      toast(name + ' signed out', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visitors"
        description="Reception dashboard, kiosk sign-in, pre-registrations, and emergency muster."
      />

      {/* Active muster banner */}
      {activeMuster && (
        <div className="rounded-lg border-2 border-rose-300 bg-rose-50 p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-base font-semibold text-rose-900">
                ⚠ Emergency muster in progress
              </h2>
              <p className="mt-1 text-sm text-rose-800">
                {activeMuster.totalOnSiteAtSnapshot} visitor(s) snapshotted at{' '}
                {formatDateTime(activeMuster.createdAt)}. Mark each as accounted for or evacuated.
              </p>
            </div>
            <Link
              href={'/visitors/muster/' + activeMuster.id}
              className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Open muster
            </Link>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="flex flex-wrap gap-3">
        {canWrite && (
          <Link
            href="/visitors/kiosk"
            className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-800"
          >
            Open kiosk
          </Link>
        )}
        {canWrite && (
          <Link
            href="/visitors/pre-register"
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Pre-register a visitor
          </Link>
        )}
        {canWrite && (
          <Link
            href="/visitors/muster"
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Emergency muster
          </Link>
        )}
        {isAdmin && (
          <Link
            href="/visitors/admin/banned"
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Banned persons
          </Link>
        )}
        {isAdmin && (
          <Link
            href="/visitors/admin/types"
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Visitor types
          </Link>
        )}
      </div>

      {/* On-site */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            Currently on site ({onSite.length})
          </h2>
          <Link href="/visitors/log" className="text-sm text-campus-700 hover:underline">
            Sign-in log →
          </Link>
        </div>
        {onSiteQ.isLoading ? (
          <LoadingSpinner />
        ) : onSite.length === 0 ? (
          <EmptyState
            title="No visitors on site"
            description="Walk-ins will appear here once the kiosk processes a sign-in."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500">
                  <th className="py-2 pr-4">Visitor</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Host</th>
                  <th className="py-2 pr-4">Purpose</th>
                  <th className="py-2 pr-4">Signed in</th>
                  <th className="py-2 pr-4">Safeguarding</th>
                  {canWrite && <th className="py-2 pr-4 text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {onSite.map((s) => (
                  <tr key={s.id} className="border-b border-gray-100 last:border-0">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-gray-900">{s.visitorName}</div>
                      {s.visitorCompany && (
                        <div className="text-xs text-gray-500">{s.visitorCompany}</div>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={
                          'inline-flex rounded px-2 py-0.5 text-xs font-medium ' +
                          (BADGE_COLOR_PILL[s.badgeColor] ?? '')
                        }
                      >
                        {s.visitorTypeName}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-700">{s.hostName ?? '—'}</td>
                    <td className="py-3 pr-4 text-gray-700">{s.purpose ?? '—'}</td>
                    <td className="py-3 pr-4 text-gray-700">{formatRelative(s.signedInAt)}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={
                          'inline-flex rounded px-2 py-0.5 text-xs ' +
                          SAFEGUARDING_STATUS_PILL[s.safeguardingCheckStatus]
                        }
                      >
                        {SAFEGUARDING_STATUS_LABEL[s.safeguardingCheckStatus]}
                      </span>
                    </td>
                    {canWrite && (
                      <td className="py-3 pr-4 text-right">
                        <button
                          onClick={() => handleSignOut(s.id, s.visitorName)}
                          className="text-sm font-medium text-campus-700 hover:underline"
                        >
                          Sign out
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pre-registrations */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">
          Upcoming pre-registrations ({preRegs.length})
        </h2>
        {preRegsQ.isLoading ? (
          <LoadingSpinner />
        ) : preRegs.length === 0 ? (
          <EmptyState
            title="No pre-registrations"
            description="Pre-register a visitor to send them a QR code for expedited sign-in."
          />
        ) : (
          <ul className="mt-4 space-y-2">
            {preRegs.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded border border-gray-100 px-3 py-2"
              >
                <div>
                  <div className="font-medium text-gray-900">{p.visitorName}</div>
                  <div className="text-xs text-gray-500">
                    {p.visitorCompany ? p.visitorCompany + ' · ' : ''}
                    Expected {formatDateTime(p.expectedAt)} · Host {p.hostName ?? '—'}
                  </div>
                </div>
                <div className="text-xs text-gray-500">
                  Token:{' '}
                  <code className="rounded bg-gray-100 px-1">{p.qrCodeToken.slice(0, 12)}…</code>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
