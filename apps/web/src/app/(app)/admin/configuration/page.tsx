'use client';

import Link from 'next/link';
import { type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { AcademicCapIcon, BuildingIcon, LinkIcon, OrgChartIcon } from '@/components/shell/icons';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useSetupStatus, type SetupStatus, type SetupStatusItem } from '@/hooks/use-configuration';

/**
 * School Configuration Admin — Step 1 Configuration Hub.
 *
 * Per docs/campusos-school-configuration-admin.html. The entry point
 * for all school configuration. Three structure cards (Facility /
 * Academic / Position) + a Connections card + a setup completeness
 * checklist + quick actions row.
 *
 * Gated on sys-001:admin which both Platform Admin and School Admin
 * hold (the latter via everyFunction). Non-admins are short-circuited
 * to a friendly EmptyState rather than 404 — the gate is enforced
 * server-side on every API call regardless of what the UI surfaces.
 *
 * The setup completeness checklist is computed live by the
 * setup-status endpoint from existing tenant data — no
 * setup_progress table.
 */
export default function ConfigurationHubPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const setup = useSetupStatus(isAdmin);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Configuration" />
        <EmptyState
          title="Admin access required"
          description="The Configuration hub is gated on the SYS-001:admin permission, held by Platform Admin and School Admin roles."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        title="Configuration"
        description="The three organisational structures of your school — Facility, Academic, and Position — plus the connections between them."
      />

      {/* Three structure cards + connections card */}
      <section className="grid gap-4 sm:grid-cols-2">
        <StructureCard
          icon={<BuildingIcon className="h-7 w-7" />}
          title="Facility Structure"
          subtitle="Campus → Building → Floor → Room"
          description="Buildings, floors, and rooms — the physical plant. Bulk import rooms via CSV."
          href="/admin/configuration/facilities"
          tone="emerald"
        />
        <StructureCard
          icon={<AcademicCapIcon className="h-7 w-7" />}
          title="Academic Structure"
          subtitle="District → School → Grade → Class"
          description="Academic year, terms, grade bands, and classes. The time and content structure."
          href="/admin/configuration/academic"
          tone="sky"
        />
        <StructureCard
          icon={<OrgChartIcon className="h-7 w-7" />}
          title="Position Structure"
          subtitle="Department → Position → Person"
          description="Org chart, departments, positions, and the people who fill them."
          href="/admin/configuration/positions"
          tone="violet"
        />
        <StructureCard
          icon={<LinkIcon className="h-7 w-7" />}
          title="Connections"
          subtitle="How the structures fit together"
          description="School ↔ buildings, positions ↔ schools, people ↔ positions, classes ↔ rooms. Sankey + tables."
          href="/admin/configuration/connections"
          tone="amber"
        />
      </section>

      {/* Setup completeness checklist */}
      <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Setup completeness</h2>
          {setup.data && (
            <p className="text-sm text-gray-600">
              <span className="font-semibold text-campus-700">{setup.data.completedCount}</span>
              {' of '}
              <span className="font-semibold">{setup.data.totalCount}</span>
              {' complete'}
            </p>
          )}
        </div>

        {setup.isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <LoadingSpinner size="sm" /> Loading setup status…
          </div>
        )}

        {setup.isError && (
          <p className="text-sm text-rose-600">
            Failed to load setup status. Refresh the page to try again.
          </p>
        )}

        {setup.data && (
          <ol className="space-y-2">
            {setup.data.items.map((item) => (
              <SetupRow key={item.key} item={item} />
            ))}
          </ol>
        )}

        <p className="mt-4 text-xs text-gray-500">
          Each item is computed from existing tenant data on render. Items show{' '}
          <span className="font-semibold text-emerald-700">DONE</span> when the count meets the
          threshold, <span className="font-semibold text-amber-700">PARTIAL</span> when below it,
          and <span className="font-semibold text-gray-500">NOT STARTED</span> at zero.
        </p>
      </section>

      {/* Quick actions */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
          Quick actions
        </h2>
        <div className="flex flex-wrap gap-2">
          <QuickActionLink
            href="/admin/configuration/facilities?action=add-building"
            label="Add Building"
          />
          <QuickActionLink
            href="/admin/configuration/academic?action=add-class"
            label="Add Class"
          />
          <QuickActionLink
            href="/admin/configuration/positions?action=add-position"
            label="Add Position"
          />
          <QuickActionLink href="/admin/setup-wizard" label="Setup wizard →" highlighted />
        </div>
      </section>
    </div>
  );
}

// ─── Components ───────────────────────────────────────────────────

interface StructureCardProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  description: string;
  href: string;
  tone: 'emerald' | 'sky' | 'violet' | 'amber';
}

function StructureCard({ icon, title, subtitle, description, href, tone }: StructureCardProps) {
  const toneClasses: Record<StructureCardProps['tone'], { bg: string; text: string }> = {
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700' },
    sky: { bg: 'bg-sky-50', text: 'text-sky-700' },
    violet: { bg: 'bg-violet-50', text: 'text-violet-700' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-700' },
  };
  const t = toneClasses[tone];
  return (
    <Link
      href={href}
      className="group rounded-card border border-gray-200 bg-white p-5 shadow-card transition hover:border-campus-300 hover:shadow-card-hover"
    >
      <div className="flex items-start gap-4">
        <div className={`rounded-lg ${t.bg} p-3 ${t.text}`}>{icon}</div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-gray-900 group-hover:text-campus-700">
            {title}
          </h3>
          <p className="mt-0.5 text-xs uppercase tracking-wide text-gray-500">{subtitle}</p>
          <p className="mt-2 text-sm leading-snug text-gray-600">{description}</p>
        </div>
      </div>
    </Link>
  );
}

function SetupRow({ item }: { item: SetupStatusItem }) {
  const dot = renderStatusDot(item.status);
  const countLabel = renderCountLabel(item);
  const labelClass = item.status === 'NOT_STARTED' ? 'text-gray-500' : 'text-gray-900';

  return (
    <li className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-gray-50">
      <div className="flex min-w-0 items-center gap-3">
        {dot}
        <span className={`text-sm font-medium ${labelClass}`}>{item.label}</span>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-gray-500">{countLabel}</span>
    </li>
  );
}

function renderStatusDot(status: SetupStatus): ReactNode {
  if (status === 'DONE') {
    return (
      <span
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
        aria-label="Done"
        title="Done"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2.5}
          stroke="currentColor"
          className="h-3 w-3"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </span>
    );
  }
  if (status === 'PARTIAL') {
    return (
      <span
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100"
        aria-label="Partial"
        title="Partial"
      >
        <span className="h-2 w-2 rounded-full bg-amber-500" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100"
      aria-label="Not started"
      title="Not started"
    >
      <span className="h-2 w-2 rounded-full bg-gray-300" />
    </span>
  );
}

function renderCountLabel(item: SetupStatusItem): string {
  if (item.status === 'NOT_STARTED') return 'none';
  if (item.status === 'PARTIAL') return `${item.count} (need ${item.doneThreshold}+)`;
  return item.count === 1 ? '1' : `${item.count}`;
}

function QuickActionLink({
  href,
  label,
  highlighted,
}: {
  href: string;
  label: string;
  highlighted?: boolean;
}) {
  if (highlighted) {
    return (
      <Link
        href={href}
        className="inline-flex items-center rounded-full bg-campus-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
      >
        {label}
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:border-campus-300 hover:bg-campus-50"
    >
      {label}
    </Link>
  );
}
