'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { GENDERS, GENDER_LABELS, normalizeGender } from '@campusos/shared';
import {
  useAddChildEmergencyContact,
  useCancelChildLink,
  useChildDietary,
  useChildEmergencyContacts,
  useChildMedical,
  useCreateChildAccount,
  useDeleteChildEmergencyContact,
  useDeleteFamilyChild,
  useAddChildEmail,
  useAddChildPhone,
  useChildEmails,
  useChildPhones,
  useDeleteChildEmail,
  useDeleteChildPhone,
  useFamilyChildren,
  useFamilyEmergencyContacts,
  useFamilySettings,
  useFamilyView,
  useUpdateChildEmail,
  useUpdateChildPhone,
  useSendChildLink,
  useUpdateChildDietary,
  useUpdateChildMedical,
  useUpdateFamilyChild,
  type ChildAllergyEntry,
  type ChildConditionEntry,
  type ChildMedicationEntry,
  type DietaryType,
  type EmergencyContactSource,
  type FamilyChildDto,
  type FamilyChildStatus,
  type MedicalSource,
} from '@/hooks/use-family-children';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useBeforeUnloadOnDirty, useFormDirty } from '@/hooks/use-form-dirty';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { formatPhone } from '@/lib/phone-format';
import { FamilyCustomToggle } from '@/components/ui/FamilyCustomToggle';
import { CountryField, formatAddressOneLine } from '@/components/ui/CountryField';
import { StickySaveBar } from '@/components/ui/StickySaveBar';
import { FamilyStructureSection } from '@/components/family/FamilyStructureSection';
import type {
  PersonEmailDto,
  PersonEmailType,
  PersonPhoneDto,
  PersonPhoneType,
} from '@/lib/types';

/**
 * /family/children/[id] — tabbed detail view for a family child.
 *
 * The page is wrapped by a sticky hero (preferred name + full name +
 * status badges + back link) and a six-tab bar:
 *
 *   Account  — names, DOB, gender, account-type info box.
 *   Contact  — phone, notes, address (custom for v1; family-inherit
 *              wire-up lands with the family-settings commit).
 *   Medical & Health    — allergies, medications, conditions,
 *                         doctor + insurance, blood type, notes.
 *   Emergency Contacts  — list + add + remove.
 *   Dietary             — diet style + restrictions + meal pref.
 *   About               — stub for the child's bio / interests.
 *
 * Tab state mirrors `?tab=<key>` in the URL so refresh + browser-back
 * preserve the active section without forcing a Next-side navigation
 * (replaceState only — keeps the React Query cache warm).
 *
 * Source of truth for the child row stays GET /family/children — small
 * list, filtered client-side by id.
 */
export default function FamilyChildDetailPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { data, isLoading, error } = useFamilyChildren();
  const [linkInviteOpen, setLinkInviteOpen] = useState(false);

  if (isLoading) return <PageLoader label="Loading…" />;

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <p className="text-sm text-red-600">Could not load your family. Please try again.</p>
      </div>
    );
  }

  const child = (data ?? []).find((c) => c.id === id);
  if (!child) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
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
      <Hero child={child} />
      <Tabs child={child} onSendLink={() => setLinkInviteOpen(true)} />
      <SendLinkModal
        child={child}
        open={linkInviteOpen}
        onClose={() => setLinkInviteOpen(false)}
      />
    </div>
  );
}

// ─── Hero ───────────────────────────────────────────────────

const STATUS_BADGES: Record<FamilyChildStatus, { bg: string; text: string; label: string }> = {
  PLACEHOLDER: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Account needed' },
  PENDING_LINK: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Link pending' },
  LINKED: { bg: 'bg-green-100', text: 'text-green-800', label: 'Connected' },
};

function Hero({ child }: { child: FamilyChildDto }) {
  const preferred = child.preferredName?.trim();
  const heroName = preferred ? preferred : child.firstName;
  const fullName = [child.firstName, child.middleName, child.lastName].filter(Boolean).join(' ');
  const showFull = fullName && fullName.trim() !== heroName.trim();
  const status = STATUS_BADGES[child.status];
  const access =
    child.accessLevel === 'MANAGED'
      ? { bg: 'bg-emerald-100', text: 'text-emerald-800', label: '🛡️ Managed by you' }
      : child.accessLevel === 'INDEPENDENT'
        ? { bg: 'bg-sky-100', text: 'text-sky-800', label: '🔗 Independent' }
        : null;

  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">{heroName}</h1>
          {showFull && <p className="mt-1 text-sm text-gray-500">{fullName}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PillBadge style={status} />
          {access && <PillBadge style={access} />}
        </div>
      </div>
      <Link
        href="/family"
        className="mt-3 inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        ← My Family
      </Link>
    </header>
  );
}

function PillBadge({ style }: { style: { bg: string; text: string; label: string } }) {
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

// ─── Tab bar + routing ──────────────────────────────────────

type TabKey = 'account' | 'contact' | 'medical' | 'dietary' | 'about';

const TABS: Array<{ key: TabKey; label: string; needsLinked: boolean }> = [
  { key: 'account', label: 'Account', needsLinked: false },
  // Contact owns Emergency Contacts now — same physical context (how
  // we reach this child) and the old Emergency tab was thin.
  { key: 'contact', label: 'Contact', needsLinked: false },
  { key: 'medical', label: 'Medical & Health', needsLinked: true },
  { key: 'dietary', label: 'Dietary', needsLinked: true },
  { key: 'about', label: 'About', needsLinked: false },
];

function isTabKey(s: string | null): s is TabKey {
  return s !== null && TABS.some((t) => t.key === s);
}

function Tabs({ child, onSendLink }: { child: FamilyChildDto; onSendLink: () => void }) {
  const searchParams = useSearchParams();
  const initial = searchParams?.get('tab');
  const [active, setActive] = useState<TabKey>(isTabKey(initial ?? null) ? (initial as TabKey) : 'account');

  function select(key: TabKey) {
    setActive(key);
    if (typeof window !== 'undefined') {
      // replaceState — keeps the React Query cache warm and avoids a
      // Next-side push that would refetch + re-render the whole tree.
      const url = new URL(window.location.href);
      url.searchParams.set('tab', key);
      window.history.replaceState({}, '', url.toString());
    }
  }

  return (
    <>
      <nav className="border-b border-gray-200" aria-label="Profile tabs">
        <ul className="-mb-px flex flex-wrap gap-1">
          {TABS.map((t) => {
            const disabled = t.needsLinked && child.status !== 'LINKED';
            const isActive = active === t.key;
            return (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => !disabled && select(t.key)}
                  disabled={disabled}
                  className={cn(
                    'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-campus-700 text-campus-700'
                      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
                    disabled && 'cursor-not-allowed opacity-50 hover:border-transparent hover:text-gray-500',
                  )}
                  title={disabled ? 'Available once this child has an account.' : undefined}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {t.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* pb-24 reserves clearance so the viewport-fixed StickySaveBar the
          Account tab renders never covers the tab's last field. */}
      <div className="mt-6 pb-24">
        {active === 'account' && <AccountTab child={child} onSendLink={onSendLink} />}
        {active === 'contact' && <ContactTab child={child} />}
        {active === 'medical' && <MedicalTab child={child} />}
        {active === 'dietary' && <DietaryTab child={child} />}
        {active === 'about' && <AboutTab child={child} />}
      </div>
    </>
  );
}

// ─── Account tab ────────────────────────────────────────────

/**
 * Identity fields + DOB + gender + an account-type info box. Editability is
 * driven by the server's `canEdit` (the age + consent model) — NOT the
 * "Independent" flag, which is now descriptive only. A guardian edits an
 * under-18 child unconditionally (even Independent ones); at 18+ they edit
 * only while the now-adult has not revoked access (then the server returns 403
 * and canEdit is false, so we render read-only).
 *
 * PLACEHOLDER/PENDING_LINK children also surface the lifecycle action
 * buttons (Create Account / Send Link / Cancel / Remove) at the bottom
 * of this tab — those used to live on the family card; now that the
 * family card just says "View Profile", the actions follow the user
 * into the profile.
 */
function AccountTab({ child, onSendLink }: { child: FamilyChildDto; onSendLink: () => void }) {
  const readOnly = child.status === 'LINKED' && !child.canEdit;
  return (
    <div className="flex flex-col gap-5">
      <AccessLevelInfo child={child} />
      {readOnly ? <AccountReadOnly child={child} /> : <AccountEditForm child={child} />}
      {child.status !== 'LINKED' && <LifecycleActions child={child} onSendLink={onSendLink} />}
      {/* Family structure needs a canonical iam_person — LINKED only.
          Edit permission (parent/guardian-only) is decided server-side
          and returned as canEdit on the relationships response. */}
      {child.status === 'LINKED' && child.personId && (
        <FamilyStructureSection personId={child.personId} variant="child" />
      )}
      <EnrolmentBlock child={child} />
    </div>
  );
}

function AccessLevelInfo({ child }: { child: FamilyChildDto }) {
  if (child.status !== 'LINKED') return null;
  if (child.accessLevel === 'MANAGED') {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-900">
        <p className="font-semibold">You manage this account.</p>
        <p className="mt-0.5">
          You can edit {child.firstName}&rsquo;s identity, medical, emergency, and dietary info.{' '}
          {child.firstName} doesn&rsquo;t log in separately — their CampusOS access is through you.
        </p>
      </div>
    );
  }
  if (child.accessLevel === 'INDEPENDENT') {
    const heroName = child.preferredName?.trim() ? child.preferredName : child.firstName;
    // "Independent" is descriptive only — it means the child has their own
    // login. Whether YOU can edit is driven by canEdit (age + consent): a
    // guardian edits an under-18 unconditionally; at 18+ only until the adult
    // revokes access.
    return (
      <div className="rounded-md border border-sky-200 bg-sky-50/60 p-3 text-xs text-sky-900">
        <p className="font-semibold">{heroName} has their own login.</p>
        <p className="mt-0.5">
          {child.canEdit
            ? `${heroName} signs in themselves, and you can still edit their profile and the medical / emergency / dietary sections.`
            : `${heroName} signs in themselves and has turned off your edit access. You can view their profile but not change it; ask them to restore your access from their account settings.`}
        </p>
      </div>
    );
  }
  return null;
}

function AccountReadOnly({ child }: { child: FamilyChildDto }) {
  return (
    <SectionCard>
      {/* Three name fields on one row so the natural left-to-right
          reading order matches how people write a full name. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <ReadOnlyField label="First name" value={child.firstName} />
        <ReadOnlyField label="Middle name" value={child.middleName} />
        <ReadOnlyField label="Last name" value={child.lastName} />
      </div>
      <div className="mt-4">
        <ReadOnlyField label="Preferred name" value={child.preferredName} />
      </div>
      <div className="mt-4">
        <ReadOnlyField label="Email" value={child.email} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ReadOnlyField
          label="Date of birth"
          value={child.dateOfBirth ? formatDate(child.dateOfBirth) : null}
        />
        <ReadOnlyField label="Gender" value={genderLabel(child.gender)} />
      </div>
      {(child.linkedAt || child.accessLevel === 'INDEPENDENT') && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-700">Account status</p>
          <p className="mt-1 text-sm text-gray-900">
            {child.linkedAt ? 'Connected since ' + formatDate(child.linkedAt) : 'Connected'}
            {child.accessLevel === 'INDEPENDENT' ? ' · Independent account' : ' · Managed by you'}
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function AccountEditForm({ child }: { child: FamilyChildDto }) {
  const { toast } = useToast();
  const update = useUpdateFamilyChild(child.id);
  const isLinked = child.status === 'LINKED';

  const initial = useMemo(
    () => ({
      firstName: child.firstName ?? '',
      middleName: child.middleName ?? '',
      lastName: child.lastName ?? '',
      preferredName: child.preferredName ?? '',
      dateOfBirth: child.dateOfBirth ?? '',
      // Normalise to the canonical option value so the select preselects
      // the right option (the API already normalises on read, but this is
      // defensive against any non-canonical value reaching the form).
      gender: child.gender ? normalizeGender(child.gender) : '',
    }),
    [
      child.firstName,
      child.middleName,
      child.lastName,
      child.preferredName,
      child.dateOfBirth,
      child.gender,
    ],
  );

  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string }>({});
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);

  useEffect(() => {
    setForm(initial);
  }, [child.id, initial]);

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key as keyof typeof errors]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function doSave() {
    if (!isDirty || update.isPending) return;
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
            }
          : {}),
      });
      toast('Saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save. Try again.', 'error');
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void doSave();
  }

  function onDiscard() {
    setForm(initial);
    setErrors({});
  }

  return (
    <SectionCard>
      <form onSubmit={onSubmit} noValidate>
        {/* Row 1: three name fields side-by-side. Reads naturally
            left-to-right (first, middle, last) and frees the second
            row for preferred name, which is conceptually a single
            value per person rather than half of a name pair. */}
        <div className="grid gap-4 sm:grid-cols-3">
          <EditField
            id="firstName"
            label="First name"
            value={form.firstName}
            onChange={(v) => setField('firstName', v)}
            error={errors.firstName}
            required
            dirty={dirtyFields.has('firstName')}
          />
          <EditField
            id="middleName"
            label="Middle name"
            value={form.middleName}
            onChange={(v) => setField('middleName', v)}
            dirty={dirtyFields.has('middleName')}
          />
          <EditField
            id="lastName"
            label="Last name"
            value={form.lastName}
            onChange={(v) => setField('lastName', v)}
            error={errors.lastName}
            required
            dirty={dirtyFields.has('lastName')}
          />
        </div>

        {/* Preferred name gets its own full-width row — it's the
            name that actually surfaces throughout the app, and a
            cramped half-width field undersells that. */}
        {isLinked && (
          <div className="mt-4">
            <EditField
              id="preferredName"
              label="Preferred name"
              value={form.preferredName}
              onChange={(v) => setField('preferredName', v)}
              hint="If left blank, we'll use their first name."
              dirty={dirtyFields.has('preferredName')}
            />
          </div>
        )}

        {/* Email — read-only here even for managed accounts. Email
            changes are an identity-management concern (Keycloak
            credential rotation, MFA re-verification) and don't
            belong on the family profile form. */}
        {isLinked && (
          <div className="mt-4">
            <ReadOnlyField label="Email" value={child.email} />
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <EditField
            id="dateOfBirth"
            label="Date of birth"
            type="date"
            value={form.dateOfBirth}
            onChange={(v) => setField('dateOfBirth', v)}
            dirty={dirtyFields.has('dateOfBirth')}
          />
          <div>
            <label htmlFor="gender" className="block text-xs font-medium text-gray-700">
              Gender
              {dirtyFields.has('gender') && (
                <span
                  aria-label="Modified"
                  title="Modified — save to keep this change"
                  className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
                />
              )}
            </label>
            <select
              id="gender"
              value={form.gender}
              onChange={(e) => setField('gender', e.target.value)}
              className={cn(
                'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500',
                dirtyFields.has('gender')
                  ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
                  : 'border border-gray-300',
              )}
            >
              <option value="" disabled>
                Select…
              </option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {GENDER_LABELS[g]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isLinked && child.linkedAt && (
          <div className="mt-4">
            <p className="text-xs font-medium text-gray-700">Account status</p>
            <p className="mt-1 text-sm text-gray-900">
              Connected since {formatDate(child.linkedAt)} ·{' '}
              {child.accessLevel === 'INDEPENDENT' ? 'Independent account' : 'Managed by you'}
            </p>
          </div>
        )}

        {/* Hidden submit keeps Enter-to-save working; the visible save
            action is the viewport-fixed StickySaveBar below, matching
            the parent /profile Account tab. */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
      <StickySaveBar
        isDirty={isDirty}
        onSave={() => void doSave()}
        onDiscard={onDiscard}
        saving={update.isPending}
      />
    </SectionCard>
  );
}

/**
 * Lifecycle actions for PLACEHOLDER + PENDING_LINK children. These used
 * to live on the family card; with the redesign, the card surfaces
 * "View Profile" as the only entry point, and the actions follow the
 * user into the Account tab.
 */
function LifecycleActions({ child, onSendLink }: { child: FamilyChildDto; onSendLink: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const createAccount = useCreateChildAccount(child.id);
  const removeChild = useDeleteFamilyChild(child.id);
  const cancelLink = useCancelChildLink(child.id);

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
      await createAccount.mutateAsync({});
      toast(child.firstName + ' now has a managed account', 'success');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not create the account. Try again.';
      toast(message, 'error');
    }
  }

  async function onRemove() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Remove ' + child.firstName + ' from your family?')
    ) {
      return;
    }
    try {
      await removeChild.mutateAsync();
      toast(child.firstName + ' removed', 'success');
      router.replace('/family');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not remove this child.';
      toast(message, 'error');
    }
  }

  return (
    <SectionCard
      title={child.status === 'PLACEHOLDER' ? 'Get connected' : 'Invitation in progress'}
      description={
        child.status === 'PLACEHOLDER'
          ? "Choose how " +
            child.firstName +
            ' joins CampusOS. A managed account is best for younger children; older children can accept their own invitation by email.'
          : 'Once accepted, the invitation will link ' +
            child.firstName +
            "'s CampusOS account to your family."
      }
    >
      {child.status === 'PENDING_LINK' && child.inviteCode && (
        <div className="mb-3 rounded-md border border-blue-100 bg-blue-50/40 p-3 text-xs text-blue-900">
          Invitation sent to <span className="font-medium">{child.inviteEmail}</span>. They can
          enter the code{' '}
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] tracking-wider">
            {child.inviteCode}
          </code>{' '}
          on their own CampusOS account to connect.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
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
    </SectionCard>
  );
}

/**
 * School-enrolment block. Lives at the bottom of the Account tab
 * rather than its own tab because for now it's always either "not
 * enrolled" (LINKED but no sis_students row) or "available once
 * connected" (not yet LINKED). When enrolment-from-family lands,
 * the block will read sis_students and surface school + grade.
 */
function EnrolmentBlock({ child }: { child: FamilyChildDto }) {
  return (
    <SectionCard title="School enrolment">
      {child.status !== 'LINKED' ? (
        <p className="text-xs text-gray-600">
          Enrolment becomes available once {child.firstName} has a CampusOS account.
        </p>
      ) : (
        <>
          <p className="text-sm text-gray-700">
            {child.firstName} is not enrolled at any school yet.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
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
    </SectionCard>
  );
}

// ─── Contact tab ────────────────────────────────────────────

/**
 * Phone + notes + address. The "Use family address" inheritance toggle
 * lands with the family-settings commit; for now the tab surfaces the
 * existing iam_person fields (primary phone + notes) and a placeholder
 * card explaining where the address-inherit flow is going.
 */
/**
 * Mirrors the adult /profile Contact tab top-to-bottom:
 *   1. Phone numbers      — multi-row list, primary radio, per-row save
 *   2. Email addresses    — multi-row list, primary radio, per-row save
 *   3. Home address       — FAMILY/CUSTOM toggle, single Save Changes
 *   4. Mailing address    — same Save Changes when "different from home"
 *   5. Guardian contacts  — read-only primary phone + email per guardian
 *   6. Emergency contacts — existing source toggle + family/per-child
 *
 * Non-LINKED children: only the home/mailing address form renders
 * (the multi-row lists require iam_person.id which placeholders don't
 * have yet) plus a short note explaining what's coming when the
 * account is created.
 *
 * Phone/email editability follows the server's `canEdit` (age + consent),
 * not the "Independent" flag — a guardian may edit an under-18 child's
 * contacts even on an Independent account; a revoked 18+ account is read-only.
 */
function ContactTab({ child }: { child: FamilyChildDto }) {
  const isLinked = child.status === 'LINKED';
  const isManaged = child.canEdit;

  return (
    // pb-24 reserves clearance so the viewport-fixed StickySaveBar
    // (rendered from the address form below) never covers the last
    // interactive element of the Emergency Contacts section.
    <div className="flex flex-col gap-5 pb-24">
      {/* Guardians first — when a school opens a child's contact tab,
          the first thing they need is how to reach the parents. */}
      <GuardianContactsPanel />

      {isLinked ? (
        <>
          <ChildPhoneListCard childId={child.id} editable={isManaged} />
          <ChildEmailListCard childId={child.id} editable={isManaged} />
        </>
      ) : (
        <SectionCard title="Phone numbers & emails">
          <p className="text-sm text-gray-600">
            Multi-phone and multi-email lists become available once {child.firstName} has a
            CampusOS account.
          </p>
        </SectionCard>
      )}

      <ChildAddressCards child={child} />

      <EmergencyContactsContactTabSection child={child} />
    </div>
  );
}

// ─── Child phones / emails ─────────────────────────────────

const CHILD_PHONE_TYPES: Array<{ value: PersonPhoneType; label: string }> = [
  { value: 'CELL', label: 'Cell' },
  { value: 'HOME', label: 'Home' },
  { value: 'WORK', label: 'Work' },
  { value: 'OTHER', label: 'Other' },
];

function ChildPhoneListCard({ childId, editable }: { childId: string; editable: boolean }) {
  const { data, isLoading } = useChildPhones(childId);
  const add = useAddChildPhone(childId);
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [draftNumber, setDraftNumber] = useState('');
  const [draftType, setDraftType] = useState<PersonPhoneType>('CELL');

  async function onAdd() {
    if (!draftNumber.trim()) {
      toast('Enter a phone number first.', 'error');
      return;
    }
    try {
      await add.mutateAsync({
        number: draftNumber.trim(),
        type: draftType,
        textsAllowed: draftType === 'CELL',
      });
      setDraftNumber('');
      setDraftType('CELL');
      setAddOpen(false);
      toast('Phone added', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add phone.', 'error');
    }
  }

  const phones = data ?? [];

  return (
    <SectionCard title="Phone numbers">
      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : phones.length === 0 && !addOpen ? (
        <p className="text-sm text-gray-500">No phones on file yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {phones.map((p) => (
            <ChildPhoneRow
              key={p.id}
              childId={childId}
              phone={p}
              canDelete={phones.length > 1}
              editable={editable}
            />
          ))}
        </ul>
      )}

      {editable && (addOpen ? (
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-700">Phone number</label>
              <PhoneInput value={draftNumber} onChange={setDraftNumber} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700">Type</label>
              <select
                value={draftType}
                onChange={(e) => setDraftType(e.target.value as PersonPhoneType)}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
              >
                {CHILD_PHONE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setDraftNumber('');
                setDraftType('CELL');
              }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onAdd()}
              disabled={add.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
            >
              {add.isPending && <LoadingSpinner size="sm" />}
              <span>{add.isPending ? 'Adding…' : 'Add phone'}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="text-sm font-medium text-campus-700 hover:text-campus-600"
          >
            + Add phone
          </button>
        </div>
      ))}
      {!editable && phones.length > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          Read-only — this child manages their own profile.
        </p>
      )}
    </SectionCard>
  );
}

function ChildPhoneRow({
  childId,
  phone,
  canDelete,
  editable,
}: {
  childId: string;
  phone: PersonPhoneDto;
  canDelete: boolean;
  editable: boolean;
}) {
  const update = useUpdateChildPhone(childId, phone.id);
  const remove = useDeleteChildPhone(childId, phone.id);
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [number, setNumber] = useState(phone.number);

  useEffect(() => {
    setNumber(phone.number);
  }, [phone.number]);

  const numberDirty = number.replace(/\D/g, '') !== phone.number.replace(/\D/g, '');

  async function saveNumber() {
    try {
      await update.mutateAsync({ number });
      toast('Phone updated', 'success');
      setEditing(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }
  async function toggleField<K extends 'type' | 'textsAllowed' | 'isPrimary'>(
    key: K,
    value: K extends 'type' ? PersonPhoneType : boolean,
  ) {
    try {
      await update.mutateAsync({ [key]: value } as never);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }
  async function onRemove() {
    if (typeof window !== 'undefined' && !window.confirm('Remove this phone?')) return;
    try {
      await remove.mutateAsync();
      toast('Phone removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove.', 'error');
    }
  }

  return (
    <li className="rounded-md border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {editable && editing ? (
          <div className="flex flex-1 items-center gap-2">
            <PhoneInput value={number} onChange={setNumber} className="!mt-0" />
            <button
              type="button"
              onClick={() => void saveNumber()}
              disabled={!numberDirty || update.isPending}
              className="inline-flex items-center rounded-md bg-campus-700 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setNumber(phone.number);
                setEditing(false);
              }}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => editable && setEditing(true)}
            disabled={!editable}
            title={editable ? 'Edit phone number' : 'Read-only'}
            className={cn(
              'text-base font-medium text-gray-900',
              editable && 'hover:text-campus-700',
            )}
          >
            {formatPhone(phone.number) || '—'}
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-1">
          <span className="text-xs text-gray-500">Type</span>
          <select
            value={phone.type}
            onChange={(e) => void toggleField('type', e.target.value as PersonPhoneType)}
            disabled={!editable || update.isPending}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:opacity-60"
          >
            {CHILD_PHONE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 text-xs text-gray-700">
          <input
            type="radio"
            name={'child-primary-phone-' + childId}
            checked={phone.isPrimary}
            onChange={() => void toggleField('isPrimary', true)}
            disabled={!editable || update.isPending || phone.isPrimary}
            className="h-4 w-4 border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
          />
          Primary
        </label>
        {editable && (
          <span className="ml-auto">
            <button
              type="button"
              onClick={() => void onRemove()}
              disabled={!canDelete || remove.isPending}
              title={canDelete ? 'Remove this phone' : 'Add another phone first.'}
              aria-label="Remove phone"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-200 bg-white text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              🗑
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

const CHILD_EMAIL_TYPES: Array<{ value: PersonEmailType; label: string }> = [
  { value: 'PERSONAL', label: 'Personal' },
  { value: 'WORK', label: 'Work' },
  { value: 'SCHOOL', label: 'School' },
  { value: 'OTHER', label: 'Other' },
];

const CHILD_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ChildEmailListCard({ childId, editable }: { childId: string; editable: boolean }) {
  const { data, isLoading } = useChildEmails(childId);
  const add = useAddChildEmail(childId);
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [draftEmail, setDraftEmail] = useState('');
  const [draftType, setDraftType] = useState<PersonEmailType>('PERSONAL');

  async function onAdd() {
    const trimmed = draftEmail.trim();
    if (!trimmed) {
      toast('Enter an email first.', 'error');
      return;
    }
    if (!CHILD_EMAIL_RE.test(trimmed)) {
      toast('That doesn’t look like a valid email.', 'error');
      return;
    }
    try {
      await add.mutateAsync({ email: trimmed, type: draftType });
      setDraftEmail('');
      setDraftType('PERSONAL');
      setAddOpen(false);
      toast('Email added', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add email.', 'error');
    }
  }

  // Defensive: hide synthetic placeholder logins (@minor.invalid for
  // parent-managed minors, @external.invalid for placeholder
  // guardians). The server already filters these out of the
  // response, but guard here too so a stale cache can't leak one. A
  // young child legitimately has no email — the parent adds a real
  // one when they're old enough.
  const emails = (data ?? []).filter(
    (e) => !/@(?:minor|external)\.invalid$/i.test(e.email),
  );

  return (
    <SectionCard title="Email addresses">
      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : emails.length === 0 && !addOpen ? (
        <p className="text-sm text-gray-500">
          No email on file — this is a parent-managed account.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {emails.map((e) => (
            <ChildEmailRow
              key={e.id}
              childId={childId}
              email={e}
              canDelete={emails.length > 1}
              editable={editable}
            />
          ))}
        </ul>
      )}

      {editable && (addOpen ? (
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-700">Email address</label>
              <input
                type="email"
                value={draftEmail}
                onChange={(e) => setDraftEmail(e.target.value)}
                placeholder="kid@example.com"
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700">Type</label>
              <select
                value={draftType}
                onChange={(e) => setDraftType(e.target.value as PersonEmailType)}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
              >
                {CHILD_EMAIL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setDraftEmail('');
                setDraftType('PERSONAL');
              }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onAdd()}
              disabled={add.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
            >
              {add.isPending && <LoadingSpinner size="sm" />}
              <span>{add.isPending ? 'Adding…' : 'Add email'}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="text-sm font-medium text-campus-700 hover:text-campus-600"
          >
            + Add email
          </button>
        </div>
      ))}
      {!editable && emails.length > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          Read-only — this child manages their own profile.
        </p>
      )}
    </SectionCard>
  );
}

function ChildEmailRow({
  childId,
  email,
  canDelete,
  editable,
}: {
  childId: string;
  email: PersonEmailDto;
  canDelete: boolean;
  editable: boolean;
}) {
  const update = useUpdateChildEmail(childId, email.id);
  const remove = useDeleteChildEmail(childId, email.id);
  const { toast } = useToast();

  async function toggleField<K extends 'type' | 'isPrimary'>(
    key: K,
    value: K extends 'type' ? PersonEmailType : boolean,
  ) {
    try {
      await update.mutateAsync({ [key]: value } as never);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }
  async function onRemove() {
    if (typeof window !== 'undefined' && !window.confirm('Remove this email?')) return;
    try {
      await remove.mutateAsync();
      toast('Email removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove.', 'error');
    }
  }

  return (
    <li className="rounded-md border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-base font-medium text-gray-900 break-all">{email.email}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-1">
          <span className="text-xs text-gray-500">Type</span>
          <select
            value={email.type}
            onChange={(e) => void toggleField('type', e.target.value as PersonEmailType)}
            disabled={!editable || update.isPending}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:opacity-60"
          >
            {CHILD_EMAIL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 text-xs text-gray-700">
          <input
            type="radio"
            name={'child-primary-email-' + childId}
            checked={email.isPrimary}
            onChange={() => void toggleField('isPrimary', true)}
            disabled={!editable || update.isPending || email.isPrimary}
            className="h-4 w-4 border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
          />
          Primary
        </label>
        {editable && (
          <span className="ml-auto">
            <button
              type="button"
              onClick={() => void onRemove()}
              disabled={!canDelete || remove.isPending}
              title={canDelete ? 'Remove this email' : 'Add another email first.'}
              aria-label="Remove email"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-200 bg-white text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              🗑
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

// ─── Child home + mailing address ──────────────────────────

/**
 * Two cards rendered together: home address (FAMILY/CUSTOM toggle)
 * and mailing address ("different from home" toggle). Both write
 * through the same useUpdateFamilyChild mutation with a single
 * Save Changes button at the bottom. Mirrors the adult /profile
 * Contact tab's address shape. Editing is parent-side regardless
 * of accessLevel — addresses live on platform_family_children,
 * not on the child's iam_person.
 */
function ChildAddressCards({ child }: { child: FamilyChildDto }) {
  const { toast } = useToast();
  const update = useUpdateFamilyChild(child.id);
  const familySettings = useFamilySettings();
  const editable = child.canEdit;

  const initial = useMemo(
    () => ({
      addressSource: child.addressSource,
      customAddressLine1: child.customAddressLine1 ?? '',
      customAddressLine2: child.customAddressLine2 ?? '',
      customCity: child.customCity ?? '',
      customState: child.customState ?? '',
      customPostalCode: child.customPostalCode ?? '',
      customCountry: child.customCountry ?? 'United States',
      mailingAddressSource: child.mailingAddressSource,
      mailingAddressDifferent: child.mailingAddressDifferent,
      mailingLine1: child.mailingLine1 ?? '',
      mailingLine2: child.mailingLine2 ?? '',
      mailingCity: child.mailingCity ?? '',
      mailingState: child.mailingState ?? '',
      mailingPostalCode: child.mailingPostalCode ?? '',
      mailingCountry: child.mailingCountry ?? 'United States',
    }),
    [child],
  );
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => {
    setForm(initial);
    setErrors(new Set());
  }, [initial]);

  const isCustomHome = form.addressSource === 'CUSTOM';
  // Mailing now has the same Use family / Use custom toggle as home.
  const isCustomMailing = form.mailingAddressSource === 'CUSTOM';
  // "Same as physical address" lives UNDER Use custom; it's the positive
  // sense of the stored mailing_address_different flag.
  const sameAsPhysical = !form.mailingAddressDifferent;

  const fs = familySettings.data;
  // The resolved physical address — family-inherited or the child's
  // own custom address — used for the read-only "same as physical" display.
  const physical =
    form.addressSource === 'FAMILY'
      ? {
          line1: fs?.addressLine1 ?? '',
          line2: fs?.addressLine2 ?? '',
          city: fs?.city ?? '',
          state: fs?.state ?? '',
          postalCode: fs?.postalCode ?? '',
          country: fs?.country ?? '',
        }
      : {
          line1: form.customAddressLine1,
          line2: form.customAddressLine2,
          city: form.customCity,
          state: form.customState,
          postalCode: form.customPostalCode,
          country: form.customCountry,
        };

  // The family mailing address inherited under "Use family": the family's
  // own mailing address, falling back to the family home address when the
  // family keeps mailing == home (mailingAddressDifferent === false).
  const familyMailing =
    fs && fs.mailingAddressDifferent
      ? {
          line1: fs.mailingLine1 ?? '',
          line2: fs.mailingLine2 ?? '',
          city: fs.mailingCity ?? '',
          state: fs.mailingState ?? '',
          postalCode: fs.mailingPostalCode ?? '',
          country: fs.mailingCountry ?? '',
        }
      : {
          line1: fs?.addressLine1 ?? '',
          line2: fs?.addressLine2 ?? '',
          city: fs?.city ?? '',
          state: fs?.state ?? '',
          postalCode: fs?.postalCode ?? '',
          country: fs?.country ?? '',
        };

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors.has(key as string)) {
      setErrors((prev) => {
        const next = new Set(prev);
        next.delete(key as string);
        return next;
      });
    }
  }

  function validate(): Set<string> {
    const missing = new Set<string>();
    // Custom home requires the full set (family-inherited is validated
    // on the family-settings tab). Apartment/unit stays optional.
    if (isCustomHome) {
      for (const k of [
        'customAddressLine1',
        'customCity',
        'customState',
        'customPostalCode',
        'customCountry',
      ] as Array<keyof typeof form>) {
        if (!String(form[k]).trim()) missing.add(k);
      }
    }
    // Custom mailing fields are required only under Use custom + NOT
    // same-as-physical. Use family inherits (validated on the family tab);
    // same-as-physical mirrors the physical address.
    if (isCustomMailing && !sameAsPhysical) {
      for (const k of [
        'mailingLine1',
        'mailingCity',
        'mailingState',
        'mailingPostalCode',
        'mailingCountry',
      ] as Array<keyof typeof form>) {
        if (!String(form[k]).trim()) missing.add(k);
      }
    }
    return missing;
  }

  async function doSave() {
    if (!isDirty || update.isPending) return;
    const missing = validate();
    if (missing.size > 0) {
      setErrors(missing);
      toast('Please fill in all required address fields.', 'error');
      return;
    }
    setErrors(new Set());
    // Custom mailing fields are meaningful only under Use custom + a
    // mailing address that differs from physical.
    const keepMailing = isCustomMailing && form.mailingAddressDifferent;
    try {
      await update.mutateAsync({
        addressSource: form.addressSource,
        customAddressLine1: form.customAddressLine1.trim() || null,
        customAddressLine2: form.customAddressLine2.trim() || null,
        customCity: form.customCity.trim() || null,
        customState: form.customState.trim() || null,
        customPostalCode: form.customPostalCode.trim() || null,
        customCountry: form.customCountry.trim() || null,
        mailingAddressSource: form.mailingAddressSource,
        mailingAddressDifferent: form.mailingAddressDifferent,
        // Custom mailing fields persist only when actually used (Use
        // custom + different from physical); otherwise null them so a
        // prior override doesn't linger after switching to Use family or
        // same-as-physical.
        mailingLine1: keepMailing ? form.mailingLine1.trim() || null : null,
        mailingLine2: keepMailing ? form.mailingLine2.trim() || null : null,
        mailingCity: keepMailing ? form.mailingCity.trim() || null : null,
        mailingState: keepMailing ? form.mailingState.trim() || null : null,
        mailingPostalCode: keepMailing ? form.mailingPostalCode.trim() || null : null,
        mailingCountry: keepMailing ? form.mailingCountry.trim() || null : null,
      });
      toast('Address saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void doSave();
  }

  function onDiscard() {
    setForm(initial);
    setErrors(new Set());
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <SectionCard title="Home address">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-600">
            {isCustomHome
              ? 'Custom address for this child.'
              : "Using your family's home address."}
          </p>
          {editable && (
            <FamilyCustomToggle
              value={form.addressSource}
              onChange={(next) => setForm((f) => ({ ...f, addressSource: next }))}
            />
          )}
        </div>

        {!isCustomHome ? (
          <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
            {formatAddressOneLine(physical) || (
              <span className="text-gray-500">No family address on file yet.</span>
            )}
            <div className="mt-2">
              <Link
                href="/family/settings?tab=addresses"
                className="text-xs font-medium text-campus-700 hover:text-campus-600"
              >
                Edit family address →
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <ChildAddressField
              id="customAddressLine1"
              label="Street address"
              value={form.customAddressLine1}
              onChange={(v) => setField('customAddressLine1', v)}
              dirty={dirtyFields.has('customAddressLine1')}
              disabled={!editable}
              className="sm:col-span-2"
              required
              error={
                errors.has('customAddressLine1') ? 'Street address is required.' : undefined
              }
            />
            <ChildAddressField
              id="customAddressLine2"
              label="Apartment / unit"
              value={form.customAddressLine2}
              onChange={(v) => setField('customAddressLine2', v)}
              dirty={dirtyFields.has('customAddressLine2')}
              disabled={!editable}
              className="sm:col-span-2"
            />
            <ChildAddressField
              id="customCity"
              label="City"
              value={form.customCity}
              onChange={(v) => setField('customCity', v)}
              dirty={dirtyFields.has('customCity')}
              disabled={!editable}
              required
              error={errors.has('customCity') ? 'City is required.' : undefined}
            />
            <ChildAddressField
              id="customState"
              label="State / province"
              value={form.customState}
              onChange={(v) => setField('customState', v)}
              dirty={dirtyFields.has('customState')}
              disabled={!editable}
              required
              error={errors.has('customState') ? 'State / province is required.' : undefined}
            />
            <ChildAddressField
              id="customPostalCode"
              label="ZIP / postal code"
              value={form.customPostalCode}
              onChange={(v) => setField('customPostalCode', v)}
              dirty={dirtyFields.has('customPostalCode')}
              disabled={!editable}
              required
              error={
                errors.has('customPostalCode') ? 'ZIP / postal code is required.' : undefined
              }
            />
            <CountryField
              id="customCountry"
              value={form.customCountry}
              onChange={(v) => setField('customCountry', v)}
              dirty={dirtyFields.has('customCountry')}
              disabled={!editable}
              required
              error={errors.has('customCountry') ? 'Country is required.' : undefined}
            />
          </div>
        )}
      </SectionCard>

      <SectionCard title="Mailing address">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-600">
            {isCustomMailing
              ? 'Custom mailing address for this child.'
              : "Using your family's mailing address."}
          </p>
          {editable && (
            <FamilyCustomToggle
              value={form.mailingAddressSource}
              onChange={(next) => setForm((f) => ({ ...f, mailingAddressSource: next }))}
            />
          )}
        </div>

        {!isCustomMailing ? (
          // Use family: read-only display of the inherited family mailing
          // address (family mailing, or the family home when they keep
          // mailing == home), matching the home-address display style.
          <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
            {formatAddressOneLine(familyMailing) || (
              <span className="text-gray-500">No family mailing address on file yet.</span>
            )}
            <div className="mt-2">
              <Link
                href="/family/settings?tab=addresses"
                className="text-xs font-medium text-campus-700 hover:text-campus-600"
              >
                Edit family address →
              </Link>
            </div>
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sameAsPhysical}
                onChange={(e) =>
                  setForm((f) => ({ ...f, mailingAddressDifferent: !e.target.checked }))
                }
                disabled={!editable}
                className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
              />
              Same as physical address
              {dirtyFields.has('mailingAddressDifferent') && (
                <span
                  aria-label="Modified"
                  title="Modified — save to keep this change"
                  className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500"
                />
              )}
            </label>

            {sameAsPhysical ? (
              // Read-only one-line display of the resolved physical
              // address (family-inherited or custom), matching the home
              // display style.
              <div className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
                {formatAddressOneLine(physical) || (
                  <span className="text-gray-500">No physical address on file yet.</span>
                )}
              </div>
            ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ChildAddressField
              id="mailingLine1"
              label="Street address"
              value={form.mailingLine1}
              onChange={(v) => setField('mailingLine1', v)}
              dirty={dirtyFields.has('mailingLine1')}
              disabled={!editable}
              className="sm:col-span-2"
              required
              error={errors.has('mailingLine1') ? 'Street address is required.' : undefined}
            />
            <ChildAddressField
              id="mailingLine2"
              label="Apartment / unit"
              value={form.mailingLine2}
              onChange={(v) => setField('mailingLine2', v)}
              dirty={dirtyFields.has('mailingLine2')}
              disabled={!editable}
              className="sm:col-span-2"
            />
            <ChildAddressField
              id="mailingCity"
              label="City"
              value={form.mailingCity}
              onChange={(v) => setField('mailingCity', v)}
              dirty={dirtyFields.has('mailingCity')}
              disabled={!editable}
              required
              error={errors.has('mailingCity') ? 'City is required.' : undefined}
            />
            <ChildAddressField
              id="mailingState"
              label="State / province"
              value={form.mailingState}
              onChange={(v) => setField('mailingState', v)}
              dirty={dirtyFields.has('mailingState')}
              disabled={!editable}
              required
              error={errors.has('mailingState') ? 'State / province is required.' : undefined}
            />
            <ChildAddressField
              id="mailingPostalCode"
              label="ZIP / postal code"
              value={form.mailingPostalCode}
              onChange={(v) => setField('mailingPostalCode', v)}
              dirty={dirtyFields.has('mailingPostalCode')}
              disabled={!editable}
              required
              error={
                errors.has('mailingPostalCode') ? 'ZIP / postal code is required.' : undefined
              }
            />
            <CountryField
              id="mailingCountry"
              value={form.mailingCountry}
              onChange={(v) => setField('mailingCountry', v)}
              dirty={dirtyFields.has('mailingCountry')}
              disabled={!editable}
              required
              error={errors.has('mailingCountry') ? 'Country is required.' : undefined}
            />
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* Hidden submit keeps Enter-to-save working inside the form;
          the visible control is the viewport-fixed StickySaveBar. */}
      <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      {editable && (
        <StickySaveBar
          isDirty={isDirty}
          onSave={() => void doSave()}
          onDiscard={onDiscard}
          saving={update.isPending}
        />
      )}
    </form>
  );
}

function ChildAddressField({
  id,
  label,
  value,
  onChange,
  dirty,
  disabled,
  className,
  required,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  dirty: boolean;
  disabled?: boolean;
  className?: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
        {required && (
          <span className="ml-0.5 text-red-500" aria-hidden>
            *
          </span>
        )}
        {dirty && (
          <span
            aria-label="Modified"
            title="Modified — save to keep this change"
            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
          />
        )}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className={cn(
          'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
          error
            ? 'border border-red-400 focus:ring-red-400'
            : dirty
              ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
              : 'border border-gray-300',
        )}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ─── Guardian contacts (read-only panel) ───────────────────

/**
 * Read-only quick-reference panel. School staff opening a child's
 * profile shouldn't have to click through to /family to see what
 * each parent's primary phone + email is. The data is sourced from
 * the family-members listing — primaryPhone / primaryPhoneType /
 * email / primaryEmailType are populated server-side from
 * platform_person_phones / platform_person_emails (is_primary=true).
 *
 * Guardian contact info itself is managed on the guardian's own
 * profile; we surface a friendly nudge for that.
 */
function GuardianContactsPanel() {
  const familyView = useFamilyView();
  const guardians = (familyView.data?.members ?? []).filter((m) => m.status === 'ACTIVE');

  const phoneTypeLabel = (t: string | null) => {
    if (!t) return '';
    const map: Record<string, string> = {
      CELL: 'Cell',
      HOME: 'Home',
      WORK: 'Work',
      OTHER: 'Other',
    };
    return map[t] ?? t;
  };

  return (
    <SectionCard title="Parents & Guardians">
      {guardians.length === 0 ? (
        <p className="text-sm text-gray-500">No guardians on file.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {guardians.map((g) => {
            const heroName = g.preferredName?.trim() ? g.preferredName : g.firstName;
            const fullName =
              [heroName, g.lastName].filter(Boolean).join(' ').trim() || g.email || 'Guardian';
            const phoneLabel = phoneTypeLabel(g.primaryPhoneType);
            return (
              <li key={g.id} className="rounded-md border border-gray-200 bg-white p-3">
                <p className="text-sm font-medium text-gray-900">
                  {fullName}
                  <span className="ml-2 text-xs font-normal text-gray-500">Parent/Guardian</span>
                </p>
                {g.primaryPhone ? (
                  <p className="mt-1 text-xs text-gray-700">
                    <span aria-hidden className="mr-1">
                      📱
                    </span>
                    {formatPhone(g.primaryPhone)}
                    <span className="text-gray-500">
                      {' '}
                      ({phoneLabel ? phoneLabel + ', ' : ''}primary)
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-gray-500">No phone on file</p>
                )}
                {g.email ? (
                  <p className="mt-0.5 text-xs text-gray-700">
                    <span aria-hidden className="mr-1">
                      ✉️
                    </span>
                    {g.email}
                    <span className="text-gray-500"> (primary)</span>
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-gray-500">No email on file</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-gray-500">
        Read-only — this info comes from each guardian&rsquo;s profile.
      </p>
    </SectionCard>
  );
}

// ─── Medical tab ────────────────────────────────────────────

function MedicalTab({ child }: { child: FamilyChildDto }) {
  return (
    <div className="flex flex-col gap-5">
      <ParentOnlyBanner />
      <MedicalSection childId={child.id} />
    </div>
  );
}

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
  const [source, setSource] = useState<MedicalSource>('FAMILY');
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
    setSource(data.medicalSource);
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

  async function flipSource(next: MedicalSource) {
    if (next === source) return;
    try {
      await update.mutateAsync({ medicalSource: next });
      setSource(next);
      toast(
        next === 'FAMILY'
          ? 'Now using family doctor & insurance'
          : 'Switched to custom doctor & insurance for this child',
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change source.', 'error');
    }
  }

  async function saveDoctor() {
    try {
      // When source is FAMILY the doctor/insurance fields are
      // read-only (inherited); only the per-child bloodType and
      // medicalNotes are writable in that mode. Server still accepts
      // the full payload, but we send only the editable subset to
      // avoid stomping the inherited values back onto the per-child
      // columns.
      const payload =
        source === 'CUSTOM'
          ? {
              doctorName: doctor.name.trim() || null,
              doctorPhone: doctor.phone.trim() || null,
              doctorClinic: doctor.clinic.trim() || null,
              insuranceProvider: doctor.insuranceProvider.trim() || null,
              insurancePolicy: doctor.insurancePolicy.trim() || null,
              insuranceGroup: doctor.insuranceGroup.trim() || null,
              bloodType: doctor.bloodType.trim() || null,
              medicalNotes: doctor.medicalNotes.trim() || null,
            }
          : {
              bloodType: doctor.bloodType.trim() || null,
              medicalNotes: doctor.medicalNotes.trim() || null,
            };
      await update.mutateAsync(payload);
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
      <SectionCard title="Medical & Health">
        <p className="text-sm text-gray-500">Loading…</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Medical & Health">
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Doctor &amp; Insurance
          </h3>
          <FamilyCustomToggle
            value={source}
            onChange={(next) => void flipSource(next)}
            disabled={update.isPending}
          />
        </div>

        {source === 'FAMILY' ? (
          <>
            {/* Three-state inheritance: when the family explicitly marked
                "no doctor / no insurance" (flag === false), show that as a
                definitive statement instead of blank dashes, matching the
                family Health tab wording. flag === true / null falls
                through to the inherited fields (which may be empty =
                "nobody filled it in yet"). */}
            <div className="mt-3 grid gap-3 sm:grid-cols-2 text-sm text-gray-700">
              {data.hasFamilyDoctor === false ? (
                <p className="sm:col-span-2 text-gray-600">No family doctor on file</p>
              ) : (
                <>
                  <ReadOnlyField label="Doctor name" value={doctor.name} />
                  <ReadOnlyField label="Doctor phone" value={formatPhone(doctor.phone)} />
                  <div className="sm:col-span-2">
                    <ReadOnlyField label="Clinic" value={doctor.clinic} />
                  </div>
                </>
              )}
              {data.hasInsurance === false ? (
                <p className="sm:col-span-2 text-gray-600">No family insurance on file</p>
              ) : (
                <>
                  <ReadOnlyField label="Insurance provider" value={doctor.insuranceProvider} />
                  <ReadOnlyField label="Policy number" value={doctor.insurancePolicy} />
                  <ReadOnlyField label="Group number" value={doctor.insuranceGroup} />
                </>
              )}
            </div>
            <div className="mt-3">
              <Link
                href="/family/settings"
                className="text-sm font-medium text-campus-700 hover:text-campus-600"
              >
                Edit family medical info →
              </Link>
            </div>
          </>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <SectionField label="Doctor name" value={doctor.name} onChange={(v) => patchDoctor('name', v)} />
            <PhoneField label="Doctor phone" value={doctor.phone} onChange={(raw) => patchDoctor('phone', raw)} />
            <SectionField label="Clinic" value={doctor.clinic} onChange={(v) => patchDoctor('clinic', v)} className="sm:col-span-2" />
            <SectionField label="Insurance provider" value={doctor.insuranceProvider} onChange={(v) => patchDoctor('insuranceProvider', v)} />
            <SectionField label="Policy number" value={doctor.insurancePolicy} onChange={(v) => patchDoctor('insurancePolicy', v)} />
            <SectionField label="Group number" value={doctor.insuranceGroup} onChange={(v) => patchDoctor('insuranceGroup', v)} />
          </div>
        )}

        {/* bloodType + medicalNotes are per-child regardless of source —
            a family-level "blood type" doesn't make sense. */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
    </SectionCard>
  );
}

/**
 * Compact two-state toggle used for the inheritance pickers. Doesn't
 * carry a "modified" indicator — flipping it persists immediately
 * because the source choice is a single field and a save-button per
 * toggle would feel heavier than necessary.
 */
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

// ─── Emergency tab ──────────────────────────────────────────

/**
 * Contact-tab emergency contacts section. Wraps the source toggle
 * around two render paths:
 *
 *   FAMILY (default) — read-only family contacts (sourced from
 *     /family/settings/emergency-contacts) plus an editable
 *     "Additional contacts for <name> only" list of per-child rows
 *     that sit on top.
 *
 *   CUSTOM           — per-child contacts only. Family rows are
 *     hidden; the toggle copy explicitly calls out that the family
 *     defaults are being ignored.
 *
 * The toggle persists via PATCH /family/children/:id since the
 * source is a child-level preference.
 */
function EmergencyContactsContactTabSection({ child }: { child: FamilyChildDto }) {
  const { toast } = useToast();
  const updateChild = useUpdateFamilyChild(child.id);

  async function flipSource(next: EmergencyContactSource) {
    if (next === child.emergencyContactSource) return;
    try {
      await updateChild.mutateAsync({ emergencyContactSource: next });
      toast(
        next === 'FAMILY'
          ? "Now using your family's emergency contacts"
          : 'Switched to custom emergency contacts for this child',
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change source.', 'error');
    }
  }

  return (
    <SectionCard title="Emergency Contacts">
      <ParentOnlyBanner />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-600">
          {child.emergencyContactSource === 'FAMILY'
            ? 'Using your family contacts plus any additional contacts for this child.'
            : 'Using a custom contact list for this child only. Family contacts are ignored.'}
        </p>
        <FamilyCustomToggle
          value={child.emergencyContactSource}
          onChange={(next) => void flipSource(next)}
          disabled={updateChild.isPending}
        />
      </div>

      {child.emergencyContactSource === 'FAMILY' && <FamilyEmergencyContactsInherited />}

      <ChildEmergencyContactsBlock
        childId={child.id}
        title={
          child.emergencyContactSource === 'FAMILY'
            ? 'Additional contacts for ' +
              (child.preferredName?.trim() ? child.preferredName : child.firstName) +
              ' only'
            : 'Custom emergency contacts'
        }
      />
    </SectionCard>
  );
}

/**
 * Read-only block showing the family-inherited emergency contacts.
 *
 * The /api/v1/family/settings/emergency-contacts endpoint only
 * returns rows from platform_family_emergency_contacts (manuals).
 * Active guardians from platform_family_members are added on the
 * /family/settings Emergency tab via a client-side merge — they're
 * not in the same physical table, so the server can't return them
 * without changing the response shape. To stay consistent with
 * what the parent sees on /family/settings, we mirror that same
 * merge here on the read-only child view.
 *
 * Sort uses the unified priority_order namespace (both tables share
 * it; see /family/settings EmergencyTab), with the same default
 * tie-break — guardians first, then manuals by createdAt, when
 * everyone's priority is 0.
 */
interface InheritedEcRow {
  key: string;
  kind: 'guardian' | 'manual';
  name: string;
  relationship: string;
  phonePrimary: string | null;
  phoneAlternate: string | null;
  email: string | null;
  authorizedPickup: boolean;
  priority: number;
  tieBreak: number;
}

function FamilyEmergencyContactsInherited() {
  const familyView = useFamilyView();
  const { data: manualContacts, isLoading } = useFamilyEmergencyContacts();

  const members = familyView.data?.members ?? [];
  // Manual rows may have linkedPersonId pointing back at a guardian —
  // when that's set, the row was created from the "link a guardian"
  // flow and is already represented in the guardians block. Skip it
  // here so the same person doesn't appear twice. Guardian rows take
  // precedence because they carry the live phone from iam_person.
  const guardianPersonIds = new Set(
    members
      .filter((m) => m.status === 'ACTIVE' && m.personId)
      .map((m) => m.personId as string),
  );

  const guardianRows: InheritedEcRow[] = members
    .filter((m) => m.status === 'ACTIVE')
    .map((m, i) => {
      const heroName = m.preferredName?.trim() ? m.preferredName : m.firstName;
      const fullName =
        [heroName, m.lastName].filter(Boolean).join(' ').trim() || m.email || 'Guardian';
      return {
        key: 'guardian:' + m.id,
        kind: 'guardian' as const,
        name: fullName,
        relationship: 'Parent/Guardian',
        phonePrimary: m.primaryPhone,
        phoneAlternate: null,
        email: m.email,
        authorizedPickup: m.emergencyAuthorizedPickup,
        priority: m.emergencyPriorityOrder,
        tieBreak: 1000 + i,
      };
    });

  const manualRows: InheritedEcRow[] = (manualContacts ?? [])
    .filter((c) => !c.linkedPersonId || !guardianPersonIds.has(c.linkedPersonId))
    .map((c, i) => ({
      key: 'manual:' + c.id,
      kind: 'manual' as const,
      name: c.name,
      relationship: c.relationship,
      phonePrimary: c.phonePrimary,
      phoneAlternate: c.phoneAlternate,
      email: c.email,
      authorizedPickup: c.authorizedPickup,
      priority: c.priorityOrder,
      tieBreak: 2000 + i,
    }));

  const rows: InheritedEcRow[] = [...guardianRows, ...manualRows].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.tieBreak - b.tieBreak;
  });

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Family contacts
        </h3>
        <Link
          href="/family/settings?tab=emergency"
          className="text-sm font-medium text-campus-700 hover:text-campus-600"
        >
          Edit family contacts →
        </Link>
      </div>
      {isLoading ? (
        <p className="mt-2 text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">
          No family emergency contacts yet.{' '}
          <Link
            href="/family/settings?tab=emergency"
            className="font-medium text-campus-700 hover:text-campus-600"
          >
            Add one in family settings.
          </Link>
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((r, i) => (
            <li
              key={r.key}
              className="flex items-start justify-between gap-3 rounded-md border border-gray-200 bg-white p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">
                  <span className="text-xs text-gray-400">{i + 1}.</span> {r.name}
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    {r.relationship}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-gray-600">
                  {formatPhone(r.phonePrimary)}
                  {r.phoneAlternate && (
                    <span className="text-gray-500"> · {formatPhone(r.phoneAlternate)}</span>
                  )}
                </p>
                {r.email && <p className="text-xs text-gray-500">{r.email}</p>}
                <p className="mt-0.5 text-xs">
                  {r.authorizedPickup ? (
                    <span className="text-emerald-700">✓ Authorized for pickup</span>
                  ) : (
                    <span className="text-gray-500">Not authorized for pickup</span>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The per-child emergency contacts block — formerly the whole
 * EmergencyTab. The `title` prop changes based on source mode so the
 * heading reads naturally: "Additional contacts for X only" when
 * inheriting from family, "Custom emergency contacts" when overriding.
 */
function ChildEmergencyContactsBlock({ childId, title }: { childId: string; title: string }) {
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
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
        <p className="mt-2 text-sm text-gray-500">Loading…</p>
      </div>
    );
  }
  const contacts = data ?? [];

  return (
    <div className="mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      {contacts.length === 0 && !showAdd ? (
        <p className="mt-2 text-sm text-gray-500">No additional contacts on file for this child.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
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
            <PhoneField label="Primary phone" value={draft.phonePrimary} onChange={(raw) => setDraft({ ...draft, phonePrimary: raw })} required />
            <PhoneField label="Alternate phone" value={draft.phoneAlternate} onChange={(raw) => setDraft({ ...draft, phoneAlternate: raw })} />
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
    </div>
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

// ─── Dietary tab ────────────────────────────────────────────

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

function DietaryTab({ child }: { child: FamilyChildDto }) {
  return (
    <div className="flex flex-col gap-5">
      <ParentOnlyBanner />
      <DietarySection childId={child.id} />
    </div>
  );
}

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
      <SectionCard title="Dietary & Food Restrictions">
        <p className="text-sm text-gray-500">Loading…</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Dietary & Food Restrictions"
      description="Food allergies in the Medical section are tracked separately. This section covers diet style + school-meal preferences."
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
    </SectionCard>
  );
}

// ─── About tab ──────────────────────────────────────────────

/**
 * Stub — bio + interests + photo land with the about-me commit. For
 * INDEPENDENT children this tab will eventually be read-only for the
 * parent (the child owns their own bio); for MANAGED the parent fills
 * it in.
 */
function AboutTab({ child }: { child: FamilyChildDto }) {
  return (
    <SectionCard title={'About ' + (child.preferredName?.trim() ? child.preferredName : child.firstName)}>
      <p className="text-xs text-gray-500">
        Bio, interests, and profile photo coming soon. Independent accounts will own this section
        themselves; managed accounts let the parent fill it in.
      </p>
    </SectionCard>
  );
}

// ─── Section primitives ─────────────────────────────────────

function SectionCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      {(title || description) && (
        <div className="mb-3">
          {title && <h2 className="text-sm font-semibold text-gray-900">{title}</h2>}
          {description && <p className="mt-0.5 text-xs text-gray-600">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

function ParentOnlyBanner() {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900"
      role="note"
    >
      <span aria-hidden>🔒</span>
      <span>
        <span className="font-semibold">Parent/Guardian only.</span> Only adults in this family can
        update this section. Linked children see read-only data.
      </span>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-700">{label}</p>
      <p className="mt-1 text-sm text-gray-900">{value && value.trim() ? value : <span className="text-gray-400">—</span>}</p>
    </div>
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
  dirty,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  dirty?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
        {dirty && (
          <span
            aria-label="Modified"
            title="Modified — save to keep this change"
            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
          />
        )}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-invalid={!!error}
        className={cn(
          'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500',
          error
            ? 'border border-red-300'
            : dirty
              ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
              : 'border border-gray-300',
        )}
      />
      {error ? (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Phone-shaped variant of SectionField — same label / required /
 * dirty affordances but routes through the auto-formatting
 * PhoneInput. onChange fires with the raw-digit string.
 */
function PhoneField({
  label,
  value,
  onChange,
  required,
  className,
  dirty,
}: {
  label: string;
  value: string;
  onChange: (raw: string) => void;
  required?: boolean;
  className?: string;
  dirty?: boolean;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
        {dirty && (
          <span
            aria-label="Modified"
            title="Modified — save to keep this change"
            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
          />
        )}
      </label>
      <PhoneInput value={value} onChange={onChange} dirty={dirty} />
    </div>
  );
}

function SectionField({
  label,
  value,
  onChange,
  placeholder,
  required,
  className,
  dirty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  dirty?: boolean;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
        {dirty && (
          <span
            aria-label="Modified"
            title="Modified — save to keep this change"
            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
          />
        )}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500',
          dirty
            ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
            : 'border border-gray-300',
        )}
      />
    </div>
  );
}

// ─── Buttons + helpers ──────────────────────────────────────

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

function genderLabel(value: string | null): string {
  // Canonical set is MALE | FEMALE | NOT_SPECIFIED (FIX 1). normalizeGender
  // folds any legacy/unknown value (blank, 'F'/'M', historical NONBINARY/
  // OTHER, etc.) into that set so the read-only label always matches an
  // option the picker offers.
  return GENDER_LABELS[normalizeGender(value)];
}

// ─── Send-link modal ────────────────────────────────────────

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
