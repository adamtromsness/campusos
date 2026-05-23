'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import {
  useAcceptFamilyLink,
  useCancelChildLink,
  useCreateChildAccount,
  useDeleteFamilyChild,
  useFamilyChildren,
  useSendChildLink,
  type FamilyChildDto,
  type FamilyChildStatus,
} from '@/hooks/use-family-children';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';

/**
 * /family — overview of the caller's family children. Section 3 of
 * the persona-registration design.
 *
 * Each child renders as a card with a status-coded badge and a
 * per-status action set:
 *   PLACEHOLDER   → Create Account, Send Link Invitation, Edit, Remove
 *   PENDING_LINK  → Resend, Cancel Link, Edit
 *   LINKED        → View Profile
 *
 * The page is intentionally simple — every mutating action goes
 * through the dedicated hooks in use-family-children.ts so the React
 * Query cache stays the single source of truth.
 */
export default function FamilyPage() {
  const { data, isLoading, error } = useFamilyChildren();
  const [linkInviteFor, setLinkInviteFor] = useState<FamilyChildDto | null>(null);

  if (isLoading) return <PageLoader label="Loading your family…" />;
  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="My Family" />
        <p className="text-sm text-red-600">Could not load your family. Please try again.</p>
      </div>
    );
  }

  const children = data ?? [];
  const hasChildren = children.length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="My Family"
        description="Your children and how they're connected to CampusOS."
        actions={
          <Link
            href="/family/add-child"
            className="inline-flex items-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
          >
            <span aria-hidden>+</span>
            Add Child
          </Link>
        }
      />

      {hasChildren ? (
        <ul className="flex flex-col gap-3">
          {children.map((child) => (
            <li key={child.id}>
              <ChildCard child={child} onSendLink={() => setLinkInviteFor(child)} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No children added yet"
          description="Add your children to your family before applying to schools or accepting invitations."
          action={
            <Link
              href="/family/add-child"
              className="inline-flex items-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
            >
              Add a child
            </Link>
          }
        />
      )}

      <LinkCodeSection />

      <SendLinkModal
        child={linkInviteFor}
        open={linkInviteFor !== null}
        onClose={() => setLinkInviteFor(null)}
      />
    </div>
  );
}

// ─── Status badge ──────────────────────────────────────────

interface BadgeStyle {
  bg: string;
  text: string;
  label: string;
}

const BADGES: Record<FamilyChildStatus, BadgeStyle> = {
  PLACEHOLDER: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Account needed' },
  PENDING_LINK: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Link pending' },
  LINKED: { bg: 'bg-green-100', text: 'text-green-800', label: 'Connected' },
};

function StatusBadgeForChild({ status }: { status: FamilyChildStatus }) {
  const b = BADGES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        b.bg,
        b.text,
      )}
    >
      {b.label}
    </span>
  );
}

// ─── Child card ────────────────────────────────────────────

function ChildCard({ child, onSendLink }: { child: FamilyChildDto; onSendLink: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const createAccount = useCreateChildAccount(child.id);
  const removeChild = useDeleteFamilyChild(child.id);
  const cancelLink = useCancelChildLink(child.id);

  const age = computeAge(child.dateOfBirth);
  const isUnder13 = age !== null && age < 13;

  async function onCreateAccount() {
    try {
      // For the simple "Create Account" button on the card we don't
      // collect an email — under-13 accounts are parent-managed
      // (COPPA), and 13+ children can be invited via Send Link later
      // if they want their own email-based access. The wizard
      // collects the email when the user explicitly picks Card C.
      await createAccount.mutateAsync({});
      toast(`${child.firstName} now has a CampusOS account`, 'success');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not create the account. Try again.';
      toast(message, 'error');
    }
  }

  async function onRemove() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Remove ${child.firstName} from your family?`)
    ) {
      return;
    }
    try {
      await removeChild.mutateAsync();
      toast(`${child.firstName} removed`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not remove this child.';
      toast(message, 'error');
    }
  }

  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">
              {child.firstName} {child.lastName}
            </h2>
            <StatusBadgeForChild status={child.status} />
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {child.dateOfBirth ? formatDate(child.dateOfBirth) : 'No DOB'}
            {age !== null && ` · age ${age}`}
            {isUnder13 && ' · under 13'}
          </p>
          {child.status === 'PENDING_LINK' && child.inviteCode && (
            <p className="mt-2 text-xs text-gray-600">
              Sent to <span className="font-medium">{child.inviteEmail}</span> · code{' '}
              <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] tracking-wider">
                {child.inviteCode}
              </code>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {child.status === 'PLACEHOLDER' && (
          <>
            <SecondaryButton onClick={onCreateAccount} disabled={createAccount.isPending}>
              {createAccount.isPending ? 'Creating…' : 'Create Account'}
            </SecondaryButton>
            <SecondaryButton onClick={onSendLink}>Send Link Invitation</SecondaryButton>
            <SecondaryButton onClick={() => router.push(`/family/add-child?edit=${child.id}`)}>
              Edit
            </SecondaryButton>
            <DangerButton onClick={onRemove} disabled={removeChild.isPending}>
              {removeChild.isPending ? 'Removing…' : 'Remove'}
            </DangerButton>
          </>
        )}
        {child.status === 'PENDING_LINK' && (
          <>
            {/* Resend uses POST send-link, which now accepts both
                PLACEHOLDER + PENDING_LINK (Codex review FIX 4): the
                old code gets revoked, a fresh code + 72h timer go
                out. */}
            <SecondaryButton onClick={onSendLink}>Resend</SecondaryButton>
            <SecondaryButton
              onClick={() =>
                void cancelLink
                  .mutateAsync()
                  .then(() => toast('Link cancelled', 'success'))
                  .catch(() => toast('Could not cancel the link.', 'error'))
              }
              disabled={cancelLink.isPending}
            >
              {cancelLink.isPending ? 'Cancelling…' : 'Cancel Link'}
            </SecondaryButton>
            <SecondaryButton onClick={() => router.push(`/family/add-child?edit=${child.id}`)}>
              Edit
            </SecondaryButton>
          </>
        )}
        {child.status === 'LINKED' && child.personId && (
          <Link
            href={`/profile/${child.personId}`}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            View Profile
          </Link>
        )}
      </div>
    </div>
  );
}

// ─── Link code section + modal ────────────────────────────

function LinkCodeSection() {
  const accept = useAcceptFamilyLink();
  const { toast } = useToast();
  const [code, setCode] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase().replace(/-/g, '');
    if (trimmed.length !== 8) {
      toast('Codes are 8 characters', 'error');
      return;
    }
    try {
      await accept.mutateAsync({ code: trimmed });
      toast('Linked successfully', 'success');
      setCode('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast('Invalid or expired link code', 'error');
      } else if (err instanceof ApiError && err.status === 429) {
        toast('Too many attempts. Try again in a few minutes.', 'error');
      } else {
        toast('Could not link. Please try again.', 'error');
      }
    }
  }

  return (
    <section className="mt-10 rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Have a link code?</h2>
      <p className="mt-1 text-xs text-gray-600">
        Enter it here to connect to a family that invited you.
      </p>
      <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD1234"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="block flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm uppercase tracking-wider text-gray-900 shadow-sm placeholder:font-mono placeholder:text-gray-300 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
        />
        <button
          type="submit"
          disabled={accept.isPending}
          className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
        >
          {accept.isPending && <LoadingSpinner size="sm" />}
          <span>{accept.isPending ? 'Linking…' : 'Link'}</span>
        </button>
      </form>
    </section>
  );
}

function SendLinkModal({
  child,
  open,
  onClose,
}: {
  child: FamilyChildDto | null;
  open: boolean;
  onClose: () => void;
}) {
  const send = useSendChildLink(child?.id ?? 'pending');
  const { toast } = useToast();
  const [email, setEmail] = useState('');

  // Reset email when the modal switches between children.
  // useEffect-without-an-import via a key on the form would also work,
  // but a simple state reset on close keeps it explicit.
  const handleClose = () => {
    setEmail('');
    onClose();
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!child) return;
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast('Enter a valid email address', 'error');
      return;
    }
    try {
      await send.mutateAsync({ email: trimmed });
      toast(`Code sent to ${trimmed}`, 'success');
      handleClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send the invitation.';
      toast(message, 'error');
    }
  }

  if (!child) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Send link invitation for ${child.firstName}`}
      footer={
        <>
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="send-link-form"
            disabled={send.isPending}
            className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
          >
            {send.isPending && <LoadingSpinner size="sm" />}
            <span>{send.isPending ? 'Sending…' : 'Send Invitation'}</span>
          </button>
        </>
      }
    >
      <form id="send-link-form" onSubmit={onSubmit} className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          We&rsquo;ll send a code to this email. The recipient enters it in their CampusOS account
          to connect.
        </p>
        <div>
          <label htmlFor="link-email" className="block text-xs font-medium text-gray-700">
            Email
          </label>
          <input
            id="link-email"
            name="link-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={`${child.firstName.toLowerCase()}@example.com`}
            autoComplete="email"
            required
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Small button primitives ───────────────────────────────

function SecondaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function DangerButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex items-center rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-50 disabled:opacity-60"
    >
      {children}
    </button>
  );
}

// ─── helpers ───────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function computeAge(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
