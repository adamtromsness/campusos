'use client';

import { type ReactNode } from 'react';
import { hasAnyPermission, type AuthUser, type PersonaType } from '@/lib/auth-store';
import {
  AcademicCapIcon,
  AttendanceIcon,
  BanknotesIcon,
  BookIcon,
  BusIcon,
  CalculatorIcon,
  CalendarIcon,
  ChartBarIcon,
  CogIcon,
  ShieldIcon,
  UtensilsIcon,
  WrenchIcon,
  ChatBubbleIcon,
  CheckCircleIcon,
  ChecklistIcon,
  ChildrenIcon,
  ClassesIcon,
  ComputerIcon,
  GavelIcon,
  MapIcon,
  HeartHandIcon,
  HeartIcon,
  LifebuoyIcon,
  MegaphoneIcon,
  NewspaperIcon,
  PeopleIcon,
  ShieldExclamationIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
  SparklesIcon,
  SubstitutesIcon,
  TicketIcon,
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
  | 'it'
  | 'curriculum'
  | 'portfolio'
  | 'publications'
  | 'finance'
  | 'procurement'
  | 'store'
  | 'analytics'
  | 'governance'
  | 'platform'
  | 'configuration'
  | 'visitors'
  | 'emergency'
  | 'development'
  | 'expenses'
  | 'enrolment-tours'
  | 'enrolment-withdrawals'
  | 'payments-advanced'
  | 'substitutes'
  | 'events'
  | 'alumni'
  | 'accreditation'
  | 'engagement';
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
  /**
   * Persona-type allowlist. When set, the tile only renders if the
   * active persona's type is in the list. When omitted the tile is
   * visible to every persona that holds the underlying permission —
   * the right default for admin / platform / universal surfaces (e.g.
   * Configuration, Platform, Compliance, Finance, Governance).
   *
   * Use this for surfaces that are inherently persona-specific even
   * when the permission codes are held by multiple personas, e.g.
   * Apply (parents), Substitutes (the SUBSTITUTE persona), Wellbeing
   * (students). The historical isStaff/isStudent/isParent conditionals
   * inside this function continue to label tiles per persona; the
   * `personas` array drops them entirely when the active persona is
   * the wrong one.
   */
  personas?: PersonaType[];
}

/**
 * Persona-aware app catalogue. The home launchpad and the sidebar both
 * render from this list, so adding a new app or changing its label only
 * needs to happen here.
 *
 * When the caller has no active persona (the "Getting Started" state
 * for a brand-new account with zero personas), the catalogue is empty
 * — the launchpad and sidebar both render their empty states, and the
 * user is routed to /getting-started by the AppLayout shell.
 *
 * After the per-permission IF guards push every candidate tile, we
 * filter again by `AppDef.personas` so persona-exclusive tiles (Apply,
 * Substitutes, Wellbeing) only surface for the right active persona
 * even when the underlying permission codes are held by multiple
 * personas.
 */
export function getAppsForUser(user: AuthUser): AppDef[] {
  if (!user.activePersona) return [];

  const apps: AppDef[] = [];
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user.activePersona.type === 'STAFF';
  const isStudent = user.activePersona.type === 'STUDENT';
  const isParent = user.activePersona.type === 'PARENT';

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
  } else if (isParent) {
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

  // P2-9 Sub Marketplace tile. Substitute self-service (sub-001:read)
  // routes to /substitutes/dashboard; admin coverage view (sch-004:read)
  // routes to /substitutes/coverage. Both gates land on the same tile,
  // and the routePrefix keeps the tile lit across every nested
  // /substitutes/* route.
  if (hasAnyPermission(user, ['sub-001:read', 'sch-004:read'])) {
    const isAdminView = hasAnyPermission(user, ['sch-004:read', 'sch-004:write', 'sch-001:admin']);
    apps.push({
      key: 'substitutes',
      label: 'Substitutes',
      description: isAdminView
        ? 'Coverage status, school pool, ratings, and pay rates'
        : 'Your job offers, assignments, and schedule preferences',
      href: isAdminView ? '/substitutes/coverage' : '/substitutes/dashboard',
      routePrefix: '/substitutes',
      icon: SubstitutesIcon,
      // STAFF gets the admin coverage view; SUBSTITUTE gets the
      // self-service dashboard. Hide from PARENT / STUDENT / ALUMNI /
      // COMMUNITY even when they incidentally hold a read code.
      personas: ['STAFF', 'SUBSTITUTE'],
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
  } else if (isParent && hasAnyPermission(user, ['stu-003:write'])) {
    apps.push({
      key: 'apply',
      label: 'Apply',
      description: 'Submit and track admissions applications',
      href: '/apply',
      routePrefix: '/apply',
      icon: AcademicCapIcon,
      personas: ['PARENT'],
    });
  }

  // P2-5 Tours — admin manages slots; everyone (incl. anonymous public)
  // can browse public slots, but the launchpad tile only shows for staff
  // who can manage them.
  if (hasAnyPermission(user, ['stu-003:read', 'stu-003:write', 'stu-003:admin'])) {
    apps.push({
      key: 'enrolment-tours',
      label: 'Tours',
      description: hasAnyPermission(user, ['stu-003:admin'])
        ? 'Schedule + publish campus tour slots, track bookings'
        : 'View available campus tours',
      href: '/enrolment/tours',
      routePrefix: '/enrolment/tours',
      icon: AcademicCapIcon,
    });
  }

  // P2-5 Withdrawal + Re-enrolment + Mid-Year — STU-004 surface.
  if (hasAnyPermission(user, ['stu-004:read', 'stu-004:write', 'stu-004:admin'])) {
    apps.push({
      key: 'enrolment-withdrawals',
      label: isParent ? 'Withdrawal & Re-enrolment' : 'Withdrawals',
      description: isParent
        ? 'Confirm next year, request mid-year admission, initiate withdrawal'
        : 'Manage withdrawals, re-enrolment, mid-year admissions, exit task templates',
      href: '/enrolment/withdrawals',
      routePrefix: '/enrolment',
      icon: AcademicCapIcon,
    });
  }

  if (hasAnyPermission(user, ['fin-001:write'])) {
    apps.push({
      key: 'billing',
      label: 'Billing',
      description: isParent
        ? 'Your balance, invoices, and payments'
        : 'Fees, invoices, family accounts, and payments',
      href: isParent ? '/billing' : '/billing/accounts',
      routePrefix: '/billing',
      icon: BanknotesIcon,
    });
  }

  // P2-6 — Payments Advanced. Adds financial aid, lunch accounts, and the
  // operational tooling (credit notes, reversals, late fees). Visible to
  // admins, finance officers, and parents (for lunch accounts + financial
  // aid applications).
  if (
    hasAnyPermission(user, ['fin-002:read', 'fin-002:write', 'fin-001:admin']) ||
    (isParent && hasAnyPermission(user, ['fin-001:read']))
  ) {
    apps.push({
      key: 'payments-advanced',
      label: isParent ? 'Payments' : 'Payments+',
      description: isParent
        ? 'Financial aid + lunch accounts'
        : 'Financial aid, fees, lunch, billing operations',
      href: '/payments',
      routePrefix: '/payments',
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
      description: isParent
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
      description: isParent
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
      description: isParent
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
      personas: ['STUDENT'],
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

  // P2-4c — Training + Appraisals (Development) tile gated on
  // hr-004:read OR hr-005:read so Teacher (own training history,
  // own appraisal) and Staff/Admin (admin pipeline) both reach
  // the surface. The /hr/training landing branches admin vs
  // self-view internally.
  if (hasAnyPermission(user, ['hr-004:read', 'hr-005:read', 'sch-001:admin'])) {
    apps.push({
      key: 'development',
      label: 'Development',
      description:
        isStaff || isAdmin
          ? 'Training programmes, appraisals, lesson observations'
          : 'Your training history and appraisal',
      href: '/hr/training',
      routePrefix: '/hr',
      icon: AcademicCapIcon,
    });
  }

  // P2-4c — Expense claims tile gated on hr-012:read (every
  // employee submits own claims; admin queue gated on HR-013 at
  // the service layer).
  if (hasAnyPermission(user, ['hr-012:read', 'hr-012:write', 'sch-001:admin'])) {
    apps.push({
      key: 'expenses',
      label: 'Expenses',
      description:
        isStaff || isAdmin
          ? 'Submit, approve, and track expense claims'
          : 'Submit and track your expense claims',
      href: '/hr/expense-claims',
      icon: BanknotesIcon,
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
          : isParent
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
          : isParent
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
          : isParent
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
      label: isStudent ? 'My Clubs' : isParent ? "My Children's Clubs" : 'Clubs',
      description: isStaff
        ? 'Activities, field trips, elections, service hours'
        : isStudent
          ? 'My clubs, elections, service hours'
          : isParent
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
          : isParent
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
          : isParent
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

  // Cycle 23 — Curriculum & Standards (Wave 5 opener). Teacher /
  // Curriculum Coordinator authors maps, units, alignments, and
  // resources. Parent + Student see PUBLISHED maps + non-teacher-
  // only resources. School Admin configures frameworks + adoptions.
  if (hasAnyPermission(user, ['tch-008:read'])) {
    apps.push({
      key: 'curriculum',
      label: 'Curriculum',
      description: isStaff
        ? 'Frameworks, curriculum maps, unit planning, delivery gaps'
        : isStudent
          ? "What you're learning this year"
          : 'Curriculum maps for your child',
      href: '/curriculum',
      routePrefix: '/curriculum',
      icon: MapIcon,
    });
  }

  // P2-23 — Accreditation (Wave D Module Completion). Accreditation
  // coordinator (Staff / School Admin) drives the self-study against
  // a platform-seeded framework. Evidence collection + ratings +
  // action plans + site visit readiness. Reuses TCH-008 per the plan
  // — the service layer (assertStaffOrAdmin / assertCoordinatorScope)
  // refuses Parent + Student even though they hold the gate-tier
  // tch-008:read for the curriculum surface.
  if (hasAnyPermission(user, ['tch-008:read']) && (isStaff || isAdmin)) {
    apps.push({
      key: 'accreditation',
      label: 'Accreditation',
      description: 'Frameworks, evidence, self-study, action plans, site visit readiness',
      href: '/accreditation',
      routePrefix: '/accreditation',
      icon: CheckCircleIcon,
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

  // Cycle 24 — Student Portfolio (Wave 5). The fourth student-input
  // surface in CampusOS and the FIRST truly student-owned surface.
  // Students curate their own portfolio (ach-002:write); teachers and
  // parents view via row scope + the student-controlled visibility
  // setting. Achievement gallery on every persona via ach-001:read.
  if (hasAnyPermission(user, ['ach-002:read', 'ach-001:read'])) {
    apps.push({
      key: 'portfolio',
      label: 'Portfolio',
      description: isStudent
        ? 'Your academic journey — items, achievements, share links'
        : isParent
          ? "Your child's portfolio + achievements"
          : isStaff
            ? 'Student portfolios + award achievements'
            : 'Achievements and portfolios',
      href: '/portfolio',
      routePrefix: '/portfolio',
      icon: SparklesIcon,
    });
  }

  // Cycle 25 — Publications. Closes Wave 5. Staff: series + editions
  // + content authoring + distribution. Reader: published feed +
  // subscription management. Student: contribute sections (ADR-035
  // pending approval).
  if (hasAnyPermission(user, ['pub-001:read'])) {
    apps.push({
      key: 'publications',
      label: 'Publications',
      description: isStaff
        ? 'Series, editions, sections, and distribution'
        : isStudent
          ? 'Newsletter feed and your contributions'
          : isParent
            ? 'School newsletter and bulletins'
            : 'School publications',
      href: '/publications',
      routePrefix: '/publications',
      icon: NewspaperIcon,
    });
  }

  // P2-22 — Alumni (Wave D Module Completion). Self-maintained
  // alumni profiles + opt-in directory + tag segmentation. Multi-
  // currency fundraising campaigns + outreach funnel. News, reunions,
  // events with optional P2-12 Events linkage. PUB-004:read covers
  // every persona that holds the function tier (Teacher, Parent, Student,
  // Staff, Admin). The portal description switches on persona because
  // a current student becomes the alumnus on this surface once they
  // graduate; a guardian or teacher who attended this school can also
  // self-register.
  if (hasAnyPermission(user, ['pub-004:read'])) {
    apps.push({
      key: 'alumni',
      label: 'Alumni',
      description: isStaff
        ? 'Campaigns, donations, news, reunions, events'
        : isStudent
          ? 'Your alumni profile (after graduation) and directory'
          : isParent
            ? 'Alumni directory and school news'
            : 'Directory, campaigns, news, events',
      href: '/alumni',
      routePrefix: '/alumni',
      icon: AcademicCapIcon,
    });
  }

  // Cycle 26 — Finance & Accounting (Wave 6 opener). The CFO /
  // Business Manager is the tenth specialist operator persona.
  // FIN-005..008 cover GL + budgets + AP + reconciliation/board
  // reports/grants. Finance is intentionally invisible to parents,
  // students, and teachers — only Staff (CFO stand-in) and admins
  // see the tile.
  if (hasAnyPermission(user, ['fin-005:read'])) {
    apps.push({
      key: 'finance',
      label: 'Finance',
      description: 'GL, chart of accounts, budgets, AP, reconciliation, board reports',
      href: '/finance',
      routePrefix: '/finance',
      icon: CalculatorIcon,
    });
  }

  // Cycle 27 — Procurement (Wave 6 continuation). The Procurement
  // Officer / Purchasing Clerk is the eleventh specialist operator
  // persona. PRC-001..003 cover requisitions, POs + receiving, and
  // distribution + returns + vendor performance. Procurement is
  // intentionally invisible to parents and students — only Staff
  // (Procurement Officer stand-in) and admins see the tile, plus
  // teachers who can submit their own requisitions via PRC-001.
  if (hasAnyPermission(user, ['prc-001:read'])) {
    apps.push({
      key: 'procurement',
      label: 'Procurement',
      description: isStaff
        ? 'Requisitions, POs, receiving, distribution, vendor performance'
        : 'Submit and track requisitions',
      href: '/procurement',
      routePrefix: '/procurement',
      icon: ShoppingCartIcon,
    });
  }

  // Cycle 28 — School Store (Wave 6 closeout). The store manager is
  // the twelfth specialist operator persona. STR-001..003 cover
  // products + inventory, orders + parent approval, external
  // customers + shipping + revenue. Every persona who can browse
  // (STR-001:read) sees the tile; checkout, approval, and admin
  // surfaces gate at the route level.
  if (hasAnyPermission(user, ['str-001:read'])) {
    apps.push({
      key: 'store',
      label: 'Store',
      description: isStaff
        ? 'Products, orders, fulfilment, and revenue'
        : isStudent
          ? 'School store — uniforms, supplies, yearbook'
          : isParent
            ? 'School store — approve and track student orders'
            : 'School store',
      href: '/store',
      routePrefix: '/store',
      icon: ShoppingBagIcon,
    });
  }

  // Cycle 29 — Analytics & Reporting (Wave 7 opener). The operational
  // read layer per ADR-008 CQRS-lite. Teachers (RPT-001:read) see their
  // own class-level dashboards. Managers (RPT-002:read = Staff +
  // School Admin) see school-wide dashboards + at-risk + report engine.
  // Superintendents (RPT-003 admin tier via everyFunction) see district
  // comparison.
  if (hasAnyPermission(user, ['rpt-001:read', 'rpt-002:read', 'rpt-003:read'])) {
    apps.push({
      key: 'analytics',
      label: 'Analytics',
      description: isStaff
        ? 'Attendance, academics, at-risk, and reports'
        : 'Class attendance and performance',
      href: '/analytics',
      routePrefix: '/analytics',
      icon: ChartBarIcon,
    });
  }

  // Data Governance & Compliance — DPO scope (Cycle 30, Wave 7 close).
  // dpo-001:read is the DPO-only baseline gate. Parents/students who
  // hold dpo-004:read+write reach SAR self-service via /apply or a
  // direct link, but they don't need the full Governance tile —
  // surfacing a tile to a parent would be the wrong UX.
  if (hasAnyPermission(user, ['dpo-001:read'])) {
    apps.push({
      key: 'governance',
      label: 'Data Governance',
      description: isStaff
        ? 'ROPA, processors, breach 72h countdown, SARs'
        : 'Data protection compliance',
      href: '/governance',
      routePrefix: '/governance',
      icon: ShieldIcon,
    });
  }

  // Platform Admin — Cycle 31 Step 9. Gated on sys-001:admin which only
  // Platform Admin holds (not School Admin). Surfaces tenant ops, DLQ,
  // partition health, and migration history. Hidden from every other
  // persona including school admins; the dashboards expose cross-tenant
  // state that crosses school boundaries.
  if (hasAnyPermission(user, ['sys-001:admin'])) {
    apps.push({
      key: 'platform',
      label: 'Platform',
      description: 'Tenant ops, DLQ, partitions, and migrations',
      href: '/admin/platform',
      routePrefix: '/admin/platform',
      icon: ComputerIcon,
    });
  }

  // School Configuration Admin — Step 1. Gated on sys-001:admin which
  // both Platform Admin and School Admin hold (the seed-iam everyFunction
  // grant on School Admin includes admin-tier on every function code,
  // including SYS-001). Surfaces the three organisational hierarchies
  // (Facility / Academic / Position) with their CRUD + the cross-
  // structure connections view + the setup wizard. Per-tenant: each
  // school configures its own data, unlike the cross-tenant Platform
  // tile above.
  if (hasAnyPermission(user, ['sys-001:admin'])) {
    apps.push({
      key: 'configuration',
      label: 'Configuration',
      description: 'Buildings, academic year, positions, and connections',
      href: '/admin/configuration',
      routePrefix: '/admin/configuration',
      icon: CogIcon,
    });
  }

  // P2C1 — Visitor Management. Tile gated on saf-002:read (Teacher,
  // Staff, Admin). Reception staff (Staff) see the kiosk + on-site
  // dashboard; admins additionally see the banned-persons + settings
  // surfaces. Teachers see the read-only on-site list.
  if (hasAnyPermission(user, ['saf-002:read'])) {
    apps.push({
      key: 'visitors',
      label: 'Visitors',
      description: isAdmin
        ? 'Kiosk, banned persons, muster, and settings'
        : isStaff
          ? 'Kiosk sign-in, on-site list, and pre-registrations'
          : 'Currently on-site visitors',
      href: '/visitors',
      routePrefix: '/visitors',
      icon: ShieldIcon,
    });
  }

  // P2C2 — Incident & Emergency. Tile gated on saf-001:read (Teacher,
  // Staff, Admin). Staff see the declaration panel + accountability +
  // reunification + drills + incident reports; admins additionally
  // see procedure CRUD + incident-type catalogue. Teachers see the
  // procedure viewer + drill schedule + their own non-discipline
  // incident reports (read via saf-003:read+write; write-path on the
  // /emergency/report form).
  if (hasAnyPermission(user, ['saf-001:read', 'saf-003:read'])) {
    apps.push({
      key: 'emergency',
      label: 'Emergency',
      description: isAdmin
        ? 'Declarations, procedures, accountability, reunification, drills'
        : isStaff
          ? 'Active incidents, accountability, reunification, drills, reports'
          : 'Procedures, drill schedule, and your incident reports',
      href: '/emergency',
      routePrefix: '/emergency',
      icon: ShieldIcon,
    });
  }

  // Phase 2 Cycle 12 — Events & Ticketing. Tile gated on evt-001:read
  // (held by Parent, Staff, Admin). Persona-aware copy: librarian-like
  // pattern — Staff/Admin see admin shortcuts (event calendar + gate +
  // admin); parents see event browse + their tickets.
  if (hasAnyPermission(user, ['evt-001:read'])) {
    apps.push({
      key: 'events',
      label: 'Events',
      description:
        isStaff || isAdmin
          ? 'Event calendar, ticketing, gate scanner, revenue'
          : isStudent
            ? 'Upcoming events and my tickets'
            : 'Upcoming events, ticket purchase, and my tickets',
      href: '/events',
      routePrefix: '/events',
      icon: TicketIcon,
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
          : isParent
            ? 'Parent groups and community events'
            : 'Groups and communities',
      href: '/groups',
      routePrefix: '/groups',
      icon: ChatBubbleIcon,
    });
  }

  // P2-24 — Parent Engagement (Wave D Module Completion). Conference
  // scheduling (atomic AVAILABLE→BOOKED transition), engagement
  // dashboard (composite score from 5 cross-module data sources),
  // anonymous parent surveys. MTG-002:read covers every persona that
  // holds the function tier (Teacher, Parent, Student, Staff, Admin
  // — though students never see conferences and parents never see
  // engagement scoring). Tile lands for any user with MTG-002:read
  // OR ENG-001:read; nested route gates enforce per-surface access.
  if (hasAnyPermission(user, ['mtg-002:read', 'eng-001:read'])) {
    apps.push({
      key: 'engagement',
      label: 'Engagement',
      description: isStaff
        ? 'Conferences, family engagement dashboard, and parent surveys'
        : isParent
          ? 'Book parent-teacher conferences and respond to surveys'
          : 'Parent-teacher conferences and engagement',
      href: '/engagement/conferences',
      routePrefix: '/engagement',
      icon: HeartHandIcon,
    });
  }

  const activeType = user.activePersona.type;
  return apps.filter((app) => app.personas === undefined || app.personas.includes(activeType));
}
