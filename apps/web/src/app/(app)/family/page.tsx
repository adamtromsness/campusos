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
  useFamilyView,
  useInviteGuardian,
  useSendChildLink,
  type FamilyChildDto,
  type FamilyChildStatus,
  type FamilyMemberDto,
  type FamilyViewerRole,
  type GenerateLinkCodeDto,
} from '@/hooks/use-family-children';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';

/**
 * /family — composite family view. Renders one of two paths driven by
 * the API's viewerRole:
 *
 *   PARENT view — the caller is a family_members row in this family.
 *     Page header shows Generate Family Code + Add Child. Each child
 *     card carries the full action set (Create Account, Send Link,
 *     Edit, Remove, View Profile per status). LinkCodeSection lets
 *     them paste a child-issued code to add a kid by name match.
 *
 *   CHILD view — the caller is a LINKED platform_family_children row
 *     in this family with no kids of their own. Page header has no
 *     write actions. Each sibling renders read-only (no buttons), and
 *     the viewer's own card surfaces an "Edit my profile" link to
 *     /profile. LinkCodeSection is hidden — children don't manage the
 *     family they're in.
 *
 * The API's viewerRole resolution is what gates write paths server-
 * side; the UI just mirrors that decision so we don't dangle controls
 * the API would 403.
 */
export default function FamilyPage() {
  const { data, isLoading, error } = useFamilyView();
  const [linkInviteFor, setLinkInviteFor] = useState<FamilyChildDto | null>(null);
  const [guardianModalOpen, setGuardianModalOpen] = useState(false);

  if (isLoading) return <PageLoader label="Loading your family…" />;
  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="My Family" />
        <p className="text-sm text-red-600">Could not load your family. Please try again.</p>
      </div>
    );
  }

  if (!data) {
    // No family resolved — registration usually seeds one, but the
    // fallback path here surfaces a recovery action rather than a
    // dead screen.
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="My Family" />
        <EmptyState
          title="No family set up yet"
          description="Add a child to your family or enter a parent's link code to get started."
          action={
            <Link
              href="/family/add-child"
              className="inline-flex items-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
            >
              Add a child
            </Link>
          }
        />
      </div>
    );
  }

  const isParent = data.viewerRole === 'PARENT';
  const children = data.children;
  const hasChildren = children.length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="My Family"
        description={
          isParent
            ? "Your family and how everyone is connected to CampusOS."
            : 'Your family — read-only view.'
        }
        actions={
          isParent ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setGuardianModalOpen(true)}
                className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
              >
                Invite a Guardian
              </button>
              <Link
                href="/family/add-child"
                className="inline-flex items-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
              >
                <span aria-hidden>+</span>
                Add Child
              </Link>
            </div>
          ) : null
        }
      />

      <ParentsAndGuardiansSection members={data.members} viewerRole={data.viewerRole} />

      {isParent ? (
        <ChildrenSection
          items={children}
          hasChildren={hasChildren}
          onSendLink={(c) => setLinkInviteFor(c)}
        />
      ) : (
        <ChildViewerSiblingsSection
          items={children}
          viewerPersonId={data.viewerPersonId}
        />
      )}

      {isParent && <LinkCodeSection />}

      <SendLinkModal
        child={linkInviteFor}
        open={linkInviteFor !== null}
        onClose={() => setLinkInviteFor(null)}
      />

      <InviteGuardianModal open={guardianModalOpen} onClose={() => setGuardianModalOpen(false)} />
    </div>
  );
}

// ─── Invite-a-guardian modal ─────────────────────────────

/**
 * Two-tab guardian-invite modal:
 *
 *   Generate a code — POST /family/invite-guardian with no email.
 *     Reveals the 8-char code with a Copy button. The parent shares
 *     it out-of-band; the recipient enters it on their own /family
 *     "Have a link code?" form.
 *
 *   Send by email — same endpoint, with an email payload. The API
 *     records target_email; an actual outbound email is still a TODO
 *     (the service logs the code to stdout for dev). The UI shows the
 *     generated code so the parent can also copy + paste if email
 *     fails.
 */
function InviteGuardianModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invite = useInviteGuardian();
  const { toast } = useToast();
  const [tab, setTab] = useState<'code' | 'email'>('code');
  const [email, setEmail] = useState('');
  const [generated, setGenerated] = useState<GenerateLinkCodeDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setTab('code');
    setEmail('');
    setGenerated(null);
    setError(null);
    onClose();
  }

  async function generateNoEmail() {
    setError(null);
    try {
      const r = await invite.mutateAsync({});
      setGenerated(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate a code.');
    }
  }

  async function generateWithEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    try {
      const r = await invite.mutateAsync({ email: trimmed });
      setGenerated(r);
      toast('Invitation prepared for ' + trimmed, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate a code.');
    }
  }

  async function copyCode() {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.code);
      toast('Code copied', 'success');
    } catch {
      toast("Couldn't copy. Select the code and copy manually.", 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite a Guardian"
      footer={
        <button
          type="button"
          onClick={close}
          className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Done
        </button>
      }
    >
      <p className="text-sm text-gray-600">
        Invite someone to join your family as a parent or guardian. They&rsquo;ll have full access
        to manage your children&rsquo;s information.
      </p>

      <div className="mt-4 inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5 text-xs font-medium">
        <button
          type="button"
          onClick={() => setTab('code')}
          className={cn(
            'rounded px-3 py-1.5',
            tab === 'code' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600',
          )}
        >
          Generate a code
        </button>
        <button
          type="button"
          onClick={() => setTab('email')}
          className={cn(
            'rounded px-3 py-1.5',
            tab === 'email' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600',
          )}
        >
          Send by email
        </button>
      </div>

      {tab === 'code' ? (
        <div className="mt-4">
          {!generated ? (
            <button
              type="button"
              onClick={() => void generateNoEmail()}
              disabled={invite.isPending}
              className="inline-flex items-center rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
            >
              {invite.isPending ? 'Generating…' : 'Generate Code'}
            </button>
          ) : (
            <CodeDisplay code={generated} onCopy={copyCode} />
          )}
        </div>
      ) : (
        <form onSubmit={generateWithEmail} className="mt-4 flex flex-col gap-2">
          <label htmlFor="guardian-email" className="text-xs font-medium text-gray-700">
            Email
          </label>
          <div className="flex gap-2">
            <input
              id="guardian-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="coparent@example.com"
              autoComplete="email"
              required
              className="block flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
            />
            <button
              type="submit"
              disabled={invite.isPending}
              className="inline-flex items-center justify-center rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
            >
              {invite.isPending ? 'Sending…' : 'Send Invitation'}
            </button>
          </div>
          {generated && <CodeDisplay code={generated} onCopy={copyCode} />}
        </form>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Modal>
  );
}

function CodeDisplay({ code, onCopy }: { code: GenerateLinkCodeDto; onCopy: () => void }) {
  const expiry = new Date(code.expiresAt);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
        <code className="font-mono text-xl font-semibold tracking-[0.25em] text-gray-900">
          {code.code}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-campus-600"
        >
          Copy
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Share this code with your co-parent or guardian. They enter it on their /family page.
        Expires {expiry.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.
      </p>
    </div>
  );
}

// ─── Parents & Guardians ─────────────────────────────────

/**
 * Renders the adults of the family. The caller's own row gets an
 * "Edit profile" link to /profile (the only writeable edit they get
 * through this surface — other adults' info is intentionally
 * read-only here per the family-role spec).
 */
function ParentsAndGuardiansSection({
  members,
  viewerRole,
}: {
  members: FamilyMemberDto[];
  viewerRole: FamilyViewerRole;
}) {
  if (members.length === 0) return null;
  return (
    <section className="mt-2">
      <h2 className="mb-2 text-sm font-semibold text-gray-900">Parents &amp; Guardians</h2>
      <ul className="flex flex-col gap-2">
        {members.map((m) => (
          <li
            key={m.personId}
            className="flex items-start justify-between gap-3 rounded-card border border-gray-200 bg-white p-4 shadow-sm"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">
                {[m.firstName, m.lastName].filter(Boolean).join(' ')}
                {m.isCurrentUser && (
                  <span className="ml-2 text-xs font-normal text-gray-500">(you)</span>
                )}
              </p>
              <p className="text-xs text-gray-500">
                {[
                  goesByLabel(m.firstName, m.preferredName),
                  'Parent / Guardian',
                  m.isPrimaryContact ? 'primary contact' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            {m.isCurrentUser && (
              <Link
                href="/profile"
                className="inline-flex shrink-0 items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit profile
              </Link>
            )}
            {/* Non-current adults render read-only regardless of viewerRole. */}
            {viewerRole === 'CHILD' && !m.isCurrentUser && null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Children — PARENT viewer's variant ──────────────────

function ChildrenSection({
  items,
  hasChildren,
  onSendLink,
}: {
  items: FamilyChildDto[];
  hasChildren: boolean;
  onSendLink: (child: FamilyChildDto) => void;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold text-gray-900">Children</h2>
      {hasChildren ? (
        <ul className="flex flex-col gap-3">
          {items.map((child) => (
            <li key={child.id}>
              <ChildCard child={child} onSendLink={() => onSendLink(child)} />
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
    </section>
  );
}

// ─── Children — CHILD viewer's variant ───────────────────

/**
 * From a child's perspective the children[] list contains the viewer
 * themself + their siblings. We split the two and render the viewer
 * with an Edit-my-profile link, the siblings as read-only badges-only
 * rows. No status badges on the viewer's row — the LINKED status is
 * implicit and a "Connected" badge under your own name reads oddly.
 */
function ChildViewerSiblingsSection({
  items,
  viewerPersonId,
}: {
  items: FamilyChildDto[];
  viewerPersonId: string;
}) {
  const me = items.find((c) => c.personId === viewerPersonId) ?? null;
  const siblings = items.filter((c) => c.personId !== viewerPersonId);

  return (
    <>
      {siblings.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-gray-900">Siblings</h2>
          <ul className="flex flex-col gap-2">
            {siblings.map((s) => {
              const age = computeAge(s.dateOfBirth);
              return (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-3 rounded-card border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">
                        {s.firstName} {s.lastName}
                      </p>
                      <StatusBadgeForChild status={s.status} />
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {[
                        goesByLabel(s.firstName, s.preferredName),
                        age !== null ? `age ${age}` : 'No DOB',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {me && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-gray-900">My profile</h2>
          <div className="flex items-start justify-between gap-3 rounded-card border border-gray-200 bg-white p-4 shadow-sm">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">
                {me.firstName} {me.lastName}
                <span className="ml-2 text-xs font-normal text-gray-500">(you)</span>
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {(() => {
                  const age = computeAge(me.dateOfBirth);
                  return [
                    goesByLabel(me.firstName, me.preferredName),
                    age !== null ? `age ${age}` : 'No DOB',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                })()}
              </p>
            </div>
            <Link
              href="/profile"
              className="inline-flex shrink-0 items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Edit my profile
            </Link>
          </div>
        </section>
      )}
    </>
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
            {[
              goesByLabel(child.firstName, child.preferredName),
              child.dateOfBirth ? formatDate(child.dateOfBirth) : 'No DOB',
              age !== null ? `age ${age}` : null,
              isUnder13 ? 'under 13' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
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
            {/* Edit lives on the detail page — its EditChildForm
                pre-fills from the GET /family/children DTO, which now
                joins iam_person for LINKED rows. The old route
                /family/add-child?edit=… ignored the query param and
                landed the parent on an empty wizard. */}
            <SecondaryButton onClick={() => router.push(`/family/children/${child.id}`)}>
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
            {/* Edit lives on the detail page — its EditChildForm
                pre-fills from the GET /family/children DTO, which now
                joins iam_person for LINKED rows. The old route
                /family/add-child?edit=… ignored the query param and
                landed the parent on an empty wizard. */}
            <SecondaryButton onClick={() => router.push(`/family/children/${child.id}`)}>
              Edit
            </SecondaryButton>
          </>
        )}
        {child.status === 'LINKED' && (
          // /family/children/[id] is the parent's edit surface — it
          // patches both iam_person and platform_family_children for
          // LINKED children in one transaction. The /profile/[personId]
          // route is admin-only and 403s parents, so this is the
          // canonical "view + edit a kid" entry point.
          <Link
            href={`/family/children/${child.id}`}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            View / Edit
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
        Enter a child&rsquo;s code to add them to your family, or a parent&rsquo;s family code
        to join theirs.
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

/**
 * Returns `Goes by "Liv"` when preferredName is set and different
 * from firstName (case-insensitive trim). Null otherwise so the
 * caller can drop it from a `·`-joined metadata line without an
 * empty leading separator.
 */
function goesByLabel(firstName: string, preferredName: string | null | undefined): string | null {
  if (!preferredName) return null;
  const a = firstName.trim().toLowerCase();
  const b = preferredName.trim().toLowerCase();
  if (!b || a === b) return null;
  return `Goes by "${preferredName}"`;
}

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
