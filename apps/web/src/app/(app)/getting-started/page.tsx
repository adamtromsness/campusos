'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError, apiFetch } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ChildrenIcon, MailIcon, SearchIcon, UserCheckIcon } from '@/components/shell/icons';
import {
  useFamilyChildren,
  type FamilyChildDto,
  type FamilyChildStatus,
} from '@/hooks/use-family-children';

/**
 * Getting Started — Section 2 / Step 3 of the persona-registration
 * design. Replaces the launchpad until the user activates a persona
 * (link a LINKED child, accept an invitation, register as a sub,
 * enrol via a school).
 *
 * The four action cards mirror the design doc's "What brings you
 * here?" question. The Invitation card expands inline into an input
 * field; on submit we GET /invitations/:token to validate, then
 * navigate to /invitations/accept?token=… for confirmation. Bad codes
 * surface as inline errors so we never throw a toast for an expected
 * "wrong code" path.
 *
 * The persona-presence redirect lives in
 * apps/web/src/components/shell/AppLayout.tsx — this page renders
 * unconditionally; the shell decides whether the user belongs here.
 */
export default function GettingStartedPage() {
  const user = useAuthStore((s) => s.user);
  const greeting = user?.firstName
    ? `Welcome to CampusOS, ${user.firstName}!`
    : 'Welcome to CampusOS!';

  // Once the user has added children, the "I have children" card is a
  // dead-end repeat. Swap it for a family-progress summary that surfaces
  // each child's link status and points at /family for management. We
  // only render the summary when the API has answered with a non-empty
  // list — the loading flicker would otherwise replace the action card
  // with a spinner on every fresh visit.
  const familyQuery = useFamilyChildren();
  const children = familyQuery.data ?? [];
  const hasChildren = children.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-16 pt-10 sm:pt-16">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-campus-700 sm:text-4xl">
          {greeting}
        </h1>
        <p className="mt-3 text-sm text-gray-600 sm:text-base">
          Let&rsquo;s get you set up. What brings you here?
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {hasChildren ? <FamilySummaryCard items={children} /> : <ChildrenCard />}
        <InvitationCard />
        <SubstituteCard />
        <FindSchoolCard />
      </div>

      <p className="mt-10 text-center text-xs text-gray-400">
        You can always come back here from your profile menu.
      </p>
    </div>
  );
}

// ─── Card primitives ──────────────────────────────────────

type AccentName = 'blue' | 'green' | 'purple' | 'amber';

interface AccentStyle {
  iconBg: string;
  iconText: string;
  hoverBorder: string;
  hoverBg: string;
}

const ACCENTS: Record<AccentName, AccentStyle> = {
  blue: {
    iconBg: 'bg-blue-50',
    iconText: 'text-blue-600',
    hoverBorder: 'hover:border-blue-300',
    hoverBg: 'hover:bg-blue-50/40',
  },
  green: {
    iconBg: 'bg-green-50',
    iconText: 'text-green-600',
    hoverBorder: 'hover:border-green-300',
    hoverBg: 'hover:bg-green-50/40',
  },
  purple: {
    iconBg: 'bg-purple-50',
    iconText: 'text-purple-600',
    hoverBorder: 'hover:border-purple-300',
    hoverBg: 'hover:bg-purple-50/40',
  },
  amber: {
    iconBg: 'bg-amber-50',
    iconText: 'text-amber-600',
    hoverBorder: 'hover:border-amber-300',
    hoverBg: 'hover:bg-amber-50/40',
  },
};

interface CardShellProps {
  title: string;
  description: string;
  accent: AccentName;
  icon: (props: { className?: string }) => React.ReactNode;
  children?: React.ReactNode;
}

/**
 * Non-clickable card wrapper used by InvitationCard, which expands
 * into an inline form on activation rather than navigating. Anchor-
 * style cards use LinkCard instead so the entire card surface is
 * the click target.
 */
function Card({ title, description, accent, icon: Icon, children }: CardShellProps) {
  const a = ACCENTS[accent];
  return (
    <div
      className={
        'flex flex-col gap-3 rounded-card border border-gray-200 bg-white p-5 shadow-sm transition-colors ' +
        a.hoverBorder +
        ' ' +
        a.hoverBg
      }
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full ' +
            a.iconBg +
            ' ' +
            a.iconText
          }
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <p className="mt-0.5 text-sm text-gray-600">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

interface LinkCardProps {
  title: string;
  description: string;
  accent: AccentName;
  icon: (props: { className?: string }) => React.ReactNode;
  href: string;
  cta: string;
}

/**
 * Whole-card click target. The Card shell is rendered as a single
 * `<Link>` so users can tap anywhere on the card to navigate — the
 * earlier text-only "→" affordance made the click area unintuitively
 * small relative to the card's visual extent.
 */
function LinkCard({ title, description, accent, icon: Icon, href, cta }: LinkCardProps) {
  const a = ACCENTS[accent];
  return (
    <Link
      href={href}
      className={
        'flex flex-col gap-3 rounded-card border border-gray-200 bg-white p-5 shadow-sm transition-colors ' +
        a.hoverBorder +
        ' ' +
        a.hoverBg +
        ' focus:outline-none focus:ring-2 focus:ring-campus-500 focus:ring-offset-2'
      }
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full ' +
            a.iconBg +
            ' ' +
            a.iconText
          }
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <p className="mt-0.5 text-sm text-gray-600">{description}</p>
        </div>
      </div>
      <span className="inline-flex w-fit items-center gap-1 text-sm font-medium text-campus-700">
        {cta}
        <span aria-hidden>→</span>
      </span>
    </Link>
  );
}

// ─── Concrete cards ──────────────────────────────────────

function ChildrenCard() {
  return (
    <LinkCard
      title="I have children"
      description="Add your children and find schools for them."
      accent="blue"
      icon={ChildrenIcon}
      href="/family/add-child"
      cta="Add a child"
    />
  );
}

function SubstituteCard() {
  return (
    <LinkCard
      title="I want to substitute teach"
      description="Create a substitute teacher profile."
      accent="purple"
      icon={UserCheckIcon}
      href="/substitute/register"
      cta="Get started"
    />
  );
}

function FindSchoolCard() {
  return (
    <LinkCard
      title="I'm looking for a school"
      description="Browse schools and start an enrolment application."
      accent="amber"
      icon={SearchIcon}
      href="/find-schools"
      cta="Browse schools"
    />
  );
}

// ─── Family progress card ────────────────────────────────

const STATUS_LABELS: Record<FamilyChildStatus, { label: string; tone: string }> = {
  LINKED: { label: 'Connected', tone: 'bg-green-50 text-green-700 ring-green-600/20' },
  PENDING_LINK: { label: 'Invite pending', tone: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  PLACEHOLDER: { label: 'Account needed', tone: 'bg-gray-100 text-gray-700 ring-gray-500/20' },
};

/**
 * Replacement for the "I have children" card once the user has at
 * least one child on file. Shows each child with a status badge and
 * funnels to /family for management or /family/add-child for the next
 * child. Sized to match the other launchpad cards (single grid cell).
 *
 * Children are intentionally not clickable here — the AppLayout
 * persona-presence redirect would bounce the user off any per-child
 * detail route until a persona activates. /family itself is in the
 * onboarding allowlist so the Manage button always works.
 */
function FamilySummaryCard({ items }: { items: FamilyChildDto[] }) {
  const a = ACCENTS.blue;
  return (
    <div
      className={
        'flex flex-col gap-3 rounded-card border border-gray-200 bg-white p-5 shadow-sm transition-colors ' +
        a.hoverBorder +
        ' ' +
        a.hoverBg
      }
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full ' +
            a.iconBg +
            ' ' +
            a.iconText
          }
        >
          <ChildrenIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">My family</h2>
          <p className="mt-0.5 text-sm text-gray-600">
            {items.length === 1 ? '1 child on file' : `${items.length} children on file`}
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5 text-sm">
        {items.map((c) => {
          const badge = STATUS_LABELS[c.status];
          return (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-gray-800">
                {c.firstName} {c.lastName}
              </span>
              <span
                className={
                  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                  badge.tone
                }
              >
                {badge.label}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-1 flex flex-wrap gap-3 text-sm font-medium">
        <Link
          href="/family"
          className="inline-flex items-center gap-1 text-campus-700 hover:text-campus-600"
        >
          Manage family
          <span aria-hidden>→</span>
        </Link>
        <Link
          href="/family/add-child"
          className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-700"
        >
          Add another
          <span aria-hidden>→</span>
        </Link>
      </div>
    </div>
  );
}

/**
 * Expandable card: tap "Enter code" to reveal the inline input. We
 * validate the code on submit via GET /invitations/:token (public),
 * then push the caller to /invitations/accept?token=… where they
 * confirm the details and complete the type-specific projection
 * write.
 */
function InvitationCard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter the code from your invitation email.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // GET is public — the token itself is the auth. We don't need
      // the response body; the 404/200 status tells us whether to
      // proceed.
      await apiFetch(`/api/v1/invitations/${encodeURIComponent(trimmed)}`);
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

  return (
    <Card
      title="I received an invitation"
      description="Enter an invite code from a school or employer."
      accent="green"
      icon={MailIcon}
    >
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex w-fit items-center gap-1 text-sm font-medium text-campus-700 hover:text-campus-600"
        >
          Enter code
          <span aria-hidden>→</span>
        </button>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <label htmlFor="invite-code" className="sr-only">
            Invitation code
          </label>
          <div className="flex gap-2">
            <input
              id="invite-code"
              name="invite-code"
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
              aria-describedby={error ? 'invite-code-error' : undefined}
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
              className={
                'inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-2 ' +
                'text-sm font-semibold text-white shadow-sm transition-colors ' +
                'hover:bg-campus-600 focus:outline-none focus:ring-2 focus:ring-campus-500 focus:ring-offset-2 ' +
                'disabled:opacity-60'
              }
            >
              {submitting && <LoadingSpinner size="sm" />}
              <span>{submitting ? 'Checking…' : 'Continue'}</span>
            </button>
          </div>
          {error && (
            <p id="invite-code-error" className="text-xs text-red-600">
              {error}
            </p>
          )}
        </form>
      )}
    </Card>
  );
}
