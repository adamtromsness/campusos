'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAuthStore, type AuthUser } from '@/lib/auth-store';
import { useAppBadges, type AppBadges } from '@/hooks/use-app-badges';
import { getAppsForUser, type AppDef } from '@/components/shell/apps';
import { cn } from '@/components/ui/cn';

export default function HomePage() {
  const user = useAuthStore((s) => s.user);
  const badges = useAppBadges(user);
  const [query, setQuery] = useState('');

  const apps = useMemo(() => (user ? getAppsForUser(user) : []), [user]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) => a.label.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
    );
  }, [apps, query]);

  if (!user) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 pt-12 pb-16 sm:pt-20">
      <Link
        href="/dashboard"
        className="select-none text-5xl font-semibold tracking-tight text-campus-700 sm:text-6xl"
      >
        CampusOS
      </Link>

      <p className="mt-6 text-center text-lg text-gray-600 sm:text-xl">{greetingFor(user)}</p>

      <div className="mt-8 w-full">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What would you like to do today?"
          className="w-full rounded-full border border-gray-200 bg-white px-6 py-4 text-base text-gray-900 shadow-card transition-shadow focus:border-campus-400 focus:outline-none focus:ring-4 focus:ring-campus-100"
          aria-label="Search apps"
        />
      </div>

      <div className="mt-10 grid w-full grid-cols-4 gap-x-3 gap-y-6 sm:grid-cols-6">
        {filtered.map((app) => (
          <AppTile key={app.key} app={app} badges={badges} />
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="mt-10 text-sm text-gray-500">No apps match &ldquo;{query}&rdquo;.</p>
      )}
    </div>
  );
}

function AppTile({ app, badges }: { app: AppDef; badges: AppBadges }) {
  const Icon = app.icon;
  const count = app.badgeKey ? badges[app.badgeKey] : 0;
  return (
    <Link
      href={app.href}
      title={app.description}
      className="group flex flex-col items-center gap-1.5 rounded-lg p-1 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-campus-300"
    >
      <span
        className={cn(
          'relative flex h-14 w-14 items-center justify-center rounded-2xl bg-campus-50 text-campus-600 transition',
          'group-hover:bg-campus-100 group-hover:text-campus-700 group-active:scale-95',
        )}
      >
        <Icon className="h-7 w-7" />
        {count > 0 && <UnreadBadge count={count} />}
      </span>
      <span className="line-clamp-1 text-xs text-gray-700 group-hover:text-gray-900">
        {app.label}
      </span>
    </Link>
  );
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} unread`}
      className="absolute -right-1 -top-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-white"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function greetingFor(user: AuthUser): string {
  const hour = new Date().getHours();
  const tod = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const name = user.preferredName || user.firstName || user.displayName;
  return `Good ${tod}, ${name}`;
}
