'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFamilyChildren, useGenerateChildCode } from '@/hooks/use-family-children';

/**
 * Getting Started — role-aware onboarding.
 *
 * Replaces the previous fixed 4-card layout that assumed every visitor
 * was a parent. The page now has three vertical sections:
 *
 *   1. Pending invitations banner. Anything in /invitations/mine —
 *      whether the school sent an EMPLOYEE / PARENT_LINK / SUBSTITUTE
 *      invite, or a parent issued a CHILD_LINK code — surfaces here
 *      with a one-click Accept link. This is the highest-priority
 *      onboarding action because the school or parent has already
 *      done the upstream work.
 *
 *   2. Role selection. Five multi-select cards: parent, student,
 *      job-offer, substitute, exploring. State is local — no API call
 *      until the user actually starts an action. Parent is
 *      pre-selected when the user already has children on file (the
 *      family-children projection committed them to that role).
 *
 *   3. Role-specific actions. Per selected role we render a small
 *      card listing its actions. Link-style actions navigate; the
 *      "Enter an invitation code" rows expand into an inline form that
 *      validates via GET /invitations/:token and routes to
 *      /invitations/accept?token=… for the type-dispatched accept.
 *
 * Persona-presence redirect — once a user activates ANY persona the
 * AppLayout effect routes them off /getting-started to /dashboard. The
 * page is only the active surface for the 0-persona window.
 */

type RoleKey = 'parent' | 'student' | 'job-offer' | 'substitute' | 'exploring';

interface RoleDef {
  key: RoleKey;
  emoji: string;
  title: string;
  description: string;
}

const ROLES: RoleDef[] = [
  {
    key: 'parent',
    emoji: '👨‍👩‍👧',
    title: "I'm a parent or guardian",
    description: 'Add your children and connect them to a school.',
  },
  {
    key: 'student',
    emoji: '🎓',
    title: "I'm a student",
    description: 'Connect to your school or accept a parent’s link code.',
  },
  {
    key: 'job-offer',
    emoji: '💼',
    title: 'I received a job offer from a school',
    description: 'Enter the employee invitation code from your hiring email.',
  },
  {
    key: 'substitute',
    emoji: '📚',
    title: 'I want to substitute teach',
    description: 'Create a substitute teacher profile to pick up assignments.',
  },
  {
    key: 'exploring',
    emoji: '🔍',
    title: "I'm just exploring",
    description: 'Browse schools and learn about CampusOS.',
  },
];

type ActionDef =
  | { type: 'link'; label: string; href: string }
  | { type: 'invitation'; label: string; expectType?: InvitationType }
  | { type: 'generate-child-code'; label: string };

type InvitationType = 'EMPLOYEE' | 'CHILD_LINK' | 'PARENT_LINK' | 'SUBSTITUTE' | 'FAMILY_INVITE';

const ROLE_ACTIONS: Record<RoleKey, ActionDef[]> = {
  parent: [
    { type: 'link', label: 'Add your children', href: '/family/add-child' },
    { type: 'link', label: 'Find a school', href: '/find-schools' },
    { type: 'invitation', label: 'Enter an invitation code' },
  ],
  student: [
    { type: 'invitation', label: 'Enter a code from your parent or school' },
    { type: 'generate-child-code', label: 'Generate a code for your parent' },
    { type: 'link', label: 'Find a school to apply to', href: '/find-schools' },
    { type: 'link', label: 'Set up your profile', href: '/profile' },
  ],
  'job-offer': [
    { type: 'invitation', label: 'Enter your invitation code', expectType: 'EMPLOYEE' },
  ],
  substitute: [
    { type: 'link', label: 'Create your substitute profile', href: '/substitute/register' },
  ],
  exploring: [{ type: 'link', label: 'Browse schools', href: '/find-schools' }],
};

const INVITATION_TYPE_LABEL: Record<InvitationType, string> = {
  EMPLOYEE: 'employee',
  CHILD_LINK: 'family',
  PARENT_LINK: 'parent',
  SUBSTITUTE: 'substitute teacher',
  FAMILY_INVITE: 'family',
};

interface PendingInvitation {
  id: string;
  type: InvitationType;
  token: string;
  inviterName: string;
  schoolId: string | null;
  schoolName: string | null;
  jobTitle: string | null;
  expiresAt: string;
  status: string;
}

export default function GettingStartedPage() {
  const user = useAuthStore((s) => s.user);
  const greeting =
    user?.preferredName || user?.firstName
      ? `Welcome to CampusOS, ${user.preferredName || user.firstName}!`
      : 'Welcome to CampusOS!';

  const familyQuery = useFamilyChildren();
  const hasChildren = (familyQuery.data ?? []).length > 0;

  // /invitations/mine returns PENDING invitations targeting either
  // this user's account or their registration email. Surfaced as the
  // top-of-page banner because accepting a pending invite is the
  // fastest path off /getting-started.
  const invitationsQuery = useQuery<PendingInvitation[]>({
    queryKey: ['invitations', 'mine'],
    queryFn: () => apiFetch<PendingInvitation[]>('/api/v1/invitations/mine'),
    staleTime: 60_000,
  });
  const pendingInvitations = invitationsQuery.data ?? [];

  // Local role-selection state. Seeded once from the persistent
  // signals we know about (children → parent, pending EMPLOYEE invite
  // → job-offer, pending SUBSTITUTE invite → substitute) so the user
  // doesn't have to redundantly tell us things we already know.
  const [selectedRoles, setSelectedRoles] = useState<Set<RoleKey>>(() => new Set());
  const seededRef = useState({ current: false })[0];
  useEffect(() => {
    if (seededRef.current) return;
    if (familyQuery.isLoading || invitationsQuery.isLoading) return;
    const seeded = new Set<RoleKey>();
    if (hasChildren) seeded.add('parent');
    for (const inv of pendingInvitations) {
      if (inv.type === 'EMPLOYEE') seeded.add('job-offer');
      if (inv.type === 'SUBSTITUTE') seeded.add('substitute');
    }
    if (seeded.size > 0) setSelectedRoles(seeded);
    seededRef.current = true;
  }, [
    familyQuery.isLoading,
    invitationsQuery.isLoading,
    hasChildren,
    pendingInvitations,
    seededRef,
  ]);

  function toggleRole(key: RoleKey) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const orderedSelected = useMemo(
    () => ROLES.filter((r) => selectedRoles.has(r.key)),
    [selectedRoles],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-16 pt-10 sm:pt-16">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-campus-700 sm:text-4xl">
          {greeting}
        </h1>
        <p className="mt-3 text-sm text-gray-600 sm:text-base">Let&rsquo;s get you set up.</p>
      </div>

      {pendingInvitations.length > 0 && (
        <PendingInvitationsBanner invitations={pendingInvitations} />
      )}

      <section className="mt-10">
        <h2 className="text-sm font-semibold text-gray-900">Tell us about yourself</h2>
        <p className="mt-1 text-xs text-gray-600">
          Pick everything that applies. We&rsquo;ll show the next steps based on your choices.
        </p>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {ROLES.map((role) => (
            <li key={role.key}>
              <RoleCard role={role} selected={selectedRoles.has(role.key)} onToggle={toggleRole} />
            </li>
          ))}
        </ul>
      </section>

      {orderedSelected.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-gray-900">Your next steps</h2>
          <div className="mt-3 flex flex-col gap-4">
            {orderedSelected.map((role) => (
              <RoleActionsCard key={role.key} role={role} />
            ))}
          </div>
        </section>
      )}

      <p className="mt-10 text-center text-xs text-gray-400">
        You can come back here from your profile menu at any time.
      </p>
    </div>
  );
}

// ─── Pending invitations banner ──────────────────────────

function PendingInvitationsBanner({ invitations }: { invitations: PendingInvitation[] }) {
  return (
    <section className="mt-8 rounded-card border border-campus-200 bg-campus-50/40 p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-campus-800">
        {invitations.length === 1
          ? 'You have a pending invitation'
          : `You have ${invitations.length} pending invitations`}
      </h2>
      <ul className="mt-3 flex flex-col gap-2">
        {invitations.map((inv) => (
          <li
            key={inv.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/60 bg-white p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="font-medium text-gray-900">
                {inv.schoolName ?? inv.inviterName} invited you as {INVITATION_TYPE_LABEL[inv.type]}
                {inv.jobTitle ? ` — ${inv.jobTitle}` : ''}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                Expires {new Date(inv.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <Link
              href={`/invitations/accept?token=${encodeURIComponent(inv.token)}`}
              className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-campus-600"
            >
              Accept
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Role selection card ─────────────────────────────────

function RoleCard({
  role,
  selected,
  onToggle,
}: {
  role: RoleDef;
  selected: boolean;
  onToggle: (key: RoleKey) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={() => onToggle(role.key)}
      className={
        'flex w-full items-start gap-3 rounded-card border bg-white p-4 text-left shadow-sm transition-colors ' +
        (selected
          ? 'border-campus-500 ring-2 ring-campus-100'
          : 'border-gray-200 hover:border-campus-300 hover:bg-campus-50/40')
      }
    >
      <span aria-hidden className="text-2xl leading-none">
        {role.emoji}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900">{role.title}</p>
        <p className="mt-0.5 text-xs text-gray-600">{role.description}</p>
      </div>
      {selected && (
        <span
          aria-hidden
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-campus-700 text-[12px] text-white"
        >
          ✓
        </span>
      )}
    </button>
  );
}

// ─── Role actions card ───────────────────────────────────

function RoleActionsCard({ role }: { role: RoleDef }) {
  const actions = ROLE_ACTIONS[role.key];
  return (
    <div className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-lg leading-none">
          {role.emoji}
        </span>
        <h3 className="text-sm font-semibold text-gray-900">{role.title}</h3>
      </div>
      <ul className="mt-3 flex flex-col gap-1">
        {actions.map((action, i) => {
          if (action.type === 'link') {
            return (
              <li key={i}>
                <Link
                  href={action.href}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm text-gray-800 hover:bg-gray-50"
                >
                  <span>{action.label}</span>
                  <span aria-hidden className="text-gray-400">
                    →
                  </span>
                </Link>
              </li>
            );
          }
          if (action.type === 'invitation') {
            return (
              <li key={i}>
                <InvitationActionRow label={action.label} expectType={action.expectType} />
              </li>
            );
          }
          return (
            <li key={i}>
              <GenerateChildCodeRow label={action.label} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Invitation action row ──────────────────────────────

/**
 * Renders an "Enter invitation code" row that expands into an inline
 * form on click. The form validates the token via the public
 * GET /invitations/:token, optionally enforces an expected type
 * (used by the job-offer role to refuse non-EMPLOYEE codes), and on
 * success routes to /invitations/accept?token=… where the
 * type-dispatched accept lives.
 */
function InvitationActionRow({
  label,
  expectType,
}: {
  label: string;
  expectType?: InvitationType;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter the code from your invitation.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const summary = await apiFetch<{ type: InvitationType }>(
        `/api/v1/invitations/${encodeURIComponent(trimmed)}`,
      );
      if (expectType && summary.type !== expectType) {
        setError(
          `That code isn't an ${INVITATION_TYPE_LABEL[expectType]} invitation. Use the matching role above.`,
        );
        setSubmitting(false);
        return;
      }
      router.push(`/invitations/accept?token=${encodeURIComponent(trimmed)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError("We couldn't find that invitation. Check the code and try again.");
      } else {
        setError('Something went wrong validating your code. Please try again.');
      }
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm text-gray-800 hover:bg-gray-50"
      >
        <span>{label}</span>
        <span aria-hidden className="text-gray-400">
          →
        </span>
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="rounded-md bg-gray-50/60 p-3">
      <label htmlFor={`invite-${label}`} className="block text-xs font-medium text-gray-700">
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={`invite-${label}`}
          type="text"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) setError(null);
          }}
          placeholder="ABCD1234"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? `invite-${label}-error` : undefined}
          className={
            'block flex-1 rounded-md border bg-white px-3 py-2 font-mono text-sm uppercase tracking-wider text-gray-900 ' +
            'shadow-sm placeholder:font-mono placeholder:text-gray-300 ' +
            'focus:outline-none focus:ring-2 focus:ring-campus-500 focus:border-campus-500 ' +
            (error ? 'border-red-300' : 'border-gray-300')
          }
        />
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
        >
          {submitting && <LoadingSpinner size="sm" />}
          <span>{submitting ? 'Checking…' : 'Continue'}</span>
        </button>
      </div>
      {error && (
        <p id={`invite-${label}-error`} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}

// ─── Generate child code row ─────────────────────────────

/**
 * Student-side counterpart to the InvitationActionRow. Generates a
 * CHILD_LINK code with no familyChildId metadata (POST
 * /family/generate-child-code) and shows the resulting 8-char code
 * inline with a copy button. The parent who accepts the code at
 * /family adds the student to their family as a LINKED child.
 *
 * The code persists in row state for the lifetime of the page so
 * the student can copy it again if the clipboard write fails.
 */
function GenerateChildCodeRow({ label }: { label: string }) {
  const generate = useGenerateChildCode();
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  async function onClick() {
    if (code) return;
    try {
      const result = await generate.mutateAsync();
      setCode(result.code);
      setExpiresAt(result.expiresAt);
    } catch {
      // Surface as a small error inline via copyState? Keep it simple
      // and let the hook's isPending flag the failure path. A toast
      // would be heavier than the action warrants here.
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('error');
    }
  }

  if (!code) {
    return (
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={generate.isPending}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-60"
      >
        <span>{generate.isPending ? 'Generating…' : label}</span>
        <span aria-hidden className="text-gray-400">
          →
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-md bg-gray-50/60 p-3">
      <p className="text-xs font-medium text-gray-700">{label}</p>
      <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-2">
        <code className="font-mono text-base font-semibold tracking-[0.2em] text-gray-900">
          {code}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center rounded-md bg-campus-700 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-campus-600"
        >
          {copyState === 'copied' ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Share this code with your parent. They enter it on CampusOS to add you to their family.
        {expiresAt &&
          ' Expires ' +
            new Date(expiresAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }) +
            '.'}
      </p>
    </div>
  );
}
