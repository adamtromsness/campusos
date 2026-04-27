'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import { cn } from '@/components/ui/cn';
import { AttendanceIcon, ClassesIcon, HomeIcon, PeopleIcon, SettingsIcon } from './icons';

interface NavItem {
  href: string;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
  visibleFor: (user: AuthUser) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: HomeIcon,
    visibleFor: () => true,
  },
  {
    href: '/classes',
    label: 'Classes',
    icon: ClassesIcon,
    visibleFor: (u) =>
      u.personType === 'STAFF' &&
      hasAnyPermission(u, ['att-001:read', 'sch-005:read', 'clr-001:read']),
  },
  {
    href: '/attendance',
    label: 'Attendance',
    icon: AttendanceIcon,
    visibleFor: (u) => hasAnyPermission(u, ['att-001:read', 'att-001:write', 'att-001:admin']),
  },
  {
    href: '/students',
    label: 'Students',
    icon: PeopleIcon,
    visibleFor: (u) => hasAnyPermission(u, ['stu-001:read', 'stu-001:write', 'stu-001:admin']),
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    visibleFor: (u) => hasAnyPermission(u, ['sch-001:admin']),
  },
];

interface SidebarProps {
  user: AuthUser;
  schoolName?: string;
  onNavigate?: () => void;
}

export function Sidebar({ user, schoolName = 'CampusOS', onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => item.visibleFor(user));

  return (
    <aside className="flex h-full w-64 flex-col bg-campus-700 text-campus-100">
      <div className="flex h-16 items-center px-5">
        <span className="font-display text-2xl text-white">CampusOS</span>
      </div>
      <div className="border-y border-campus-600 px-5 py-3 text-xs uppercase tracking-wide text-campus-300">
        {schoolName}
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {items.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-campus-600 text-white'
                  : 'text-campus-100 hover:bg-campus-600/60 hover:text-white',
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
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
