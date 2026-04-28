'use client';

import { type ReactNode } from 'react';
import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import { ChatBubbleIcon, ChildrenIcon, ClassesIcon, MegaphoneIcon } from './icons';

export type AppKey = 'classes' | 'children' | 'messages' | 'announcements';
export type BadgeKey = 'messages' | 'announcements';

export interface AppDef {
  key: AppKey;
  label: string;
  description: string;
  href: string;
  icon: (props: { className?: string }) => ReactNode;
  badgeKey?: BadgeKey;
}

/**
 * Persona-aware app catalogue. The home launchpad and the sidebar both
 * render from this list, so adding a new app or changing its label only
 * needs to happen here.
 */
export function getAppsForUser(user: AuthUser): AppDef[] {
  const apps: AppDef[] = [];
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user.personType === 'STAFF';
  const isStudent = user.personType === 'STUDENT';
  const isGuardian = user.personType === 'GUARDIAN';

  if (isAdmin || isStaff) {
    apps.push({
      key: 'classes',
      label: 'Classes',
      description: 'Roster, attendance, and gradebooks',
      href: '/classes',
      icon: ClassesIcon,
    });
  } else if (isStudent) {
    apps.push({
      key: 'classes',
      label: 'My Classes',
      description: 'Your classes and grades',
      href: '/classes',
      icon: ClassesIcon,
    });
  } else if (isGuardian) {
    apps.push({
      key: 'children',
      label: 'My Children',
      description: 'Attendance, grades, and absence requests',
      href: '/children',
      icon: ChildrenIcon,
    });
  }

  if (hasAnyPermission(user, ['com-001:read'])) {
    apps.push({
      key: 'messages',
      label: 'Messages',
      description: 'Direct conversations',
      href: '/messages',
      icon: ChatBubbleIcon,
      badgeKey: 'messages',
    });
  }

  if (hasAnyPermission(user, ['com-002:read'])) {
    apps.push({
      key: 'announcements',
      label: 'Announcements',
      description: 'School-wide bulletins',
      href: '/announcements',
      icon: MegaphoneIcon,
      badgeKey: 'announcements',
    });
  }

  return apps;
}
