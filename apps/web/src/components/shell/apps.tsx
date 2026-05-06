'use client';

import { type ReactNode } from 'react';
import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import {
  AcademicCapIcon,
  AttendanceIcon,
  BanknotesIcon,
  BookIcon,
  BusIcon,
  CalendarIcon,
  UtensilsIcon,
  WrenchIcon,
  ChatBubbleIcon,
  CheckCircleIcon,
  ChecklistIcon,
  ChildrenIcon,
  ClassesIcon,
  ComputerIcon,
  GavelIcon,
  HeartHandIcon,
  HeartIcon,
  LifebuoyIcon,
  MegaphoneIcon,
  PeopleIcon,
  ShieldExclamationIcon,
  TrophyIcon,
} from './icons';

export type AppKey =
  | 'classes'
  | 'children'
  | 'messages'
  | 'announcements'
  | 'tasks'
  | 'approvals'
  | 'staff'
  | 'leave'
  | 'compliance'
  | 'schedule'
  | 'calendar'
  | 'admissions'
  | 'apply'
  | 'billing'
  | 'helpdesk'
  | 'behaviour'
  | 'health'
  | 'counselling'
  | 'wellbeing'
  | 'library'
  | 'athletics'
  | 'meetings'
  | 'clubs'
  | 'groups'
  | 'transport'
  | 'food-service'
  | 'facilities'
  | 'it';
export type BadgeKey =
  | 'messages'
  | 'announcements'
  | 'tasks'
  | 'approvals'
  | 'helpdesk'
  | 'behaviour';

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

  if (hasAnyPermission(user, ['ops-001:read'])) {
    apps.push({
      key: 'tasks',
      label: 'Tasks',
      description: 'Your to-do list',
      href: '/tasks',
      icon: ChecklistIcon,
      badgeKey: 'tasks',
    });
    apps.push({
      key: 'approvals',
      label: 'Approvals',
      description: 'Review requests + my submissions',
      href: '/approvals',
      routePrefix: '/approvals',
      icon: GavelIcon,
      badgeKey: 'approvals',
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
      description: isGuardian
        ? 'Your balance, invoices, and payments'
        : 'Fees, invoices, family accounts, and payments',
      href: isGuardian ? '/billing' : '/billing/accounts',
      routePrefix: '/billing',
      icon: BanknotesIcon,
    });
  }

  if (hasAnyPermission(user, ['it-001:read'])) {
    apps.push({
      key: 'helpdesk',
      label: 'Helpdesk',
      description: 'Submit a ticket and track requests',
      href: '/helpdesk',
      routePrefix: '/helpdesk',
      icon: LifebuoyIcon,
      badgeKey: 'helpdesk',
    });
  }

  if (hasAnyPermission(user, ['beh-001:read'])) {
    apps.push({
      key: 'behaviour',
      label: 'Behaviour',
      description: isGuardian
        ? 'Your child’s incident history'
        : 'Report incidents and review the discipline queue',
      href: '/behaviour',
      routePrefix: '/behaviour',
      icon: ShieldExclamationIcon,
      badgeKey: 'behaviour',
    });
  }

  if (hasAnyPermission(user, ['hlt-001:read'])) {
    apps.push({
      key: 'health',
      label: 'Health',
      description: isGuardian
        ? 'Your child’s health summary'
        : 'Nurse dashboard, medications, visits, and IEPs',
      href: '/health',
      routePrefix: '/health',
      icon: HeartIcon,
    });
  }

  if (hasAnyPermission(user, ['cou-001:read'])) {
    apps.push({
      key: 'counselling',
      label: 'Counselling',
      description: isGuardian
        ? 'Your child’s caseload assignment'
        : 'Caseloads, referrals, sessions, and FERPA-protected notes',
      href: '/counselling',
      routePrefix: '/counselling',
      icon: HeartHandIcon,
    });
  }

  // Cycle 11.1 — Student-facing wellbeing check-in tile. Students hold
  // COU-004:read for own check-ins / own responses only. Other personas
  // (counsellor / admin / teacher) reach the wellbeing surface via the
  // Counselling tile + /counselling/wellbeing nested area, so the tile
  // is intentionally gated on isStudent rather than just COU-004:read.
  // The first student-input surface in CampusOS.
  if (isStudent && hasAnyPermission(user, ['cou-004:read'])) {
    apps.push({
      key: 'wellbeing',
      label: 'Wellbeing',
      description: 'Pending check-ins and your response history',
      href: '/wellbeing',
      routePrefix: '/wellbeing',
      icon: HeartIcon,
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

  // Cycle 12 — Library tile gated on lib-001:read (held by every persona
  // including parent). Persona-aware copy: librarian sees the
  // circulation-desk shortcut; patrons see the catalogue browse +
  // own checkouts/holds. The /library landing page branches on
  // persona to show the right view, so the tile route is shared.
  if (hasAnyPermission(user, ['lib-001:read'])) {
    const isLibrarian = isAdmin || (isStaff && hasAnyPermission(user, ['lib-001:write']));
    apps.push({
      key: 'library',
      label: 'Library',
      description: isLibrarian
        ? 'Catalogue, circulation desk, and fines'
        : isStudent
          ? 'Browse the catalogue, your checkouts, and reading log'
          : isGuardian
            ? 'Browse the school library catalogue'
            : 'Catalogue and your checkouts',
      href: '/library',
      routePrefix: '/library',
      icon: BookIcon,
    });
  }

  // Cycle 13 — Athletics tile gated on ath-001:read (held by every
  // persona). The /athletics landing page branches on persona —
  // AD/admin see programmes + rosters management; students see "My
  // sports" + game schedule; teachers + parents see programme
  // browse + game schedule.
  // Cycle 15 — Meetings tile gated on mtg-001:read (held by every
  // persona since Step 3). Persona-aware copy.
  if (hasAnyPermission(user, ['mtg-001:read'])) {
    apps.push({
      key: 'meetings',
      label: 'Meetings',
      description: isAdmin
        ? 'Conferences, meetings, action items, IEP records'
        : isStaff
          ? 'My meetings, agenda, notes, action items'
          : isGuardian
            ? 'Conferences, my appointments, action items'
            : 'My meetings and action items',
      href: '/meetings',
      routePrefix: '/meetings',
      icon: CalendarIcon,
    });
  }

  if (hasAnyPermission(user, ['ath-001:read'])) {
    const isAthleticDirector = isAdmin || (isStaff && hasAnyPermission(user, ['ath-001:write']));
    apps.push({
      key: 'athletics',
      label: 'Athletics',
      description: isAthleticDirector
        ? 'Programmes, rosters, games, results, injuries'
        : isStudent
          ? 'My sports, game schedule, and stats'
          : isGuardian
            ? 'Game schedule and athletic programmes'
            : 'Athletic programmes and game schedule',
      href: '/athletics',
      routePrefix: '/athletics',
      icon: TrophyIcon,
    });
  }

  // Clubs & Student Life — every persona who can read activities
  if (hasAnyPermission(user, ['clb-001:read'])) {
    apps.push({
      key: 'clubs',
      label: isStudent ? 'My Clubs' : isGuardian ? "My Children's Clubs" : 'Clubs',
      description: isStaff
        ? 'Activities, field trips, elections, service hours'
        : isStudent
          ? 'My clubs, elections, service hours'
          : isGuardian
            ? "Your children's activities and field trips"
            : 'Clubs and student life',
      href: isStudent ? '/clubs/my' : '/clubs',
      routePrefix: '/clubs',
      icon: PeopleIcon,
    });
  }

  // Transportation — every persona who can read routes / passes (Cycle 19).
  // Opens Wave 4 (Campus Operations). Transportation Coordinator (TC, Staff
  // role) drives the management surface; parents and students see the
  // route + bus pass + ridership-history view via row-scoped backend
  // endpoints.
  if (hasAnyPermission(user, ['trn-001:read'])) {
    apps.push({
      key: 'transport',
      label: 'Transportation',
      description: isStaff
        ? 'Routes, fleet, drivers, ridership'
        : isStudent
          ? 'My route + bus pass'
          : isGuardian
            ? "Your child's route + bus pass + change requests"
            : 'Routes and bus passes',
      href: '/transport',
      routePrefix: '/transport',
      icon: BusIcon,
    });
  }

  // Food Service — every persona who can read menus (Cycle 20). Wave 4 cycle 2.
  // Food Service Manager (FSM, Staff role) drives menu planning + POS + dietary +
  // safety operations. Parents see their child's dietary profile + meal plan via
  // FDS-003:read; students see today's menu via FDS-001:read.
  if (hasAnyPermission(user, ['fds-001:read'])) {
    apps.push({
      key: 'food-service',
      label: 'Food Service',
      description: isStaff
        ? 'Menus, POS, dietary, food safety'
        : isStudent
          ? "Today's menu + my dietary profile"
          : isGuardian
            ? "Your child's menu, dietary profile, and meal history"
            : 'Menus and food service',
      href: '/food-service',
      routePrefix: '/food-service',
      icon: UtensilsIcon,
    });
  }

  // Cycle 21 — Facilities Management. The Facilities Manager (FM) is the
  // eighth specialist operator persona. Teachers + staff hold FAC-001:read
  // (browse buildings, book spaces). FM holds FAC-001..004 read+write per
  // the Step 4 IAM grant on the Staff role. Persona-aware copy.
  if (hasAnyPermission(user, ['fac-001:read'])) {
    apps.push({
      key: 'facilities',
      label: 'Facilities',
      description: isStaff
        ? 'Buildings, work orders, PM, inspections, zones, supply'
        : 'Buildings and space booking',
      href: '/facilities',
      routePrefix: '/facilities',
      icon: WrenchIcon,
    });
  }

  // Cycle 22 — IT Infrastructure. The IT Administrator (IT admin)
  // is the ninth specialist operator persona. Teachers + students
  // hold IT-002:read (own assigned device); IT admin holds
  // IT-002..006 read+write per the Step 4 IAM grant on the Staff
  // role. Vault tier check (CredentialVaultService.getById) is
  // the actual SECURITY KEYSTONE — STANDARD-tier Staff cannot
  // decrypt CRITICAL credentials even with IT-005:read.
  if (hasAnyPermission(user, ['it-002:read', 'it-003:read'])) {
    apps.push({
      key: 'it',
      label: 'IT',
      description: isStaff
        ? 'Assets, licences, vault, MDM, infrastructure, procurement'
        : isStudent
          ? 'Your device + select a device during onboarding'
          : 'Device selection for your child',
      href: '/it',
      routePrefix: '/it',
      icon: ComputerIcon,
    });
  }

  // Groups & Communities — every persona who can read groups (Cycle 18).
  // Universal community fabric: scope-aware groups (CLASS / YEAR_GROUP /
  // SCHOOL / CUSTOM / ACTIVITY), 3-tier role hierarchy, two-party
  // ownership transfer handshake, group announcements + events with RSVP.
  if (hasAnyPermission(user, ['grp-001:read'])) {
    apps.push({
      key: 'groups',
      label: 'Groups',
      description: isStaff
        ? 'Communities, announcements, and events'
        : isStudent
          ? 'My groups + announcements'
          : isGuardian
            ? 'Parent groups and community events'
            : 'Groups and communities',
      href: '/groups',
      routePrefix: '/groups',
      icon: ChatBubbleIcon,
    });
  }

  return apps;
}
