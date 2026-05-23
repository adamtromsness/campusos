'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { useAuthActions } from '@/lib/auth-context';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

/**
 * Minimal /invitations/accept landing — Section 5 / Section 8 of the
 * persona-registration design. Drilled into from the Getting Started
 * invite-code input, from invitation emails, and from the future
 * /invitations/mine list.
 *
 * Reads ?token=… from the query string, fetches the public invitation
 * summary, and offers Accept / Decline buttons. On accept it POSTs
 * /api/v1/invitations/:token/accept (auth required) and refreshes
 * the auth store so the new persona surfaces; the AppLayout shell
 * then routes the user from /getting-started to /dashboard
 * automatically.
 */
export default function InvitationsAcceptPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading invitation…" />}>
      <InvitationsAcceptInner />
    </Suspense>
  );
}

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

const TYPE_LABEL: Record<InvitationSummary['type'], string> = {
  EMPLOYEE: 'Employment offer',
  CHILD_LINK: 'Child account link',
  PARENT_LINK: 'Parent / guardian link',
  SUBSTITUTE: 'Substitute teacher invitation',
};

function InvitationsAcceptInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { refreshUser } = useAuthActions();
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
          setLoadError(
            "This invitation isn't valid anymore. It may have expired, been revoked, or already been accepted.",
          );
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
      toast('Invitation accepted', 'success');
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
      router.replace('/getting-started');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not decline the invitation. Please try again.';
      toast(message, 'error');
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col px-4 pt-16 pb-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-campus-700">
          Invitation unavailable
        </h1>
        <p className="mt-3 text-sm text-gray-600">{loadError}</p>
        <button
          type="button"
          onClick={() => router.replace('/getting-started')}
          className="mt-6 inline-flex w-fit self-center rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-600"
        >
          Back to Getting Started
        </button>
      </div>
    );
  }

  if (!invitation) {
    return <PageLoader label="Loading invitation…" />;
  }

  const expiresAt = new Date(invitation.expiresAt);
  const expiresLabel = isNaN(expiresAt.getTime()) ? null : expiresAt.toLocaleString();

  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 pt-12 pb-16 sm:pt-16">
      <h1 className="text-center text-2xl font-semibold tracking-tight text-campus-700 sm:text-3xl">
        You&rsquo;ve been invited
      </h1>
      <p className="mt-2 text-center text-sm text-gray-600">
        {invitation.inviterName} invited you to join CampusOS.
      </p>

      <dl className="mt-8 grid gap-3 rounded-card border border-gray-200 bg-white p-5 shadow-sm">
        <Row label="Type" value={TYPE_LABEL[invitation.type]} />
        {invitation.schoolName && <Row label="School" value={invitation.schoolName} />}
        {invitation.jobTitle && <Row label="Position" value={invitation.jobTitle} />}
        {expiresLabel && <Row label="Expires" value={expiresLabel} />}
      </dl>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onAccept}
          disabled={busy !== null}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
        >
          {busy === 'accept' && <LoadingSpinner size="sm" />}
          <span>{busy === 'accept' ? 'Accepting…' : 'Accept'}</span>
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
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm font-medium text-gray-900">{value}</dd>
    </div>
  );
}
