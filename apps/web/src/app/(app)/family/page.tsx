'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import { useAuthActions } from '@/lib/auth-context';
import {
  useAcceptFamilyLink,
  useAddFamilyMember,
  useCancelChildLink,
  useCreateChildAccount,
  useCreateMemberAccount,
  useDeleteFamilyChild,
  useDeleteFamilyMember,
  useFamilyView,
  useGenerateFamilyCode,
  useInviteGuardian,
  useSendChildLink,
  useSendMemberInvite,
  type FamilyAccessLevel,
  type FamilyChildDto,
  type FamilyChildStatus,
  type FamilyMemberDto,
  type FamilyMemberStatus,
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
  const [memberInviteFor, setMemberInviteFor] = useState<FamilyMemberDto | null>(null);
  const [inviteGuardianOpen, setInviteGuardianOpen] = useState(false);
  const [addGuardianOpen, setAddGuardianOpen] = useState(false);
  const [inviteChildOpen, setInviteChildOpen] = useState(false);

  // Deep-link from /family/settings — `?action=invite-guardian` or
  // `?action=add-guardian` auto-opens the matching modal so the
  // settings page can show real action buttons instead of dumping
  // the user on this page without context. The router replace strips
  // the query once consumed so a back-button doesn't re-trigger.
  const searchParams = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const action = searchParams.get('action');
    if (!action) return;
    if (action === 'invite-guardian') setInviteGuardianOpen(true);
    else if (action === 'add-guardian') setAddGuardianOpen(true);
    else if (action === 'invite-child') setInviteChildOpen(true);
    router.replace('/family');
  }, [searchParams, router]);

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
            ? 'Your family and how everyone is connected to CampusOS.'
            : 'Your family — read-only view.'
        }
        actions={
          <div className="flex gap-2">
            <Link
              href="/family/tree"
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            >
              View Family Tree
            </Link>
            <Link
              href="/family/settings"
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            >
              Family Settings
            </Link>
          </div>
        }
      />

      <ParentsAndGuardiansSection
        members={data.members}
        viewerRole={data.viewerRole}
        onInvite={() => setInviteGuardianOpen(true)}
        onAdd={() => setAddGuardianOpen(true)}
        onSendInvite={(m) => setMemberInviteFor(m)}
      />

      {isParent ? (
        <ChildrenSection
          items={children}
          hasChildren={hasChildren}
          onSendLink={(c) => setLinkInviteFor(c)}
          onInvite={() => setInviteChildOpen(true)}
        />
      ) : (
        <ChildViewerSiblingsSection items={children} viewerPersonId={data.viewerPersonId} />
      )}

      {isParent && <LinkCodeSection />}

      <SendLinkModal
        child={linkInviteFor}
        open={linkInviteFor !== null}
        onClose={() => setLinkInviteFor(null)}
      />

      <InviteGuardianModal open={inviteGuardianOpen} onClose={() => setInviteGuardianOpen(false)} />
      <AddGuardianModal open={addGuardianOpen} onClose={() => setAddGuardianOpen(false)} />
      <InviteChildModal open={inviteChildOpen} onClose={() => setInviteChildOpen(false)} />
      <SendMemberInviteModal
        member={memberInviteFor}
        open={memberInviteFor !== null}
        onClose={() => setMemberInviteFor(null)}
      />
    </div>
  );
}

// ─── Section header row ──────────────────────────────────

/**
 * Section title + right-aligned action buttons. Replaces the old
 * page-level header bar; per-section buttons keep Invite / Add
 * scoped to whichever group of people they affect.
 */
function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

function OutlineButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
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

// ─── Add-a-guardian modal (placeholder-create form) ──────

/**
 * Form-based modal that creates a placeholder platform_family_members
 * row via POST /family/members. The parent supplies a name + optional
 * email + relationship; the new row lands at status='PLACEHOLDER'
 * with person_id=NULL. The parent then promotes the row via either
 * "Send Invite" (generates a GUARDIAN_INVITE the future guardian
 * accepts) or "Create Account" (synthesises an iam_person + linked
 * platform_users) from the row's action buttons on /family.
 *
 * The "Invite a Guardian" modal stays separate — it generates an
 * OPEN GUARDIAN_INVITE (no familyMemberId scope) that anyone can
 * accept. Use Add when you know the person; use Invite when you
 * just want a sharable code.
 */
const RELATIONSHIPS = [
  { value: 'CO_PARENT', label: 'Co-parent' },
  { value: 'SPOUSE', label: 'Spouse' },
  { value: 'GRANDPARENT', label: 'Grandparent' },
  { value: 'LEGAL_GUARDIAN', label: 'Legal guardian' },
  { value: 'OTHER', label: 'Other' },
];

function AddGuardianModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddFamilyMember();
  const { toast } = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [relationship, setRelationship] = useState(RELATIONSHIPS[0]!.value);
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string; email?: string }>(
    {},
  );

  function close() {
    setFirstName('');
    setLastName('');
    setEmail('');
    setRelationship(RELATIONSHIPS[0]!.value);
    setErrors({});
    onClose();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v: typeof errors = {};
    if (!firstName.trim()) v.firstName = 'First name is required';
    if (!lastName.trim()) v.lastName = 'Last name is required';
    // Email optional. If provided, must be valid.
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      v.email = 'Enter a valid email address';
    }
    if (Object.keys(v).length > 0) {
      setErrors(v);
      return;
    }
    setErrors({});
    try {
      await add.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || undefined,
        relationship,
      });
      toast(firstName.trim() + ' added to your family', 'success');
      close();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not add the guardian. Try again.';
      toast(message, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a Guardian"
      footer={
        <button
          type="button"
          onClick={close}
          className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      }
    >
      <p className="text-sm text-gray-600">
        Add a co-parent or guardian to your family. You can send them an invitation later, or create
        an account on their behalf.
      </p>
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ModalField
            id="ag-first"
            label="First name"
            value={firstName}
            onChange={setFirstName}
            error={errors.firstName}
            required
          />
          <ModalField
            id="ag-last"
            label="Last name"
            value={lastName}
            onChange={setLastName}
            error={errors.lastName}
            required
          />
        </div>
        <ModalField
          id="ag-email"
          label="Email (optional)"
          type="email"
          value={email}
          onChange={setEmail}
          error={errors.email}
        />
        <div>
          <label htmlFor="ag-relationship" className="block text-xs font-medium text-gray-700">
            Relationship
          </label>
          <select
            id="ag-relationship"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          >
            {RELATIONSHIPS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button
            type="submit"
            disabled={add.isPending}
            className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
          >
            {add.isPending && <LoadingSpinner size="sm" />}
            <span>{add.isPending ? 'Adding…' : 'Add to Family'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Invite-a-child modal (two-tab) ──────────────────────

/**
 * Two-tab modal for inviting a child. Both tabs hit POST
 * /family/generate-code which mints a FAMILY_INVITE; the email tab
 * additionally stamps target_email so the future send-email worker
 * has the address.
 *
 * Generate code   — empty payload, shows the 8-char code immediately.
 * Send by email   — captures an email, prepares the same code.
 */
function InviteChildModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const generate = useGenerateFamilyCode();
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
      const r = await generate.mutateAsync({});
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
      const r = await generate.mutateAsync({ email: trimmed });
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
      title="Invite a Child"
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
        Share a code your child can enter on CampusOS to join your family.
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
          Generate code
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
              disabled={generate.isPending}
              className="inline-flex items-center rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
            >
              {generate.isPending ? 'Generating…' : 'Generate code'}
            </button>
          ) : (
            <CodeDisplay code={generated} onCopy={copyCode} />
          )}
        </div>
      ) : (
        <form onSubmit={generateWithEmail} className="mt-4 flex flex-col gap-2">
          <label htmlFor="invite-child-email" className="text-xs font-medium text-gray-700">
            Email
          </label>
          <div className="flex gap-2">
            <input
              id="invite-child-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="kid@example.com"
              autoComplete="email"
              required
              className="block flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
            />
            <button
              type="submit"
              disabled={generate.isPending}
              className="inline-flex items-center justify-center rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
            >
              {generate.isPending ? 'Sending…' : 'Send Invitation'}
            </button>
          </div>
          {generated && <CodeDisplay code={generated} onCopy={copyCode} />}
        </form>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Modal>
  );
}

function ModalField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  required,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-invalid={!!error}
        className={
          'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
          (error ? 'border-red-300' : 'border-gray-300')
        }
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
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
  onInvite,
  onAdd,
  onSendInvite,
}: {
  members: FamilyMemberDto[];
  viewerRole: FamilyViewerRole;
  onInvite: () => void;
  onAdd: () => void;
  onSendInvite: (m: FamilyMemberDto) => void;
}) {
  if (members.length === 0) return null;
  const isParent = viewerRole === 'PARENT';
  return (
    <section className="mt-6">
      <SectionHeader title="Parents & Guardians">
        {isParent && (
          <>
            <OutlineButton onClick={onInvite}>Invite</OutlineButton>
            <OutlineButton onClick={onAdd}>Add</OutlineButton>
          </>
        )}
      </SectionHeader>
      <ul className="flex flex-col gap-3">
        {members.map((m) => (
          <li key={m.id}>
            <GuardianCard
              member={m}
              canManage={isParent && !m.isCurrentUser}
              onSendInvite={() => onSendInvite(m)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Per-status guardian card ────────────────────────────

const MEMBER_BADGES: Record<FamilyMemberStatus, { bg: string; text: string; label: string }> = {
  PLACEHOLDER: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Account needed' },
  PENDING_INVITE: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Invite pending' },
  ACTIVE: { bg: 'bg-green-100', text: 'text-green-800', label: 'Active' },
};

function StatusBadgeForMember({
  status,
  accessLevel,
}: {
  status: FamilyMemberStatus;
  accessLevel?: FamilyAccessLevel;
}) {
  // PENDING_INVITE stays a dedicated lifecycle badge — the access
  // level is still PLACEHOLDER until accept. ACTIVE rows defer to
  // the access-level badge (Managed by you / Independent).
  if (status === 'PENDING_INVITE') {
    return <PillBadge style={MEMBER_BADGES.PENDING_INVITE} />;
  }
  if (status === 'ACTIVE' && accessLevel) {
    return <PillBadge style={accessBadge(accessLevel)} />;
  }
  return <PillBadge style={MEMBER_BADGES[status]} />;
}

function GuardianCard({
  member,
  canManage,
  onSendInvite,
}: {
  member: FamilyMemberDto;
  canManage: boolean;
  onSendInvite: () => void;
}) {
  const { toast } = useToast();
  const createAccount = useCreateMemberAccount(member.id);
  const removeMember = useDeleteFamilyMember(member.id);

  async function onCreateAccount() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Create a managed account for ' +
          member.firstName +
          '?\n\n' +
          'You will manage this account. ' +
          member.firstName +
          " won't need to accept an invitation — you'll have full control over their profile and settings.\n\n" +
          'If they should manage their own account, use "Send Invite" instead.',
      )
    ) {
      return;
    }
    try {
      await createAccount.mutateAsync({ email: member.email ?? undefined });
      toast(member.firstName + ' now has a managed account', 'success');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not create the account. Try again.';
      toast(message, 'error');
    }
  }

  async function onRemove() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Remove ' + member.firstName + ' from your family?')
    ) {
      return;
    }
    try {
      await removeMember.mutateAsync();
      toast(member.firstName + ' removed', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not remove this guardian.';
      toast(message, 'error');
    }
  }

  const heroName = member.preferredName?.trim() ? member.preferredName : member.firstName;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xl font-semibold text-gray-900">{heroName}</p>
            <StatusBadgeForMember status={member.status} accessLevel={member.accessLevel} />
            {member.isCurrentUser && <span className="text-xs text-gray-500">(you)</span>}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {[member.firstName, member.lastName].filter(Boolean).join(' ') + ' · Parent / Guardian'}
          </p>
          {member.isPrimaryContact && (
            <p className="mt-0.5 text-xs text-gray-500">Primary contact</p>
          )}
          {member.status === 'PENDING_INVITE' && member.inviteCode && (
            <p className="mt-2 text-xs text-gray-600">
              {member.email ? (
                <>
                  Sent to <span className="font-medium">{member.email}</span> · code{' '}
                </>
              ) : (
                'Code '
              )}
              <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] tracking-wider">
                {member.inviteCode}
              </code>
            </p>
          )}
        </div>
        {member.isCurrentUser && (
          <Link
            href="/profile"
            className="inline-flex shrink-0 items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Edit profile
          </Link>
        )}
      </div>

      {canManage && member.status !== 'ACTIVE' && (
        <div className="mt-4 flex flex-wrap gap-2">
          <SecondaryButton onClick={onCreateAccount} disabled={createAccount.isPending}>
            {createAccount.isPending ? 'Creating…' : 'Create Account'}
          </SecondaryButton>
          <SecondaryButton onClick={onSendInvite}>
            {member.status === 'PENDING_INVITE' ? 'Resend Invite' : 'Send Invite'}
          </SecondaryButton>
          <DangerButton onClick={onRemove} disabled={removeMember.isPending}>
            {removeMember.isPending ? 'Removing…' : 'Remove'}
          </DangerButton>
        </div>
      )}
    </div>
  );
}

// ─── Children — PARENT viewer's variant ──────────────────

function ChildrenSection({
  items,
  hasChildren,
  onSendLink,
  onInvite,
}: {
  items: FamilyChildDto[];
  hasChildren: boolean;
  onSendLink: (child: FamilyChildDto) => void;
  onInvite: () => void;
}) {
  const router = useRouter();
  return (
    <section className="mt-8">
      <SectionHeader title="Children">
        <OutlineButton onClick={onInvite}>Invite</OutlineButton>
        <OutlineButton onClick={() => router.push('/family/add-child')}>Add</OutlineButton>
      </SectionHeader>
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
 * themself + their siblings. We split the two and render "My profile"
 * FIRST (the child is a member of the family just like the parents, so
 * their card sits between Parents & Guardians and Siblings), then the
 * siblings as read-only rows below.
 *
 * No status / access-level badges on either the viewer's own row or
 * the sibling rows: the LINKED status is implicit ("Connected" under
 * your own name reads oddly), and a child has no business knowing who
 * manages a sibling's account — "Managed by you" is plainly wrong from
 * the child's perspective (the parents manage it, not the viewer), so
 * siblings show name + age only.
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
                    <p className="text-sm font-medium text-gray-900">
                      {s.firstName} {s.lastName}
                    </p>
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

/**
 * Pick a status badge that surfaces the account's access level when
 * meaningful: MANAGED = "you own this account", INDEPENDENT = "they
 * own their account, you can read it." For pre-link states we fall
 * back to the lifecycle status (Account needed / Link pending).
 */
function accessBadge(accessLevel: FamilyAccessLevel): BadgeStyle {
  if (accessLevel === 'MANAGED') {
    return { bg: 'bg-emerald-100', text: 'text-emerald-800', label: '🛡️ Managed by you' };
  }
  if (accessLevel === 'INDEPENDENT') {
    return { bg: 'bg-sky-100', text: 'text-sky-800', label: '🔗 Independent' };
  }
  // PLACEHOLDER access level — caller decides whether the row is in
  // pre-link or invite-sent state via pendingLabel.
  return { bg: 'bg-amber-100', text: 'text-amber-800', label: '⏳ No account' };
}

function StatusBadgeForChild({
  status,
  accessLevel,
}: {
  status: FamilyChildStatus;
  accessLevel?: FamilyAccessLevel;
}) {
  // PENDING_LINK has a dedicated badge — the access level is still
  // PLACEHOLDER until the link completes, but the lifecycle stage is
  // worth surfacing on its own. PLACEHOLDER + LINKED defer to the
  // access-level badge.
  if (status === 'PENDING_LINK') {
    return <PillBadge style={BADGES.PENDING_LINK} />;
  }
  if (accessLevel) {
    return <PillBadge style={accessBadge(accessLevel)} />;
  }
  const b = BADGES[status];
  return <PillBadge style={b} />;
}

function PillBadge({ style }: { style: BadgeStyle }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        style.bg,
        style.text,
      )}
    >
      {style.label}
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
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Create a managed account for ' +
          child.firstName +
          '?\n\n' +
          'You will manage this account. ' +
          child.firstName +
          " won't need to accept an invitation — you'll have full control over their profile and settings. Recommended for children under 13.\n\n" +
          'For older children who already have their own account, use "Send Link Invitation" instead.',
      )
    ) {
      return;
    }
    try {
      // For the simple "Create Account" button on the card we don't
      // collect an email — under-13 accounts are parent-managed
      // (COPPA), and 13+ children can be invited via Send Link later
      // if they want their own email-based access. The wizard
      // collects the email when the user explicitly picks Card C.
      await createAccount.mutateAsync({});
      toast(`${child.firstName} now has a managed account`, 'success');
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

  const heroName = child.preferredName?.trim() ? child.preferredName : child.firstName;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xl font-semibold text-gray-900">{heroName}</p>
            <StatusBadgeForChild status={child.status} accessLevel={child.accessLevel} />
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {[
              [child.firstName, child.middleName, child.lastName].filter(Boolean).join(' '),
              child.dateOfBirth ? formatDate(child.dateOfBirth) : 'No DOB',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {[age !== null ? `age ${age}` : null, isUnder13 ? 'under 13' : null]
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
          // Both MANAGED and INDEPENDENT linked children land on the
          // same tabbed profile page. The page itself decides what's
          // editable: MANAGED → name + identity fields are writable;
          // INDEPENDENT → those fields are read-only but parents still
          // edit the medical / emergency / dietary sections they own.
          // The card label stays "View Profile" so the entry point
          // doesn't promise edit access we can't always deliver.
          <Link
            href={`/family/children/${child.id}`}
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
  const { refreshUser } = useAuthActions();
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
      // Pull /auth/me back into the auth store so any new persona
      // (PARENT for a GUARDIAN_INVITE accept; CHILD for a parent-side
      // CHILD_LINK accept) activates immediately in the top bar +
      // persona switcher. Without this, the server-side persona cache
      // is fresh but the client's Zustand store still shows the
      // pre-accept "Set up your profile" state.
      await refreshUser();
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
    <section className="mt-10 rounded-lg border border-gray-200 bg-gray-50/40 p-5">
      <h3 className="text-sm font-semibold text-gray-900">Have a link code?</h3>
      <p className="mt-1 text-xs text-gray-600">Enter a code from a child, parent, or school.</p>
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

// ─── Send-invite-to-placeholder-guardian modal ───────────

/**
 * Generates a targeted GUARDIAN_INVITE for a specific placeholder
 * member row via POST /family/members/:id/send-invite. The email
 * defaults to whatever the parent stored on the row when they added
 * the placeholder; they can override here before sending. After
 * submit, shows the 8-char code with a Copy button — useful when
 * the email send (still a TODO) doesn't land.
 */
function SendMemberInviteModal({
  member,
  open,
  onClose,
}: {
  member: FamilyMemberDto | null;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  // Hooks must run unconditionally on every render — pass a sentinel
  // id when the modal is closed and gate the actual submit on member.
  const send = useSendMemberInvite(member?.id ?? 'pending');
  const [email, setEmail] = useState('');

  // Reseed when the modal switches between members.
  useEffect(() => {
    if (member) setEmail(member.email ?? '');
  }, [member]);

  function close() {
    setEmail('');
    onClose();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!member) return;
    const trimmed = email.trim();
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast('Enter a valid email address', 'error');
      return;
    }
    try {
      await send.mutateAsync({ email: trimmed || undefined });
      toast(
        trimmed
          ? 'Invitation sent to ' + trimmed
          : 'Invitation code generated — copy + share manually',
        'success',
      );
      close();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send the invitation.';
      toast(message, 'error');
    }
  }

  if (!member) return null;

  return (
    <Modal
      open={open}
      onClose={close}
      title={'Send invite to ' + member.firstName}
      footer={
        <>
          <button
            type="button"
            onClick={close}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="send-member-invite-form"
            disabled={send.isPending}
            className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
          >
            {send.isPending && <LoadingSpinner size="sm" />}
            <span>{send.isPending ? 'Sending…' : 'Send Invitation'}</span>
          </button>
        </>
      }
    >
      <form id="send-member-invite-form" onSubmit={onSubmit} className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          Generate a code {member.firstName} can enter on CampusOS to join your family as a parent
          or guardian.
        </p>
        <div>
          <label htmlFor="member-invite-email" className="block text-xs font-medium text-gray-700">
            Email (optional)
          </label>
          <input
            id="member-invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={member.firstName.toLowerCase() + '@example.com'}
            autoComplete="email"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            If left blank, you&rsquo;ll share the code manually.
          </p>
        </div>
      </form>
    </Modal>
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
