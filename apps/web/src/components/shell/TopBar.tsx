'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { PersonaSwitcher } from './PersonaSwitcher';
import { useAuthActions } from '@/lib/auth-context';
import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import { ChildrenIcon, LogoutIcon, MenuIcon, SettingsIcon } from './icons';

interface TopBarProps {
  user: AuthUser;
  onOpenMenu: () => void;
}

export function TopBar({ user, onOpenMenu }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const { logout } = useAuthActions();

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 lg:hidden"
          aria-label="Open navigation"
          onClick={onOpenMenu}
        >
          <MenuIcon />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <PersonaSwitcher />
        {hasAnyPermission(user, ['com-001:read', 'com-002:read']) && (
          <NotificationBell user={user} />
        )}
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-3 rounded-full px-2 py-1 text-left hover:bg-gray-50"
          >
            <Avatar name={user.displayName} size="sm" />
            <div className="hidden sm:block">
              <p className="text-sm font-medium text-gray-900">{user.displayName}</p>
              <p className="text-xs text-gray-500">{user.email}</p>
            </div>
          </button>

          {open && (
            <div
              className="absolute right-0 top-12 z-40 w-60 overflow-hidden rounded-card border border-gray-200 bg-white shadow-elevated"
              onMouseLeave={() => setOpen(false)}
            >
              <div className="border-b border-gray-100 px-4 py-3">
                <p className="text-sm font-medium text-gray-900">{user.displayName}</p>
                <p className="mt-0.5 text-xs text-gray-500">{user.email}</p>
              </div>
              {/* My Profile is intentionally not gated on usr-001:read.
                  Every authenticated user — including 0-persona
                  freshly-registered accounts — can edit their own
                  iam_person row via /profile (the API drops the gate
                  too). My Family + Settings follow the same rule. */}
              <MenuLink
                href="/profile"
                onSelect={() => setOpen(false)}
                label="My Profile"
              />
              <MenuLink
                href="/family"
                onSelect={() => setOpen(false)}
                label="My Family"
                icon={<ChildrenIcon className="h-4 w-4 text-gray-500" />}
              />
              <MenuLink
                href="/settings"
                onSelect={() => setOpen(false)}
                label="Settings"
                icon={<SettingsIcon className="h-4 w-4 text-gray-500" />}
              />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void logout();
                }}
                className="flex w-full items-center gap-2 border-t border-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                <LogoutIcon className="h-4 w-4 text-gray-500" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function MenuLink({
  href,
  label,
  icon,
  onSelect,
}: {
  href: string;
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
    >
      {icon ?? <span className="h-4 w-4" aria-hidden />}
      <span>{label}</span>
    </Link>
  );
}
