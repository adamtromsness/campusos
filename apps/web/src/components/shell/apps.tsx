'use client';

import { type ReactNode } from 'react';
import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import {
  AcademicCapIcon,
  AttendanceIcon,
  BanknotesIcon,
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
  | 'schedule'
  | 'calendar'
  | 'admissions'
  | 'apply'
  | 'billing';
export type BadgeKey = 'messages' | 'announcements';

export interface AppDef {
  key: AppKey;
  label: string;
  description: string;
  href: string;
  icon: (props: { className?: string }) => ReactNode;
  badgeKey?: BadgeKey;
  /**
   * Optional prefix used by the Sidebar to decide whether the tile is the
   * active one. Defaults to the tile's `href`. Set this when the tile owns
   * a wider URL space than its own href — e.g. the Schedule tile lives at
   * `/schedule/timetable` but should also light up on `/schedule/coverage`,
   * `/schedule/rooms`, and so on.
   */
  routePrefix?: string;
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
      routePrefix: '/schedule',
      icon: CalendarIcon,
    });
  }

  if (hasAnyPermission(user, ['sch-003:read'])) {
    apps.push({
      key: 'calendar',
      label: 'Calendar',
      description: 'Holidays, PD days, and school events',
      href: '/calendar',
      icon: CalendarIcon,
    });
  }

  if (hasAnyPermission(user, ['stu-003:admin'])) {
    apps.push({
      key: 'admissions',
      label: 'Admissions',
      description: 'Enrollment periods, applications, offers, and waitlist',
      href: '/admissions/applications',
      routePrefix: '/admissions',
      icon: AcademicCapIcon,
    });
  } else if (isGuardian && hasAnyPermission(user, ['stu-003:write'])) {
    apps.push({
      key: 'apply',
      label: 'Apply',
      description: 'Submit and track admissions applications',
      href: '/apply',
      routePrefix: '/apply',
      icon: AcademicCapIcon,
    });
  }

  if (hasAnyPermission(user, ['fin-001:write'])) {
    apps.push({
      key: 'billing',
      label: 'Billing',
      description: 'Fees, invoices, family accounts, and payments',
      href: '/billing/accounts',
      routePrefix: '/billing',
      icon: BanknotesIcon,
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
