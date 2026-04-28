'use client';

import { type ReactNode } from 'react';
import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import {
  AttendanceIcon,
  CalendarIcon,
  ChatBubbleIcon,
  CheckCircleIcon,
  ChildrenIcon,
  ClassesIcon,
  MegaphoneIcon,
  PeopleIcon,
} from './icons';

export type AppKey =
  | 'classes'
  | 'children'
  | 'messages'
  | 'announcements'
  | 'staff'
  | 'leave'
  | 'compliance'
  | 'schedule';
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

  if (hasAnyPermission(user, ['hr-001:read'])) {
    apps.push({
      key: 'staff',
      label: 'Staff',
      description: 'Employee directory and profiles',
      href: '/staff',
      icon: PeopleIcon,
    });
  }

  if (hasAnyPermission(user, ['hr-003:read'])) {
    apps.push({
      key: 'leave',
      label: 'Leave',
      description: 'Balances, requests, and approvals',
      href: '/leave',
      icon: AttendanceIcon,
    });
  }

  if (hasAnyPermission(user, ['sch-001:read'])) {
    apps.push({
      key: 'schedule',
      label: 'Schedule',
      description: 'Bell schedules, timetable, rooms, and bookings',
      href: '/schedule/timetable',
      icon: CalendarIcon,
    });
  }

  if (hasAnyPermission(user, ['sch-001:admin', 'hr-004:admin'])) {
    apps.push({
      key: 'compliance',
      label: 'Compliance',
      description: 'School-wide training compliance',
      href: '/compliance',
      icon: CheckCircleIcon,
    });
  }

  return apps;
}
