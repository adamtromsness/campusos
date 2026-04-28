'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import { useAppBadges } from '@/hooks/use-app-badges';
import { cn } from '@/components/ui/cn';
import { getAppsForUser } from './apps';

interface SidebarProps {
  user: AuthUser;
  schoolName?: string;
  onNavigate?: () => void;
}

export function Sidebar({ user, schoolName = 'CampusOS', onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const apps = getAppsForUser(user);
  const badges = useAppBadges(user);

  return (
    <aside className="flex h-full w-64 flex-col bg-campus-700 text-campus-100">
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="flex h-16 items-center px-5 font-sans text-2xl font-semibold tracking-tight text-white"
      >
        CampusOS
      </Link>
      <div className="border-y border-campus-600 px-5 py-3 text-xs uppercase tracking-wide text-campus-300">
        {schoolName}
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {apps.map((app) => {
          const active = pathname === app.href || pathname?.startsWith(app.href + '/');
          const Icon = app.icon;
          const count = app.badgeKey ? badges[app.badgeKey] : 0;
          return (
            <Link
              key={app.href}
              href={app.href}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-campus-600 text-white'
                  : 'text-campus-100 hover:bg-campus-600/60 hover:text-white',
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="flex-1">{app.label}</span>
              {count > 0 && (
                <span
                  aria-label={`${count} unread`}
                  className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold leading-none text-white"
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-campus-600 px-5 py-3 text-xs text-campus-300">
        {personaLabel(user)}
      </div>
    </aside>
  );
}

function personaLabel(user: AuthUser): string {
  switch (user.personType) {
    case 'STAFF':
      return hasAnyPermission(user, ['sch-001:admin']) ? 'Administrator' : 'Staff';
    case 'GUARDIAN':
      return 'Parent / Guardian';
    case 'STUDENT':
      return 'Student';
    case 'VOLUNTEER':
      return 'Volunteer';
    case 'SUBSTITUTE':
      return 'Substitute';
    default:
      return 'Member';
  }
}
