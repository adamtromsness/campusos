'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { useAuthActions } from '@/lib/auth-context';
import { useAuthStore } from '@/lib/auth-store';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

/**
 * /invitations/accept — single landing page for every invitation
 * type. Section 5 of the persona-registration design.
 *
 * The token is the entire auth for the GET — the page works
 * unauthenticated so a brand-new visitor can land here from an email
 * link, see what they're being invited to, then sign in or register
 * to proceed. Accept and decline both require an authenticated
 * session; the page rewrites the Sign in / Create account links with
 * `?returnUrl=/invitations/accept?token=…` so the user lands back
 * here after auth.
 *
 * Lives in the unauthed route group (no `(app)` wrapper) so the
 * page renders without the sidebar / topbar chrome. The visual
 * style mirrors /login + /register for a coherent pre-auth flow.
 */

interface InvitationSummary {
  id: string;
  type: 'EMPLOYEE' | 'CHILD_LINK' | 'PARENT_LINK' | 'SUBSTITUTE';
  inviterName: string;
  schoolId: string | null;
  schoolName: string | null;
  jobTitle: string | null;
  expiresAt: string;
  status: string;
}

export default function InvitationsAcceptPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading invitation…" />}>
      <InvitationsAcceptInner />
    </Suspense>
  );
}

function InvitationsAcceptInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { refreshUser } = useAuthActions();
  const authStatus = useAuthStore((s) => s.status);
  const token = searchParams?.get('token') ?? '';

  const [invitation, setInvitation] = useState<InvitationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError('No invitation token provided. Open the link from your invitation email.');
      return;
    }
    (async () => {
      try {
        const data = await apiFetch<InvitationSummary>(
          `/api/v1/invitations/${encodeURIComponent(token)}`,
        );
        setInvitation(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setLoadError("This invitation has expired or doesn't exist.");
        } else {
          setLoadError('We could not load the invitation. Please try again.');
        }
      }
    })();
  }, [token]);

  async function onAccept() {
    if (!token || busy) return;
    setBusy('accept');
    try {
      await apiFetch(`/api/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      });
      await refreshUser();
      toast("You're in!", 'success');
      router.replace('/dashboard');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not accept the invitation. Please try again.';
      toast(message, 'error');
      setBusy(null);
    }
  }

  async function onDecline() {
    if (!token || busy) return;
    setBusy('decline');
    try {
      await apiFetch(`/api/v1/invitations/${encodeURIComponent(token)}/decline`, {
        method: 'POST',
      });
      toast('Invitation declined', 'success');
      router.replace('/dashboard');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not decline the invitation. Please try again.';
      toast(message, 'error');
      setBusy(null);
    }
  }

  const returnQuery = token
    ? '?returnUrl=' + encodeURIComponent(`/invitations/accept?token=${token}`)
    : '';

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="select-none text-3xl font-semibold tracking-tight text-campus-700 sm:text-4xl"
          >
            CampusOS
          </Link>
        </div>

        {loadError ? (
          <ErrorCard message={loadError} />
        ) : !invitation ? (
          <PageLoader label="Loading invitation…" />
        ) : (
          <>
            <InvitationCard invitation={invitation} />

            {authStatus === 'authenticated' ? (
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={onAccept}
                  disabled={busy !== null}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
                >
                  {busy === 'accept' && <LoadingSpinner size="sm" />}
                  <span>{busy === 'accept' ? 'Accepting…' : acceptCta(invitation.type)}</span>
                </button>
                <button
                  type="button"
                  onClick={onDecline}
                  disabled={busy !== null}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60"
                >
                  {busy === 'decline' && <LoadingSpinner size="sm" />}
                  <span>{busy === 'decline' ? 'Declining…' : 'Decline'}</span>
                </button>
              </div>
            ) : authStatus === 'unauthenticated' ? (
              <SignInPrompt returnQuery={returnQuery} />
            ) : (
              // status === 'loading' — defer the action buttons until
              // the silent-login attempt resolves so we don't flash
              // sign-in CTAs to someone who already has a session.
              <div className="mt-5 flex justify-center">
                <LoadingSpinner size="md" />
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

// ─── per-type messaging ───────────────────────────────────

function InvitationCard({ invitation }: { invitation: InvitationSummary }) {
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white p-6 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-campus-600">
        {typeBadge(invitation.type)}
      </p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-gray-900">
        {primaryHeadline(invitation)}
      </h1>
      <dl className="mt-5 grid gap-3 border-t border-gray-100 pt-4">
        {detailRows(invitation).map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs uppercase tracking-wide text-gray-500">{row.label}</dt>
            <dd className="text-sm font-medium text-gray-900">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function typeBadge(type: InvitationSummary['type']): string {
  switch (type) {
    case 'EMPLOYEE':
      return 'Employment offer';
    case 'CHILD_LINK':
      return 'Family link';
    case 'PARENT_LINK':
      return 'Parent / guardian link';
    case 'SUBSTITUTE':
      return 'Substitute teacher invitation';
  }
}

function primaryHeadline(inv: InvitationSummary): string {
  switch (inv.type) {
    case 'EMPLOYEE':
      return inv.schoolName
        ? `You've been invited to join ${inv.schoolName}.`
        : "You've been invited to join a school.";
    case 'CHILD_LINK':
      return `${inv.inviterName} wants to connect you to their family on CampusOS.`;
    case 'PARENT_LINK':
      return inv.schoolName
        ? `${inv.schoolName} has linked you as a parent / guardian.`
        : "You've been linked as a parent / guardian.";
    case 'SUBSTITUTE':
      return inv.schoolName
        ? `You've been approved to substitute at ${inv.schoolName}.`
        : "You've been approved to substitute.";
  }
}

function acceptCta(type: InvitationSummary['type']): string {
  switch (type) {
    case 'EMPLOYEE':
      return 'Accept Position';
    case 'CHILD_LINK':
    case 'PARENT_LINK':
      return 'Accept';
    case 'SUBSTITUTE':
      return 'Accept';
  }
}

interface DetailRow {
  label: string;
  value: string;
}

function detailRows(inv: InvitationSummary): DetailRow[] {
  const rows: DetailRow[] = [{ label: 'Invited by', value: inv.inviterName }];
  if (inv.type === 'EMPLOYEE' && inv.jobTitle) {
    rows.unshift({ label: 'Position', value: inv.jobTitle });
  }
  if (inv.schoolName) {
    rows.push({ label: 'School', value: inv.schoolName });
  }
  const expires = new Date(inv.expiresAt);
  if (!Number.isNaN(expires.getTime())) {
    rows.push({ label: 'Expires', value: expires.toLocaleString() });
  }
  return rows;
}

// ─── auth CTA + error states ─────────────────────────────

function SignInPrompt({ returnQuery }: { returnQuery: string }) {
  return (
    <div className="mt-5 rounded-card border border-dashed border-gray-200 bg-white p-5 text-center shadow-sm">
      <p className="text-sm text-gray-700">Sign in to accept this invitation.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Link
          href={'/login' + returnQuery}
          className="inline-flex flex-1 items-center justify-center rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
        >
          Sign in
        </Link>
        <Link
          href={'/register' + returnQuery}
          className="inline-flex flex-1 items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
        >
          Create an account
        </Link>
      </div>
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white p-6 text-center shadow-card">
      <h1 className="text-xl font-semibold tracking-tight text-gray-900">Invitation unavailable</h1>
      <p className="mt-3 text-sm text-gray-600">{message}</p>
      <Link
        href="/"
        className="mt-5 inline-flex rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-600"
      >
        Go to CampusOS
      </Link>
    </div>
  );
}
