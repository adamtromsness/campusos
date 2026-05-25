'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  useAddChildEmergencyContact,
  useCancelChildLink,
  useChildDietary,
  useChildEmergencyContacts,
  useChildMedical,
  useCreateChildAccount,
  useDeleteChildEmergencyContact,
  useDeleteFamilyChild,
  useFamilyChildren,
  useSendChildLink,
  useUpdateChildDietary,
  useUpdateChildMedical,
  useUpdateFamilyChild,
  type ChildAllergyEntry,
  type ChildConditionEntry,
  type ChildMedicationEntry,
  type DietaryType,
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

      {child.status === 'LINKED' && (
        <>
          <MedicalSection childId={child.id} />
          <EmergencyContactsSection childId={child.id} />
          <DietarySection childId={child.id} />
        </>
      )}

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
    middleName: child.middleName ?? '',
    lastName: child.lastName ?? '',
    preferredName: child.preferredName ?? '',
    dateOfBirth: child.dateOfBirth ?? '',
    gender: child.gender ?? '',
    primaryPhone: child.primaryPhone ?? '',
    notes: child.notes ?? '',
  });
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string }>({});

  // Re-sync when the underlying child row changes (after Save). All
  // identity fields come from the GET response — for LINKED children
  // the API joins iam_person and surfaces middle/preferred/phone/
  // notes too, so the form round-trips every input the user touched.
  useEffect(() => {
    setForm({
      firstName: child.firstName ?? '',
      middleName: child.middleName ?? '',
      lastName: child.lastName ?? '',
      preferredName: child.preferredName ?? '',
      dateOfBirth: child.dateOfBirth ?? '',
      gender: child.gender ?? '',
      primaryPhone: child.primaryPhone ?? '',
      notes: child.notes ?? '',
    });
  }, [
    child.id,
    child.firstName,
    child.middleName,
    child.lastName,
    child.preferredName,
    child.dateOfBirth,
    child.gender,
    child.primaryPhone,
    child.notes,
  ]);

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

// ─── Section card primitives ─────────────────────────────

/**
 * Section card wrapper used by Medical / Emergency / Dietary. The
 * "Parent/Guardian only" lock badge is rendered when the caller is
 * a parent viewing — these endpoints already 404 / 403 cross-family
 * callers server-side, so the badge is a visual reminder rather
 * than an access gate.
 */
function ProfileSection({
  title,
  description,
  parentOnly,
  children,
}: {
  title: string;
  description?: string;
  parentOnly?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-gray-600">{description}</p>}
        </div>
        {parentOnly && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
            🔒 Parent/Guardian only
          </span>
        )}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

// ─── Medical & Health ────────────────────────────────────

const ALLERGY_SEVERITIES: Array<{ value: string; label: string }> = [
  { value: 'MILD', label: 'Mild' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'SEVERE', label: 'Severe' },
  { value: 'LIFE_THREATENING', label: 'Life-threatening' },
];

const ALLERGY_TYPES: Array<{ value: string; label: string }> = [
  { value: 'FOOD', label: 'Food' },
  { value: 'ENVIRONMENTAL', label: 'Environmental' },
  { value: 'MEDICATION', label: 'Medication' },
  { value: 'OTHER', label: 'Other' },
];

function MedicalSection({ childId }: { childId: string }) {
  const { data, isLoading } = useChildMedical(childId);
  const update = useUpdateChildMedical(childId);
  const { toast } = useToast();
  const [doctor, setDoctor] = useState({
    name: '',
    phone: '',
    clinic: '',
    insuranceProvider: '',
    insurancePolicy: '',
    insuranceGroup: '',
    bloodType: '',
    medicalNotes: '',
  });
  const [doctorDirty, setDoctorDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDoctor({
      name: data.doctorName ?? '',
      phone: data.doctorPhone ?? '',
      clinic: data.doctorClinic ?? '',
      insuranceProvider: data.insuranceProvider ?? '',
      insurancePolicy: data.insurancePolicy ?? '',
      insuranceGroup: data.insuranceGroup ?? '',
      bloodType: data.bloodType ?? '',
      medicalNotes: data.medicalNotes ?? '',
    });
    setDoctorDirty(false);
  }, [data]);

  function patchDoctor<K extends keyof typeof doctor>(key: K, value: (typeof doctor)[K]) {
    setDoctor((d) => ({ ...d, [key]: value }));
    setDoctorDirty(true);
  }

  async function saveDoctor() {
    try {
      await update.mutateAsync({
        doctorName: doctor.name.trim() || null,
        doctorPhone: doctor.phone.trim() || null,
        doctorClinic: doctor.clinic.trim() || null,
        insuranceProvider: doctor.insuranceProvider.trim() || null,
        insurancePolicy: doctor.insurancePolicy.trim() || null,
        insuranceGroup: doctor.insuranceGroup.trim() || null,
        bloodType: doctor.bloodType.trim() || null,
        medicalNotes: doctor.medicalNotes.trim() || null,
      });
      toast('Medical details saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  async function commitList<K extends 'allergies' | 'medications' | 'conditions'>(
    key: K,
    next: NonNullable<Parameters<typeof update.mutateAsync>[0][K]>,
    successMessage: string,
  ) {
    try {
      await update.mutateAsync({ [key]: next } as Parameters<typeof update.mutateAsync>[0]);
      toast(successMessage, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  if (isLoading || !data) {
    return (
      <ProfileSection title="Medical & Health" parentOnly>
        <p className="text-sm text-gray-500">Loading…</p>
      </ProfileSection>
    );
  }

  return (
    <ProfileSection title="Medical & Health" parentOnly>
      <AllergiesCard
        items={data.allergies}
        onChange={(next) => void commitList('allergies', next, 'Allergies updated')}
        busy={update.isPending}
      />
      <MedicationsCard
        items={data.medications}
        onChange={(next) => void commitList('medications', next, 'Medications updated')}
        busy={update.isPending}
      />
      <ConditionsCard
        items={data.conditions}
        onChange={(next) => void commitList('conditions', next, 'Conditions updated')}
        busy={update.isPending}
      />

      <div className="mt-4 rounded-md border border-gray-200 bg-gray-50/40 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Doctor &amp; Insurance
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SectionField label="Doctor name" value={doctor.name} onChange={(v) => patchDoctor('name', v)} />
          <SectionField label="Doctor phone" value={doctor.phone} onChange={(v) => patchDoctor('phone', v)} />
          <SectionField label="Clinic" value={doctor.clinic} onChange={(v) => patchDoctor('clinic', v)} className="sm:col-span-2" />
          <SectionField label="Insurance provider" value={doctor.insuranceProvider} onChange={(v) => patchDoctor('insuranceProvider', v)} />
          <SectionField label="Policy number" value={doctor.insurancePolicy} onChange={(v) => patchDoctor('insurancePolicy', v)} />
          <SectionField label="Group number" value={doctor.insuranceGroup} onChange={(v) => patchDoctor('insuranceGroup', v)} />
          <SectionField label="Blood type" value={doctor.bloodType} onChange={(v) => patchDoctor('bloodType', v)} />
        </div>
        <div className="mt-3">
          <label className="block text-xs font-medium text-gray-700">Medical notes</label>
          <textarea
            value={doctor.medicalNotes}
            onChange={(e) => patchDoctor('medicalNotes', e.target.value)}
            rows={3}
            placeholder="Anything teachers, nurses, or coaches should know…"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void saveDoctor()}
            disabled={!doctorDirty || update.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
          >
            {update.isPending && <LoadingSpinner size="sm" />}
            <span>{update.isPending ? 'Saving…' : 'Save'}</span>
          </button>
        </div>
      </div>
    </ProfileSection>
  );
}

function AllergiesCard({
  items,
  onChange,
  busy,
}: {
  items: ChildAllergyEntry[];
  onChange: (next: ChildAllergyEntry[]) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<ChildAllergyEntry>({ name: '', severity: 'MILD', type: 'FOOD' });
  const [showAdd, setShowAdd] = useState(false);
  function add() {
    if (!draft.name.trim()) return;
    onChange([...items, { ...draft, name: draft.name.trim() }]);
    setDraft({ name: '', severity: 'MILD', type: 'FOOD' });
    setShowAdd(false);
  }
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Allergies</h3>
        {!showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="text-sm font-medium text-campus-700 hover:text-campus-600"
          >
            + Add allergy
          </button>
        )}
      </div>
      {items.length === 0 && !showAdd ? (
        <p className="mt-2 text-xs text-gray-500">No allergies recorded.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((a, i) => (
            <li
              key={a.name + i}
              className="flex items-center justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium text-gray-900">{a.name}</span>
                {a.severity && (
                  <span className="ml-2 text-xs text-gray-500">
                    {ALLERGY_SEVERITIES.find((s) => s.value === a.severity)?.label}
                  </span>
                )}
                {a.type && <span className="ml-2 text-xs text-gray-400">({a.type.toLowerCase()})</span>}
              </span>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                disabled={busy}
                className="text-xs text-red-700 hover:text-red-800 disabled:opacity-60"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {showAdd && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Allergy (e.g. Peanuts)"
            className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 sm:col-span-2"
          />
          <select
            value={draft.severity ?? 'MILD'}
            onChange={(e) => setDraft({ ...draft, severity: e.target.value as ChildAllergyEntry['severity'] })}
            className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          >
            {ALLERGY_SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={draft.type ?? 'FOOD'}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as ChildAllergyEntry['type'] })}
            className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          >
            {ALLERGY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={() => setShowAdd(false)} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
            <button type="button" onClick={add} disabled={busy} className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60">
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MedicationsCard({
  items,
  onChange,
  busy,
}: {
  items: ChildMedicationEntry[];
  onChange: (next: ChildMedicationEntry[]) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<ChildMedicationEntry>({ name: '', dosage: '', frequency: '', prescriber: '' });
  const [showAdd, setShowAdd] = useState(false);
  function add() {
    if (!draft.name.trim()) return;
    onChange([...items, { ...draft, name: draft.name.trim() }]);
    setDraft({ name: '', dosage: '', frequency: '', prescriber: '' });
    setShowAdd(false);
  }
  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Medications</h3>
        {!showAdd && (
          <button type="button" onClick={() => setShowAdd(true)} className="text-sm font-medium text-campus-700 hover:text-campus-600">
            + Add medication
          </button>
        )}
      </div>
      {items.length === 0 && !showAdd ? (
        <p className="mt-2 text-xs text-gray-500">No medications recorded.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((m, i) => (
            <li key={m.name + i} className="flex items-start justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm">
              <div>
                <p>
                  <span className="font-medium text-gray-900">{m.name}</span>
                  {m.dosage && <span className="ml-2 text-xs text-gray-600">— {m.dosage}</span>}
                  {m.frequency && <span className="ml-2 text-xs text-gray-500">· {m.frequency}</span>}
                </p>
                {m.prescriber && <p className="text-xs text-gray-500">Prescribed by {m.prescriber}</p>}
              </div>
              <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={busy} className="text-xs text-red-700 hover:text-red-800 disabled:opacity-60">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {showAdd && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Medication name" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 sm:col-span-2" />
          <input type="text" value={draft.dosage ?? ''} onChange={(e) => setDraft({ ...draft, dosage: e.target.value })} placeholder="Dosage (e.g. 2 puffs)" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500" />
          <input type="text" value={draft.frequency ?? ''} onChange={(e) => setDraft({ ...draft, frequency: e.target.value })} placeholder="Frequency (e.g. as needed)" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500" />
          <input type="text" value={draft.prescriber ?? ''} onChange={(e) => setDraft({ ...draft, prescriber: e.target.value })} placeholder="Prescribed by" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 sm:col-span-2" />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={() => setShowAdd(false)} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
            <button type="button" onClick={add} disabled={busy} className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60">
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionsCard({
  items,
  onChange,
  busy,
}: {
  items: ChildConditionEntry[];
  onChange: (next: ChildConditionEntry[]) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<ChildConditionEntry>({ name: '', diagnosedDate: '', notes: '' });
  const [showAdd, setShowAdd] = useState(false);
  function add() {
    if (!draft.name.trim()) return;
    onChange([...items, { ...draft, name: draft.name.trim() }]);
    setDraft({ name: '', diagnosedDate: '', notes: '' });
    setShowAdd(false);
  }
  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Medical conditions</h3>
        {!showAdd && (
          <button type="button" onClick={() => setShowAdd(true)} className="text-sm font-medium text-campus-700 hover:text-campus-600">
            + Add condition
          </button>
        )}
      </div>
      {items.length === 0 && !showAdd ? (
        <p className="mt-2 text-xs text-gray-500">No conditions recorded.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((c, i) => (
            <li key={c.name + i} className="flex items-start justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm">
              <div>
                <p>
                  <span className="font-medium text-gray-900">{c.name}</span>
                  {c.diagnosedDate && <span className="ml-2 text-xs text-gray-500">Diagnosed {c.diagnosedDate}</span>}
                </p>
                {c.notes && <p className="text-xs text-gray-500">{c.notes}</p>}
              </div>
              <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={busy} className="text-xs text-red-700 hover:text-red-800 disabled:opacity-60">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {showAdd && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Condition (e.g. Asthma)" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 sm:col-span-2" />
          <input type="text" value={draft.diagnosedDate ?? ''} onChange={(e) => setDraft({ ...draft, diagnosedDate: e.target.value })} placeholder="Year diagnosed (optional)" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500" />
          <input type="text" value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Notes" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500" />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={() => setShowAdd(false)} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
            <button type="button" onClick={add} disabled={busy} className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60">
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Emergency Contacts ──────────────────────────────────

function EmergencyContactsSection({ childId }: { childId: string }) {
  const { data, isLoading } = useChildEmergencyContacts(childId);
  const add = useAddChildEmergencyContact(childId);
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    relationship: '',
    phonePrimary: '',
    phoneAlternate: '',
    email: '',
    authorizedPickup: false,
  });

  async function onAdd() {
    if (!draft.name.trim() || !draft.relationship.trim() || !draft.phonePrimary.trim()) {
      toast('Name, relationship, and primary phone are required.', 'error');
      return;
    }
    try {
      await add.mutateAsync({
        name: draft.name.trim(),
        relationship: draft.relationship.trim(),
        phonePrimary: draft.phonePrimary.trim(),
        phoneAlternate: draft.phoneAlternate.trim() || undefined,
        email: draft.email.trim() || undefined,
        authorizedPickup: draft.authorizedPickup,
      });
      toast('Emergency contact added', 'success');
      setShowAdd(false);
      setDraft({ name: '', relationship: '', phonePrimary: '', phoneAlternate: '', email: '', authorizedPickup: false });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the contact.', 'error');
    }
  }

  if (isLoading) {
    return (
      <ProfileSection title="Emergency Contacts" parentOnly>
        <p className="text-sm text-gray-500">Loading…</p>
      </ProfileSection>
    );
  }
  const contacts = data ?? [];

  return (
    <ProfileSection title="Emergency Contacts" parentOnly>
      {contacts.length === 0 && !showAdd ? (
        <p className="text-sm text-gray-500">No emergency contacts on file.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {contacts.map((c, i) => (
            <EmergencyContactRow key={c.id} childId={childId} contact={c} index={i + 1} />
          ))}
        </ul>
      )}
      {showAdd ? (
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <SectionField label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} required />
            <SectionField label="Relationship" value={draft.relationship} onChange={(v) => setDraft({ ...draft, relationship: v })} placeholder="Spouse, Grandparent…" required />
            <SectionField label="Primary phone" value={draft.phonePrimary} onChange={(v) => setDraft({ ...draft, phonePrimary: v })} required />
            <SectionField label="Alternate phone" value={draft.phoneAlternate} onChange={(v) => setDraft({ ...draft, phoneAlternate: v })} />
            <SectionField label="Email" value={draft.email} onChange={(v) => setDraft({ ...draft, email: v })} className="sm:col-span-2" />
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={draft.authorizedPickup}
                onChange={(e) => setDraft({ ...draft, authorizedPickup: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500"
              />
              Authorized for pickup
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setShowAdd(false)} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
            <button type="button" onClick={() => void onAdd()} disabled={add.isPending} className="inline-flex items-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60">
              {add.isPending && <LoadingSpinner size="sm" />}
              <span>{add.isPending ? 'Adding…' : 'Add Contact'}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => setShowAdd(true)} className="text-sm font-medium text-campus-700 hover:text-campus-600">
            + Add contact
          </button>
        </div>
      )}
    </ProfileSection>
  );
}

function EmergencyContactRow({
  childId,
  contact,
  index,
}: {
  childId: string;
  contact: import('@/hooks/use-family-children').ChildEmergencyContactDto;
  index: number;
}) {
  const remove = useDeleteChildEmergencyContact(childId, contact.id);
  const { toast } = useToast();
  async function onRemove() {
    if (typeof window !== 'undefined' && !window.confirm('Remove ' + contact.name + '?')) return;
    try {
      await remove.mutateAsync();
      toast('Contact removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove.', 'error');
    }
  }
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-gray-200 bg-white p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900">
          <span className="text-xs text-gray-400">{index}.</span> {contact.name}
          <span className="ml-2 text-xs font-normal text-gray-500">{contact.relationship}</span>
        </p>
        <p className="mt-0.5 text-xs text-gray-600">
          {contact.phonePrimary}
          {contact.phoneAlternate && <span className="text-gray-500"> · {contact.phoneAlternate}</span>}
        </p>
        {contact.email && <p className="text-xs text-gray-500">{contact.email}</p>}
        <p className="mt-0.5 text-xs">
          {contact.authorizedPickup ? (
            <span className="text-emerald-700">✓ Authorized for pickup</span>
          ) : (
            <span className="text-gray-500">Not authorized for pickup</span>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void onRemove()}
        disabled={remove.isPending}
        className="text-xs text-red-700 hover:text-red-800 disabled:opacity-60"
      >
        {remove.isPending ? 'Removing…' : 'Remove'}
      </button>
    </li>
  );
}

// ─── Dietary ─────────────────────────────────────────────

const DIETARY_TYPES: Array<{ value: DietaryType; label: string }> = [
  { value: 'NONE', label: 'None' },
  { value: 'VEGETARIAN', label: 'Vegetarian' },
  { value: 'VEGAN', label: 'Vegan' },
  { value: 'HALAL', label: 'Halal' },
  { value: 'KOSHER', label: 'Kosher' },
  { value: 'GLUTEN_FREE', label: 'Gluten-free' },
  { value: 'DAIRY_FREE', label: 'Dairy-free' },
  { value: 'OTHER', label: 'Other' },
];

function DietarySection({ childId }: { childId: string }) {
  const { data, isLoading } = useChildDietary(childId);
  const update = useUpdateChildDietary(childId);
  const { toast } = useToast();
  const [form, setForm] = useState({
    dietaryType: 'NONE' as DietaryType,
    additionalRestrictions: '',
    mealPreference: '',
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm({
      dietaryType: data.dietaryType,
      additionalRestrictions: data.additionalRestrictions ?? '',
      mealPreference: data.mealPreference ?? '',
    });
    setDirty(false);
  }, [data]);

  async function save() {
    try {
      await update.mutateAsync({
        dietaryType: form.dietaryType,
        additionalRestrictions: form.additionalRestrictions.trim() || null,
        mealPreference: form.mealPreference.trim() || null,
      });
      toast('Dietary info saved', 'success');
      setDirty(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  if (isLoading || !data) {
    return (
      <ProfileSection title="Dietary &amp; Food Restrictions" parentOnly>
        <p className="text-sm text-gray-500">Loading…</p>
      </ProfileSection>
    );
  }

  return (
    <ProfileSection
      title="Dietary & Food Restrictions"
      description="Food allergies in the Medical section are tracked separately. This section covers diet style + school-meal preferences."
      parentOnly
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-gray-700">Dietary type</label>
          <select
            value={form.dietaryType}
            onChange={(e) => {
              setForm((f) => ({ ...f, dietaryType: e.target.value as DietaryType }));
              setDirty(true);
            }}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          >
            {DIETARY_TYPES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <SectionField
          label="Meal preference (optional)"
          value={form.mealPreference}
          onChange={(v) => {
            setForm((f) => ({ ...f, mealPreference: v }));
            setDirty(true);
          }}
        />
      </div>
      <div className="mt-3">
        <label className="block text-xs font-medium text-gray-700">Additional restrictions</label>
        <textarea
          value={form.additionalRestrictions}
          onChange={(e) => {
            setForm((f) => ({ ...f, additionalRestrictions: e.target.value }));
            setDirty(true);
          }}
          rows={3}
          placeholder="Anything school food service should know…"
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
        />
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || update.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
        >
          {update.isPending && <LoadingSpinner size="sm" />}
          <span>{update.isPending ? 'Saving…' : 'Save'}</span>
        </button>
      </div>
    </ProfileSection>
  );
}

function SectionField({
  label,
  value,
  onChange,
  placeholder,
  required,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
      />
    </div>
  );
}

