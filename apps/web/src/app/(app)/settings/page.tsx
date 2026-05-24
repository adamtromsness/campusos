'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { ChildrenIcon, SettingsIcon } from '@/components/shell/icons';

/**
 * /settings — landing for user-scoped preferences and configuration.
 *
 * Currently the only nested settings page is /settings/family
 * (household preferences). The TopBar dropdown links here, so a stub
 * with a single tile is enough to keep the click from 404ing. Future
 * settings (notifications, security, accessibility) land alongside
 * family without changing the menu wiring.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Settings" description="Your preferences and account configuration" />

      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        <SettingsTile
          href="/settings/family"
          label="Family"
          description="Household, contacts, and shared preferences"
          icon={<ChildrenIcon className="h-5 w-5 text-campus-700" />}
        />
        <SettingsTile
          href="/profile"
          label="Profile"
          description="Name, contact, and other personal information"
          icon={<SettingsIcon className="h-5 w-5 text-campus-700" />}
        />
      </ul>
    </div>
  );
}

function SettingsTile({
  href,
  label,
  description,
  icon,
}: {
  href: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-3 rounded-card border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-campus-300 hover:bg-campus-50/40"
      >
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-campus-50"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{label}</p>
          <p className="mt-0.5 text-xs text-gray-600">{description}</p>
        </div>
      </Link>
    </li>
  );
}
