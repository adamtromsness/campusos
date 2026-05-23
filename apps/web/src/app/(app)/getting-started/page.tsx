'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError, apiFetch } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ChildrenIcon, MailIcon, SearchIcon, UserCheckIcon } from '@/components/shell/icons';

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
        <ChildrenCard />
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
 * Wrapping `<button>` and `<Link>` both share this layout. Callers
 * pass `children` so the Invitation card can swap a Link for an
 * inline input expansion.
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

interface LinkCardProps extends CardShellProps {
  href: string;
  cta: string;
}

function LinkCard({ href, cta, ...shell }: LinkCardProps) {
  return (
    <Card {...shell}>
      <Link
        href={href}
        className="inline-flex w-fit items-center gap-1 text-sm font-medium text-campus-700 hover:text-campus-600"
      >
        {cta}
        <span aria-hidden>→</span>
      </Link>
    </Card>
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
