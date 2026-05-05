'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CHECKOUT_STATUS_PILL,
  COPY_LOCATION_STATUS_PILL,
  FINE_STATUS_PILL,
  HOLD_STATUS_PILL,
  LIBRARY_CHECKOUT_STATUS_LABELS,
  LIBRARY_COPY_LOCATION_STATUS_LABELS,
  LIBRARY_FINE_STATUS_LABELS,
  LIBRARY_HOLD_STATUS_LABELS,
  formatCurrency,
  formatDate,
  formatDaysUntilDue,
  isOverdue,
} from '@/lib/library-format';
import {
  useBarcodeLookup,
  useCheckouts,
  useFines,
  useHolds,
  useOverdueCheckouts,
} from '@/hooks/use-library';

/**
 * /library — Persona-aware library landing page.
 *
 * - Librarian / school admin sees the circulation desk shortcut +
 *   live overdue dashboard counts + active hold count + today's
 *   activity links.
 * - Patron (student / staff / parent) sees their own checkouts +
 *   holds + outstanding fines, plus a search shortcut to the
 *   catalogue.
 *
 * Both views share the search bar at the top — the catalogue is
 * public to everyone with lib-001:read.
 */
export default function LibraryDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-001:write']);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Library"
        description={
          isLibrarian
            ? 'Circulation desk, overdue dashboard, and catalogue management.'
            : 'Browse the catalogue, see your checkouts, place holds, and track fines.'
        }
      />

      <SearchBar />

      <QuickNav />

      {isLibrarian ? <LibrarianDashboard /> : <PatronDashboard />}
    </div>
  );
}

function QuickNav() {
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.personType === 'STUDENT';
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-001:write']);

  const links: { href: string; label: string }[] = [
    { href: '/library/catalogue', label: 'Catalogue' },
    { href: '/library/programmes', label: 'Reading programmes' },
    { href: '/library/reading-lists', label: 'Reading lists' },
  ];
  if (isStudent) {
    links.push({ href: '/library/reading-log', label: 'My reading log' });
    links.push({ href: '/library/my', label: 'My library' });
  }
  if (isLibrarian) {
    links.push({ href: '/library/circulation', label: 'Circulation desk' });
    links.push({ href: '/library/fines', label: 'Fines' });
  }

  return (
    <nav className="flex flex-wrap gap-2">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:border-campus-300 hover:text-campus-800"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

function SearchBar() {
  const [q, setQ] = useState('');
  return (
    <form
      action="/library/catalogue"
      method="get"
      className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:items-center"
    >
      <label htmlFor="library-q" className="text-sm font-medium text-gray-700 sm:w-32">
        Search catalogue
      </label>
      <input
        id="library-q"
        name="q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Title, author, or ISBN"
        className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
      />
      <button
        type="submit"
        className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
      >
        Search
      </button>
    </form>
  );
}

function LibrarianDashboard() {
  const overdueQ = useOverdueCheckouts();
  const holdsQ = useHolds({ status: 'PENDING' });
  const readyHoldsQ = useHolds({ status: 'READY' });
  const finesQ = useFines({ status: 'OUTSTANDING' });
  const todayQ = useCheckouts({ onlyActive: true });

  const overdueCount = overdueQ.data?.length ?? 0;
  const pendingHoldsCount = holdsQ.data?.length ?? 0;
  const readyHoldsCount = readyHoldsQ.data?.length ?? 0;
  const outstandingFineTotal = finesQ.data?.reduce((sum, f) => sum + Number(f.amount), 0) ?? 0;
  const todayCount = todayQ.data?.length ?? 0;

  return (
    <div className="space-y-6">
      <BarcodeScanCard />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DashboardStat
          label="Overdue checkouts"
          value={overdueCount}
          tone={overdueCount > 0 ? 'rose' : 'default'}
          href="/library/circulation?status=OVERDUE"
        />
        <DashboardStat
          label="Holds — pending"
          value={pendingHoldsCount}
          href="/library/circulation"
          tone="amber"
        />
        <DashboardStat
          label="Holds — ready for pickup"
          value={readyHoldsCount}
          href="/library/circulation"
          tone="emerald"
        />
        <DashboardStat
          label="Outstanding fines"
          value={formatCurrency(outstandingFineTotal)}
          href="/library/fines"
          tone={outstandingFineTotal > 0 ? 'rose' : 'default'}
        />
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Active checkouts</h2>
          <Link
            href="/library/circulation"
            className="text-sm font-medium text-campus-700 hover:text-campus-800"
          >
            See all →
          </Link>
        </div>
        {todayQ.isLoading ? (
          <LoadingSpinner />
        ) : todayCount === 0 ? (
          <p className="mt-4 text-sm text-gray-600">No active checkouts.</p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-100">
            {(todayQ.data ?? []).slice(0, 8).map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="font-medium text-gray-900">{c.itemTitle ?? '—'}</div>
                  <div className="text-xs text-gray-500">
                    {c.copyBarcode} · {c.patronName ?? c.patronId.slice(0, 8)}
                  </div>
                </div>
                <span
                  className={
                    'rounded px-2 py-0.5 text-xs font-medium ' +
                    (isOverdue(c.daysUntilDue)
                      ? CHECKOUT_STATUS_PILL.OVERDUE
                      : CHECKOUT_STATUS_PILL.ACTIVE)
                  }
                >
                  {formatDaysUntilDue(c.daysUntilDue)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PatronDashboard() {
  const myCheckoutsQ = useCheckouts();
  const myHoldsQ = useHolds();
  const myFinesQ = useFines({ status: 'OUTSTANDING' });

  const active = (myCheckoutsQ.data ?? []).filter(
    (c) => c.status === 'ACTIVE' || c.status === 'OVERDUE',
  );
  const recent = (myCheckoutsQ.data ?? []).filter((c) => c.status === 'RETURNED').slice(0, 5);
  const holds = (myHoldsQ.data ?? []).filter((h) => h.status === 'PENDING' || h.status === 'READY');
  const fines = (myFinesQ.data ?? []).filter((f) => f.status === 'OUTSTANDING');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">My active checkouts</h2>
        {myCheckoutsQ.isLoading ? (
          <LoadingSpinner />
        ) : active.length === 0 ? (
          <EmptyState
            title="No active checkouts"
            description="Browse the catalogue to find a book."
          />
        ) : (
          <ul className="mt-4 divide-y divide-gray-100">
            {active.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <div className="font-medium text-gray-900">{c.itemTitle ?? '—'}</div>
                  <div className="text-xs text-gray-500">
                    {c.copyBarcode} · checked out {formatDate(c.checkoutDate)}
                  </div>
                </div>
                <span
                  className={
                    'rounded px-2 py-0.5 text-xs font-medium ' +
                    (isOverdue(c.daysUntilDue)
                      ? CHECKOUT_STATUS_PILL.OVERDUE
                      : CHECKOUT_STATUS_PILL.ACTIVE)
                  }
                >
                  {formatDaysUntilDue(c.daysUntilDue)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">My holds</h2>
        {myHoldsQ.isLoading ? (
          <LoadingSpinner />
        ) : holds.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">No holds placed.</p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-100">
            {holds.map((h) => (
              <li key={h.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="font-medium text-gray-900">{h.itemTitle ?? '—'}</div>
                  <div className="text-xs text-gray-500">
                    Placed {formatDate(h.placedAt)}
                    {h.queuePosition !== null ? ` · queue position ${h.queuePosition}` : ''}
                  </div>
                </div>
                <span
                  className={
                    'rounded px-2 py-0.5 text-xs font-medium ' + HOLD_STATUS_PILL[h.status]
                  }
                >
                  {LIBRARY_HOLD_STATUS_LABELS[h.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {fines.length > 0 && (
        <section className="rounded-lg border border-rose-200 bg-rose-50/40 p-5">
          <h2 className="text-base font-semibold text-rose-900">Outstanding fines</h2>
          <p className="mt-1 text-xs text-rose-800">
            Visit the librarian to pay or discuss a waiver.
          </p>
          <ul className="mt-4 divide-y divide-rose-200">
            {fines.map((f) => (
              <li key={f.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="font-medium text-rose-900">{f.itemTitle ?? '—'}</div>
                  <div className="text-xs text-rose-800">
                    {f.fineType}
                    {f.daysOverdue !== null ? ` · ${f.daysOverdue} days late` : ''}
                  </div>
                </div>
                <span className="font-semibold text-rose-900">
                  {formatCurrency(Number(f.amount))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Recently returned</h2>
          <ul className="mt-4 divide-y divide-gray-100">
            {recent.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-gray-700">{c.itemTitle ?? '—'}</span>
                <span className="text-xs text-gray-500">Returned {formatDate(c.returnedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function BarcodeScanCard() {
  const [barcode, setBarcode] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const lookupQ = useBarcodeLookup(submitted);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Circulation desk</h2>
        <Link
          href="/library/circulation"
          className="text-sm font-medium text-campus-700 hover:text-campus-800"
        >
          Open desk →
        </Link>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Scan a barcode to find a copy + its current checkout state.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (barcode.trim()) setSubmitted(barcode.trim());
        }}
        className="mt-4 flex gap-2"
      >
        <input
          autoFocus
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          placeholder="Scan or type barcode"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
        <button
          type="submit"
          className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
        >
          Look up
        </button>
      </form>

      {submitted && lookupQ.isLoading && (
        <div className="mt-4">
          <LoadingSpinner />
        </div>
      )}
      {submitted && lookupQ.isError && (
        <p className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          No copy found for &quot;{submitted}&quot;.
        </p>
      )}
      {lookupQ.data && (
        <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-gray-900">{lookupQ.data.item.title}</div>
              <div className="text-xs text-gray-600">
                {lookupQ.data.item.author ?? '—'} · {lookupQ.data.copy.barcode}
              </div>
            </div>
            <span
              className={
                'rounded px-2 py-0.5 text-xs font-medium ' +
                COPY_LOCATION_STATUS_PILL[lookupQ.data.copy.locationStatus]
              }
            >
              {LIBRARY_COPY_LOCATION_STATUS_LABELS[lookupQ.data.copy.locationStatus]}
            </span>
          </div>
          {lookupQ.data.activeCheckout && (
            <div className="mt-3 text-xs text-gray-700">
              <span className="font-medium">Checked out by:</span>{' '}
              {lookupQ.data.activeCheckout.patronName ?? '—'} · due{' '}
              {lookupQ.data.activeCheckout.dueDate} (
              {formatDaysUntilDue(lookupQ.data.activeCheckout.daysUntilDue)})
            </div>
          )}
          <div className="mt-3 text-xs text-gray-500">
            <Link
              href={`/library/catalogue/${lookupQ.data.item.id}`}
              className="font-medium text-campus-700 hover:text-campus-800"
            >
              Open item →
            </Link>
            {lookupQ.data.pendingHoldsCount > 0 && (
              <span className="ml-3">
                {lookupQ.data.pendingHoldsCount} hold
                {lookupQ.data.pendingHoldsCount === 1 ? '' : 's'} pending
              </span>
            )}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500">
        Use the{' '}
        <Link
          href="/library/circulation"
          className="font-medium text-campus-700 hover:text-campus-800"
        >
          circulation desk
        </Link>{' '}
        to process checkouts, returns, and renewals.
      </p>
    </section>
  );
}

function DashboardStat({
  label,
  value,
  tone = 'default',
  href,
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'rose' | 'emerald' | 'amber';
  href?: string;
}) {
  const toneClass = {
    default: 'border-gray-200 bg-white',
    rose: 'border-rose-200 bg-rose-50/60',
    emerald: 'border-emerald-200 bg-emerald-50/60',
    amber: 'border-amber-200 bg-amber-50/60',
  }[tone];
  const toneText = {
    default: 'text-gray-900',
    rose: 'text-rose-900',
    emerald: 'text-emerald-900',
    amber: 'text-amber-900',
  }[tone];
  const card = (
    <div className={'rounded-lg border p-4 ' + toneClass}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={'mt-1 text-2xl font-semibold ' + toneText}>{value}</div>
    </div>
  );
  return href ? <Link href={href}>{card}</Link> : card;
}

// Suppress lint
void LIBRARY_CHECKOUT_STATUS_LABELS;
void LIBRARY_FINE_STATUS_LABELS;
void FINE_STATUS_PILL;
