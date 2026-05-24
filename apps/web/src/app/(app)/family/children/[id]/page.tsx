'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  useCancelChildLink,
  useCreateChildAccount,
  useDeleteFamilyChild,
  useFamilyChildren,
  useSendChildLink,
  useUpdateFamilyChild,
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
 * /family/children/[id] — detail view for a single family child.
 *
 * The parent-facing replacement for /profile/[personId] when the child
 * comes from platform_family_children rather than sis_students. The
 * admin profile route 403s parents because it requires an admin-tier
 * permission, and it never returns rows for PLACEHOLDER children (no
 * iam_person yet).
 *
 * Source of truth: GET /family/children. There's no per-id endpoint
 * (yet) — the list is small (a parent's own children) so we fetch the
 * list and filter by id. Same data the /family card shows, just laid
 * out for a single-child workflow.
 *
 * Sections:
 *   1. Header — name + status badge + DOB/age line.
 *   2. Status-appropriate actions — Create Account / Send Link / Edit /
 *      Remove for PLACEHOLDER; Resend / Cancel Link / Edit for
 *      PENDING_LINK; "Connected since" for LINKED.
 *   3. Enrolment — "Not enrolled at any school" with Find a school +
 *      Start enrolment links. Once enrolment-from-family is wired up
 *      this section will read sis_students and surface school + grade.
 */
export default function FamilyChildDetailPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { data, isLoading, error } = useFamilyChildren();
  const [linkInviteOpen, setLinkInviteOpen] = useState(false);

  if (isLoading) return <PageLoader label="Loading…" />;

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="My Family" />
        <p className="text-sm text-red-600">Could not load your family. Please try again.</p>
      </div>
    );
  }

  const child = (data ?? []).find((c) => c.id === id);
  if (!child) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <EmptyState
          title="Child not found"
          description="The child may have been removed, or this link belongs to a different family."
          action={
            <Link
              href="/family"
              className="text-sm font-medium text-campus-700 hover:text-campus-600"
            >
              ← Back to My Family
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={`${child.firstName} ${child.lastName}`}
        description="Family child profile and school enrolment"
        actions={
          <Link href="/family" className="text-sm font-medium text-gray-500 hover:text-gray-700">
            ← My Family
          </Link>
        }
      />

      <DetailCard child={child} onSendLink={() => setLinkInviteOpen(true)} />

      <EnrolmentSection child={child} />

      <SendLinkModal
        child={child}
        open={linkInviteOpen}
        onClose={() => setLinkInviteOpen(false)}
      />
    </div>
  );
}

// ─── Detail card (mirrors /family card layout) ─────────────

const BADGES: Record<FamilyChildStatus, { bg: string; text: string; label: string }> = {
  PLACEHOLDER: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Account needed' },
  PENDING_LINK: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Link pending' },
  LINKED: { bg: 'bg-green-100', text: 'text-green-800', label: 'Connected' },
};

function DetailCard({
  child,
  onSendLink,
}: {
  child: FamilyChildDto;
  onSendLink: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const createAccount = useCreateChildAccount(child.id);
  const removeChild = useDeleteFamilyChild(child.id);
  const cancelLink = useCancelChildLink(child.id);
  const badge = BADGES[child.status];

  async function onCreateAccount() {
    try {
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
      router.replace('/family');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not remove this child.';
      toast(message, 'error');
    }
  }

  return (
    <div className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
            badge.bg,
            badge.text,
          )}
        >
          {badge.label}
        </span>
        {child.status === 'LINKED' && child.linkedAt && (
          <span className="text-xs text-gray-500">
            Connected since {formatDate(child.linkedAt)}
          </span>
        )}
      </div>

      <EditChildForm child={child} />

      {child.status === 'PENDING_LINK' && child.inviteCode && (
        <div className="mt-4 rounded-md border border-blue-100 bg-blue-50/40 p-3 text-xs text-blue-900">
          Invitation sent to <span className="font-medium">{child.inviteEmail}</span>. They can
          enter the code{' '}
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] tracking-wider">
            {child.inviteCode}
          </code>{' '}
          on their own CampusOS account to connect.
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {child.status === 'PLACEHOLDER' && (
          <>
            <SecondaryButton onClick={onCreateAccount} disabled={createAccount.isPending}>
              {createAccount.isPending ? 'Creating…' : 'Create Account'}
            </SecondaryButton>
            <SecondaryButton onClick={onSendLink}>Send Link Invitation</SecondaryButton>
            <DangerButton onClick={onRemove} disabled={removeChild.isPending}>
              {removeChild.isPending ? 'Removing…' : 'Remove'}
            </DangerButton>
          </>
        )}
        {child.status === 'PENDING_LINK' && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

// ─── Enrolment section ────────────────────────────────────

/**
 * Shows the child's school enrolment state. For now every family child
 * is "Not enrolled" — once Step 7 of the persona-registration design
 * (enrolment-from-family) ships, this section reads sis_students via a
 * cross-schema lookup and surfaces school + grade + class. Locked
 * behind LINKED because enrolment requires a real iam_person.
 */
function EnrolmentSection({ child }: { child: FamilyChildDto }) {
  return (
    <section className="mt-6 rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">School enrolment</h2>
      {child.status !== 'LINKED' ? (
        <p className="mt-2 text-xs text-gray-600">
          Enrolment becomes available once {child.firstName} has a CampusOS account. Create one
          above or send a link invitation to connect an existing account.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-gray-700">
            {child.firstName} is not enrolled at any school yet.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/find-schools"
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Find a school
            </Link>
            <Link
              href="/apply"
              className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
            >
              Start enrolment application
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

// ─── Send-link modal (shared shape with /family) ──────────

function SendLinkModal({
  child,
  open,
  onClose,
}: {
  child: FamilyChildDto;
  open: boolean;
  onClose: () => void;
}) {
  const send = useSendChildLink(child.id);
  const { toast } = useToast();
  const [email, setEmail] = useState('');

  const handleClose = () => {
    setEmail('');
    onClose();
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
            form="send-link-detail-form"
            disabled={send.isPending}
            className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
          >
            {send.isPending && <LoadingSpinner size="sm" />}
            <span>{send.isPending ? 'Sending…' : 'Send Invitation'}</span>
          </button>
        </>
      }
    >
      <form id="send-link-detail-form" onSubmit={onSubmit} className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          We&rsquo;ll send a code to this email. The recipient enters it in their CampusOS account
          to connect.
        </p>
        <div>
          <label htmlFor="link-email-detail" className="block text-xs font-medium text-gray-700">
            Email
          </label>
          <input
            id="link-email-detail"
            name="link-email-detail"
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

// ─── Parent-edit form for the child ──────────────────────

/**
 * Inline edit form for parents to maintain their child's info. The
 * server's PATCH /family/children/:id endpoint accepts an extended
 * payload — for LINKED children it writes the identity fields to
 * iam_person and mirrors name/DOB onto platform_family_children;
 * for PLACEHOLDER it writes only the family_children row (no
 * iam_person exists yet).
 *
 * Field visibility:
 *   PLACEHOLDER  → first / last / DOB / gender
 *   PENDING_LINK → same as PLACEHOLDER (still no iam_person)
 *   LINKED       → all of the above PLUS middle / preferred / phone /
 *                  notes (iam_person fields)
 */
function EditChildForm({ child }: { child: FamilyChildDto }) {
  const { toast } = useToast();
  const update = useUpdateFamilyChild(child.id);
  const isLinked = child.status === 'LINKED';

  const [form, setForm] = useState({
    firstName: child.firstName ?? '',
    middleName: '',
    lastName: child.lastName ?? '',
    preferredName: '',
    dateOfBirth: child.dateOfBirth ?? '',
    gender: child.gender ?? '',
    primaryPhone: '',
    notes: '',
  });
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string }>({});

  // Re-sync when the underlying child row changes (after Save).
  useEffect(() => {
    setForm({
      firstName: child.firstName ?? '',
      middleName: '',
      lastName: child.lastName ?? '',
      preferredName: '',
      dateOfBirth: child.dateOfBirth ?? '',
      gender: child.gender ?? '',
      primaryPhone: '',
      notes: '',
    });
  }, [child.id, child.firstName, child.lastName, child.dateOfBirth, child.gender]);

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key as keyof typeof errors]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v: typeof errors = {};
    if (!form.firstName.trim()) v.firstName = 'First name is required';
    if (!form.lastName.trim()) v.lastName = 'Last name is required';
    if (Object.keys(v).length > 0) {
      setErrors(v);
      return;
    }
    try {
      await update.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        dateOfBirth: form.dateOfBirth || undefined,
        gender: form.gender || undefined,
        ...(isLinked
          ? {
              middleName: form.middleName.trim() || null,
              preferredName: form.preferredName.trim() || null,
              primaryPhone: form.primaryPhone.trim() || null,
              notes: form.notes.trim() || null,
            }
          : {}),
      });
      toast('Saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save. Try again.', 'error');
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <EditField
          id="firstName"
          label="First name"
          value={form.firstName}
          onChange={(v) => setField('firstName', v)}
          error={errors.firstName}
          required
        />
        {isLinked && (
          <EditField
            id="middleName"
            label="Middle name"
            value={form.middleName}
            onChange={(v) => setField('middleName', v)}
          />
        )}
        <EditField
          id="lastName"
          label="Last name"
          value={form.lastName}
          onChange={(v) => setField('lastName', v)}
          error={errors.lastName}
          required
        />
        {isLinked && (
          <EditField
            id="preferredName"
            label="Preferred name"
            value={form.preferredName}
            onChange={(v) => setField('preferredName', v)}
            hint="Used throughout CampusOS instead of their first name."
          />
        )}
        <EditField
          id="dateOfBirth"
          label="Date of birth"
          type="date"
          value={form.dateOfBirth}
          onChange={(v) => setField('dateOfBirth', v)}
        />
        <div>
          <label htmlFor="gender" className="block text-xs font-medium text-gray-700">
            Gender
          </label>
          <select
            id="gender"
            value={form.gender}
            onChange={(e) => setField('gender', e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          >
            <option value="">Prefer not to say</option>
            <option value="F">Female</option>
            <option value="M">Male</option>
            <option value="X">Non-binary</option>
            <option value="O">Other</option>
          </select>
        </div>
        {isLinked && (
          <EditField
            id="primaryPhone"
            label="Phone"
            type="tel"
            value={form.primaryPhone}
            onChange={(v) => setField('primaryPhone', v)}
          />
        )}
      </div>

      {isLinked && (
        <div className="mt-4">
          <label htmlFor="notes" className="block text-xs font-medium text-gray-700">
            Notes
          </label>
          <textarea
            id="notes"
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
            rows={3}
            placeholder="Allergies, accommodations, things teachers should know…"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          />
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={update.isPending}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
        >
          {update.isPending && <LoadingSpinner size="sm" />}
          <span>{update.isPending ? 'Saving…' : 'Save Changes'}</span>
        </button>
      </div>
    </form>
  );
}

function EditField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  required,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
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
          'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
          (error ? 'border-red-300' : 'border-gray-300')
        }
      />
      {error ? (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

// ─── Small primitives + helpers ───────────────────────────

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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

