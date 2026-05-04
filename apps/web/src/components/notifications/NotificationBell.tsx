'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { type AuthUser } from '@/lib/auth-store';
import { useMarkAllNotificationsRead, useNotificationInbox } from '@/hooks/use-notifications';
import type { NotificationItem } from '@/lib/types';
import { cn } from '@/components/ui/cn';
import {
  AttendanceIcon,
  BellIcon,
  ChatBubbleIcon,
  CheckCircleIcon,
  GradeIcon,
  LifebuoyIcon,
  MegaphoneIcon,
  ShieldExclamationIcon,
} from '@/components/shell/icons';

interface NotificationBellProps {
  user: AuthUser;
}

/**
 * Top-bar bell button + dropdown. Polls /notifications/inbox every 30s
 * via the hook. The badge count is `unreadCount` (capped at 99+ for
 * display). Clicking the bell opens the dropdown which lists the most
 * recent 10 notifications; clicking an item navigates to its deep link
 * and bumps the lastread timestamp so the badge clears.
 *
 * The "View all" footer link routes to /notifications for the full
 * paginated history. The "Mark all read" button calls the
 * mark-all-read endpoint and the badge clears on the next poll
 * (invalidation triggers an immediate refetch).
 */
export function NotificationBell({ user }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inboxQuery = useNotificationInbox(10);
  const markAllRead = useMarkAllNotificationsRead();

  useEffect(() => {
    if (!open) return undefined;
    function onClickAway(ev: MouseEvent) {
      if (!containerRef.current?.contains(ev.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);

  const data = inboxQuery.data;
  const unread = data?.unreadCount ?? 0;
  const items = data?.items ?? [];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-full p-2 text-gray-500 hover:bg-gray-100"
      >
        <BellIcon className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute right-0 top-0 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-40 w-[22rem] overflow-hidden rounded-card border border-gray-200 bg-white shadow-elevated">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <span className="text-sm font-semibold text-gray-900">Notifications</span>
            <button
              type="button"
              disabled={unread === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
              className="text-xs font-medium text-campus-700 hover:underline disabled:cursor-not-allowed disabled:text-gray-400"
            >
              Mark all read
            </button>
          </div>

          <div className="max-h-[24rem] overflow-y-auto">
            {inboxQuery.isLoading && (
              <div className="px-4 py-6 text-center text-sm text-gray-500">Loading…</div>
            )}
            {!inboxQuery.isLoading && items.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                No notifications yet.
              </div>
            )}
            {items.map((item, idx) => (
              <NotificationRow
                key={item.id ?? `idx-${idx}`}
                item={item}
                user={user}
                onSelect={() => setOpen(false)}
              />
            ))}
          </div>

          <div className="border-t border-gray-100 px-4 py-2 text-center">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-campus-700 hover:underline"
            >
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

interface NotificationRowProps {
  item: NotificationItem;
  user: AuthUser;
  onSelect: () => void;
}

function NotificationRow({ item, user, onSelect }: NotificationRowProps) {
  const link = resolveDeepLink(item, user);
  const { title, subtitle } = describeNotification(item);
  const Icon = iconFor(item.type);
  const cls = cn(
    'flex items-start gap-3 px-4 py-3 text-left text-sm transition-colors',
    'hover:bg-gray-50',
    !item.isRead && 'bg-campus-50',
  );

  const body = (
    <>
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 items-center justify-center rounded-full',
          colorFor(item.type),
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-gray-900">{title}</p>
        {subtitle && <p className="mt-0.5 line-clamp-2 text-xs text-gray-600">{subtitle}</p>}
        <p className="mt-1 text-[11px] text-gray-400">{formatRelative(item.occurredAt)}</p>
      </div>
      {!item.isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-campus-500" />}
    </>
  );

  if (link) {
    return (
      <Link href={link} onClick={onSelect} className={cls}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

// ── icon + colour mapping ────────────────────────────────────────────────

function iconFor(type: string): (props: { className?: string }) => JSX.Element {
  if (type.startsWith('attendance.')) return AttendanceIcon;
  if (type.startsWith('grade.')) return GradeIcon;
  if (type.startsWith('progress_note.')) return CheckCircleIcon;
  if (type.startsWith('absence.')) return CheckCircleIcon;
  if (type === 'message.posted') return ChatBubbleIcon;
  if (type === 'announcement.published') return MegaphoneIcon;
  if (type.startsWith('ticket.')) return LifebuoyIcon;
  if (type.startsWith('behaviour.')) return ShieldExclamationIcon;
  return BellIcon;
}

function colorFor(type: string): string {
  if (type.startsWith('attendance.')) return 'bg-amber-100 text-amber-700';
  if (type.startsWith('grade.')) return 'bg-emerald-100 text-emerald-700';
  if (type.startsWith('progress_note.')) return 'bg-sky-100 text-sky-700';
  if (type.startsWith('absence.')) return 'bg-orange-100 text-orange-700';
  if (type === 'message.posted') return 'bg-violet-100 text-violet-700';
  if (type === 'announcement.published') return 'bg-rose-100 text-rose-700';
  if (type.startsWith('ticket.')) return 'bg-teal-100 text-teal-700';
  if (type.startsWith('behaviour.')) return 'bg-orange-100 text-orange-700';
  return 'bg-gray-100 text-gray-600';
}

// ── title + subtitle ─────────────────────────────────────────────────────

interface RenderedNotification {
  title: string;
  subtitle: string | null;
}

export function describeNotification(item: NotificationItem): RenderedNotification {
  const p = item.payload;
  switch (item.type) {
    case 'attendance.tardy': {
      const name = strField(p, 'student_name') || 'Student';
      const className = strField(p, 'class_name') || 'class';
      const period = strField(p, 'period');
      return {
        title: `${name} marked tardy`,
        subtitle: period ? `${className} · Period ${period}` : className,
      };
    }
    case 'attendance.absent': {
      const name = strField(p, 'student_name') || 'Student';
      const className = strField(p, 'class_name') || 'class';
      return {
        title: `${name} marked absent`,
        subtitle: className,
      };
    }
    case 'grade.published': {
      const title = strField(p, 'assignment_title') || 'Assignment';
      const studentName = strField(p, 'student_name');
      const pct = numField(p, 'percentage');
      const sub: string[] = [];
      if (studentName) sub.push(studentName);
      if (pct !== null) sub.push(`${pct}%`);
      return {
        title: `New grade: ${title}`,
        subtitle: sub.length > 0 ? sub.join(' · ') : null,
      };
    }
    case 'progress_note.published': {
      const studentName = strField(p, 'student_name') || 'Student';
      const className = strField(p, 'class_name') || 'class';
      return {
        title: `Progress note for ${studentName}`,
        subtitle: className,
      };
    }
    case 'absence.requested': {
      const name = strField(p, 'student_name') || 'A student';
      const dateFrom = strField(p, 'date_from');
      return {
        title: `Absence request submitted for ${name}`,
        subtitle: dateFrom ? `From ${dateFrom}` : null,
      };
    }
    case 'absence.reviewed': {
      const status = (strField(p, 'status') || 'reviewed').toLowerCase();
      const name = strField(p, 'student_name') || 'student';
      return {
        title: `Absence request ${status}`,
        subtitle: `For ${name}`,
      };
    }
    case 'message.posted': {
      const sender = strField(p, 'sender_name') || 'Someone';
      const subject = strField(p, 'thread_subject');
      const preview = strField(p, 'preview');
      return {
        title: `${sender}${subject ? ` · ${subject}` : ''}`,
        subtitle: preview,
      };
    }
    case 'announcement.published': {
      const title = strField(p, 'title') || 'New announcement';
      const author = strField(p, 'author_name');
      return {
        title: title,
        subtitle: author ? `From ${author}` : null,
      };
    }
    case 'ticket.submitted': {
      const ticketTitle = strField(p, 'ticket_title') || 'New ticket';
      const priority = strField(p, 'priority');
      const category = strField(p, 'category_name');
      const sub: string[] = [];
      if (category) sub.push(category);
      if (priority) sub.push(priority);
      return {
        title: `New helpdesk ticket: ${ticketTitle}`,
        subtitle: sub.length > 0 ? sub.join(' · ') : null,
      };
    }
    case 'ticket.assigned': {
      const ticketTitle = strField(p, 'ticket_title') || 'a ticket';
      const priority = strField(p, 'priority');
      return {
        title: `Ticket assigned: ${ticketTitle}`,
        subtitle: priority ? `Priority ${priority}` : null,
      };
    }
    case 'ticket.commented': {
      const ticketTitle = strField(p, 'ticket_title') || 'your ticket';
      const isInternal = !!p['is_internal'];
      const bumped = !!p['first_response_bumped'];
      const tag = isInternal ? 'Internal note on' : 'New reply on';
      return {
        title: `${tag} ${ticketTitle}`,
        subtitle: bumped ? 'First staff response — SLA clock stopped' : null,
      };
    }
    case 'ticket.resolved': {
      const ticketTitle = strField(p, 'ticket_title') || 'your ticket';
      const viaProblem = strField(p, 'resolved_via_problem_id');
      return {
        title: `Resolved: ${ticketTitle}`,
        subtitle: viaProblem ? 'Resolved via a tracked problem' : null,
      };
    }
    case 'behaviour.incident_reported': {
      const studentName = strField(p, 'student_name') || 'A student';
      const category = strField(p, 'category_name');
      const severity = strField(p, 'severity');
      const sub: string[] = [];
      if (category) sub.push(category);
      if (severity) sub.push(severity);
      return {
        title: `Incident reported: ${studentName}`,
        subtitle: sub.length > 0 ? sub.join(' · ') : null,
      };
    }
    case 'behaviour.action_assigned': {
      const studentName = strField(p, 'student_name') || 'your child';
      const actionType = strField(p, 'action_type_name') || 'A disciplinary action';
      return {
        title: `${actionType} assigned to ${studentName}`,
        subtitle: strField(p, 'category_name'),
      };
    }
    case 'behaviour.bip_feedback_requested': {
      const studentName = strField(p, 'student_name') || 'a student';
      const planType = strField(p, 'plan_type') || 'BIP';
      const requester = strField(p, 'requester_name');
      return {
        title: `${planType} feedback requested for ${studentName}`,
        subtitle: requester ? `From ${requester}` : null,
      };
    }
    case 'behaviour.incident_resolved': {
      const studentName = strField(p, 'student_name') || 'a student';
      const resolver = strField(p, 'resolved_by_name');
      return {
        title: `Incident resolved for ${studentName}`,
        subtitle: resolver ? `By ${resolver}` : null,
      };
    }
    default:
      return {
        title: humanizeType(item.type),
        subtitle: null,
      };
  }
}

function humanizeType(type: string): string {
  return type
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── deep link resolver ───────────────────────────────────────────────────

export function resolveDeepLink(item: NotificationItem, user: AuthUser): string | null {
  const p = item.payload;
  const isStudent = user.personType === 'STUDENT';
  const isGuardian = user.personType === 'GUARDIAN';

  // Grade notifications carry persona-specific links from the consumer.
  if (item.type === 'grade.published') {
    if (isStudent) return strField(p, 'deep_link_student') ?? '/grades';
    if (isGuardian) return strField(p, 'deep_link_guardian') ?? null;
    const fallback = strField(p, 'deep_link_student') || strField(p, 'deep_link_guardian');
    return fallback ?? null;
  }

  // Most other notifications carry a single deep_link string.
  const direct = strField(p, 'deep_link');
  if (direct) return direct;

  // Final fallbacks per type.
  if (item.type === 'message.posted') {
    const threadId = strField(p, 'thread_id');
    return threadId ? `/messages/${threadId}` : '/messages';
  }
  if (item.type === 'announcement.published') return '/announcements';
  return null;
}

// ── relative time ────────────────────────────────────────────────────────

export function formatRelative(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ── payload helpers ──────────────────────────────────────────────────────

function strField(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numField(p: Record<string, unknown>, key: string): number | null {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
