'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { GENDERS, GENDER_LABELS } from '@campusos/shared';
import { ApiError } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useAuthActions } from '@/lib/auth-context';
import { useAuthStore } from '@/lib/auth-store';
import {
  useAddMyEmail,
  useAddMyPhone,
  useDeleteMyEmail,
  useDeleteMyPhone,
  useMyEmails,
  useMyMedical,
  useMyPhones,
  useMyProfile,
  useUpdateMyEmail,
  useUpdateMyMedical,
  useUpdateMyPhone,
  useUpdateMyProfile,
} from '@/hooks/use-profile';
import type {
  AdultAllergyEntry,
  AdultConditionEntry,
  AdultMedicationEntry,
  PersonEmailDto,
  PersonEmailType,
  PersonPhoneDto,
  PersonPhoneType,
  WorkLocationType,
} from '@/lib/types';
import {
  useAcceptFamilyLink,
  useFamilySettings,
  useGenerateChildCode,
} from '@/hooks/use-family-children';
import Link from 'next/link';
import { useBeforeUnloadOnDirty, useFormDirty } from '@/hooks/use-form-dirty';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { FamilyCustomToggle } from '@/components/ui/FamilyCustomToggle';
import { StickySaveBar } from '@/components/ui/StickySaveBar';
import { formatPhone } from '@/lib/phone-format';
import { FamilyStructureSection } from '@/components/family/FamilyStructureSection';
import type { ProfileDto } from '@/lib/types';

/**
 * /profile — self-service identity editor, tabbed.
 *
 * Mirrors the child-profile shape: sticky hero (preferred name + full
 * name + email) above a four-tab bar (Account / Contact / Medical &
 * Health / About). Each tab is an independent form with its own
 * dirty-state diff + Save button.
 *
 * Source of truth: GET /profile/me on iam_person. Self-editable
 * fields are listed on UpdateMyProfileDto; gender newly joins that
 * list (this commit). Login email stays read-only — changes require
 * an IdP-side verification flow that isn't built yet.
 *
 * Contact / Medical / About tabs are stubs this commit and get fleshed
 * out in the next three. Family connection cards stay at the bottom
 * for now and are conditionally hidden for PARENT-persona users in
 * the final commit of this series.
 */
export default function MyProfilePage() {
  const profile = useMyProfile();

  if (profile.isLoading) return <PageLoader label="Loading your profile…" />;
  if (profile.isError || !profile.data) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Couldn't load your profile"
          description="Try refreshing. If the problem persists, contact support."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Hero profile={profile.data} />
      <Tabs profile={profile.data} />
      <FamilyConnectionSectionGated />
    </div>
  );
}

/**
 * The Generate-code / Enter-code cards are for CHILDREN connecting
 * to a parent's family (or anyone who's not yet linked anywhere).
 * Parents manage their family at /family — surfacing the same cards
 * on a parent's /profile is noise and was hiding the new tabs.
 *
 * Logic: if the user already has a PARENT persona, hide the cards.
 * Otherwise show them (covers students, unlinked guardians, staff,
 * brand-new 0-persona accounts).
 */
function FamilyConnectionSectionGated() {
  const personas = useAuthStore((s) => s.user?.personas ?? []);
  const hasParentPersona = personas.some((p) => p.type === 'PARENT');
  if (hasParentPersona) return null;
  return <FamilyConnectionSection />;
}

// ─── Hero ──────────────────────────────────────────────────

function Hero({ profile }: { profile: ProfileDto }) {
  const preferred = profile.preferredName?.trim();
  const heroName = preferred ? preferred : profile.firstName;
  const fullName = [profile.firstName, profile.middleName, profile.lastName]
    .filter(Boolean)
    .join(' ');
  const showFull = fullName.trim() !== heroName.trim();

  return (
    <header className="mb-6">
      <h1 className="text-3xl font-bold tracking-tight text-gray-900">{heroName}</h1>
      {showFull && <p className="mt-1 text-sm text-gray-500">{fullName}</p>}
      {profile.loginEmail && (
        <p className="mt-0.5 text-sm text-gray-500">{profile.loginEmail}</p>
      )}
    </header>
  );
}

// ─── Tab bar + routing ─────────────────────────────────────

type TabKey = 'account' | 'contact' | 'occupation' | 'medical' | 'about';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'account', label: 'Account' },
  { key: 'contact', label: 'Contact' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'medical', label: 'Medical & Health' },
  { key: 'about', label: 'About' },
];

function isTabKey(s: string | null): s is TabKey {
  return s !== null && TABS.some((t) => t.key === s);
}

function Tabs({ profile }: { profile: ProfileDto }) {
  const searchParams = useSearchParams();
  const initial = searchParams?.get('tab');
  const [active, setActive] = useState<TabKey>(
    isTabKey(initial ?? null) ? (initial as TabKey) : 'account',
  );

  function select(key: TabKey) {
    setActive(key);
    if (typeof window !== 'undefined') {
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
            const isActive = active === t.key;
            return (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => select(t.key)}
                  className={cn(
                    'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-campus-700 text-campus-700'
                      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
                  )}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {t.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* pb-24 reserves clearance so the viewport-fixed StickySaveBar
          each tab renders never covers the tab's last field. */}
      <div className="mt-6 pb-24">
        {active === 'account' && <AccountTab profile={profile} />}
        {active === 'contact' && <ContactTab profile={profile} />}
        {active === 'occupation' && <OccupationTab profile={profile} />}
        {active === 'medical' && <MedicalTab profile={profile} />}
        {active === 'about' && <AboutTab profile={profile} />}
      </div>
    </>
  );
}

// ─── Account tab ───────────────────────────────────────────

function AccountTab({ profile }: { profile: ProfileDto }) {
  const { refreshUser } = useAuthActions();
  const { toast } = useToast();
  const update = useUpdateMyProfile();
  const personas = useAuthStore((s) => s.user?.personas ?? []);
  const myPersonId = useAuthStore((s) => s.user?.personId ?? null);

  const initial = useMemo(
    () => ({
      firstName: profile.firstName ?? '',
      middleName: profile.middleName ?? '',
      lastName: profile.lastName ?? '',
      preferredName: profile.preferredName ?? '',
      dateOfBirth: profile.dateOfBirth ?? '',
      gender: profile.gender ?? '',
    }),
    [
      profile.firstName,
      profile.middleName,
      profile.lastName,
      profile.preferredName,
      profile.dateOfBirth,
      profile.gender,
    ],
  );
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string }>({});
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

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
        middleName: form.middleName.trim() || null,
        lastName: form.lastName.trim(),
        preferredName: form.preferredName.trim() || null,
        dateOfBirth: form.dateOfBirth || null,
        gender: form.gender || null,
      });
      await refreshUser();
      toast('Profile updated', 'success');
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
    <div className="flex flex-col gap-5">
    <SectionCard>
      <form onSubmit={onSubmit} noValidate>
        <div className="grid gap-4 sm:grid-cols-3">
          <EditField
            id="firstName"
            label="First name"
            value={form.firstName}
            onChange={(v) => setField('firstName', v)}
            error={errors.firstName}
            required
            autoComplete="given-name"
            dirty={dirtyFields.has('firstName')}
          />
          <EditField
            id="middleName"
            label="Middle name"
            value={form.middleName}
            onChange={(v) => setField('middleName', v)}
            autoComplete="additional-name"
            dirty={dirtyFields.has('middleName')}
          />
          <EditField
            id="lastName"
            label="Last name"
            value={form.lastName}
            onChange={(v) => setField('lastName', v)}
            error={errors.lastName}
            required
            autoComplete="family-name"
            dirty={dirtyFields.has('lastName')}
          />
        </div>

        <div className="mt-4">
          <EditField
            id="preferredName"
            label="Preferred name"
            value={form.preferredName}
            onChange={(v) => setField('preferredName', v)}
            hint="If left blank, we'll use your first name."
            autoComplete="nickname"
            dirty={dirtyFields.has('preferredName')}
          />
        </div>

        <div className="mt-4">
          <ReadOnlyField
            label="Email"
            value={profile.loginEmail}
            hint="Email changes need a separate verification flow."
          />
        </div>

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

        <AccountInfo profile={profile} personas={personas} />

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
      <StickySaveBar
        isDirty={isDirty}
        onSave={() => void doSave()}
        onDiscard={onDiscard}
        saving={update.isPending}
      />
    </SectionCard>
      {myPersonId && <FamilyStructureSection personId={myPersonId} variant="self" />}
    </div>
  );
}

/**
 * Read-only "Account info" block — created date + persona list. Shows
 * the user where they sit in the system without needing to open
 * /family or the persona switcher.
 */
function AccountInfo({
  profile,
  personas,
}: {
  profile: ProfileDto;
  personas: Array<{ type: string; schoolName?: string | null }>;
}) {
  const personaSummary = personas.length === 0
    ? 'No personas yet'
    : personas
        .map((p) =>
          p.schoolName ? `${humanPersona(p.type)} at ${p.schoolName}` : humanPersona(p.type),
        )
        .join(' · ');

  return (
    <div className="mt-5 rounded-md border border-gray-200 bg-gray-50/40 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        Account info
      </h3>
      <dl className="mt-2 space-y-1 text-sm">
        {profile.createdAt && (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-gray-500">Account created:</dt>
            <dd className="text-gray-900">{formatDate(profile.createdAt)}</dd>
          </div>
        )}
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-gray-500">Personas:</dt>
          <dd className="text-gray-900">{personaSummary}</dd>
        </div>
      </dl>
    </div>
  );
}

function humanPersona(type: string): string {
  const map: Record<string, string> = {
    PARENT: 'Parent',
    STUDENT: 'Student',
    STAFF: 'Staff',
    SUBSTITUTE: 'Substitute',
    ALUMNI: 'Alumnus',
    COMMUNITY: 'Community member',
  };
  return map[type] ?? type;
}

// ─── Contact tab ───────────────────────────────────────────

/**
 * Address-only Contact tab. The work-contact fields that used to
 * live here moved to the new Occupation tab in the previous commit
 * — keeping the surface focused on "where can the school reach you
 * physically" (home + mailing) rather than mixing in work fields.
 *
 * Two sections:
 *   - Home address with FAMILY/CUSTOM inheritance toggle (default
 *     FAMILY: pull from /family/settings).
 *   - Mailing address with same-as-home / different toggle. Default
 *     same — opt in only when mail goes to a separate place.
 */
function ContactTab({ profile }: { profile: ProfileDto }) {
  const { refreshUser } = useAuthActions();
  const { toast } = useToast();
  const update = useUpdateMyProfile();
  const familySettings = useFamilySettings();

  const initial = useMemo(
    () => ({
      addressSource: profile.addressSource,
      customAddressLine1: profile.customAddressLine1 ?? '',
      customAddressLine2: profile.customAddressLine2 ?? '',
      customCity: profile.customCity ?? '',
      customState: profile.customState ?? '',
      customPostalCode: profile.customPostalCode ?? '',
      customCountry: profile.customCountry ?? '',
      mailingAddressDifferent: profile.mailingAddressDifferent,
      customMailingLine1: profile.customMailingLine1 ?? '',
      customMailingLine2: profile.customMailingLine2 ?? '',
      customMailingCity: profile.customMailingCity ?? '',
      customMailingState: profile.customMailingState ?? '',
      customMailingPostalCode: profile.customMailingPostalCode ?? '',
      customMailingCountry: profile.customMailingCountry ?? '',
    }),
    [profile],
  );
  const [form, setForm] = useState(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  async function doSave() {
    if (!isDirty || update.isPending) return;
    try {
      await update.mutateAsync({
        addressSource: form.addressSource,
        customAddressLine1: form.customAddressLine1.trim() || null,
        customAddressLine2: form.customAddressLine2.trim() || null,
        customCity: form.customCity.trim() || null,
        customState: form.customState.trim() || null,
        customPostalCode: form.customPostalCode.trim() || null,
        customCountry: form.customCountry.trim() || null,
        mailingAddressDifferent: form.mailingAddressDifferent,
        // Blank mailing fields when the toggle is off so a previously-
        // saved override doesn't silently linger after the user opts back
        // to same-as-home. Matches the work-address clear-on-collapse
        // pattern from the Occupation tab.
        customMailingLine1: form.mailingAddressDifferent
          ? form.customMailingLine1.trim() || null
          : null,
        customMailingLine2: form.mailingAddressDifferent
          ? form.customMailingLine2.trim() || null
          : null,
        customMailingCity: form.mailingAddressDifferent
          ? form.customMailingCity.trim() || null
          : null,
        customMailingState: form.mailingAddressDifferent
          ? form.customMailingState.trim() || null
          : null,
        customMailingPostalCode: form.mailingAddressDifferent
          ? form.customMailingPostalCode.trim() || null
          : null,
        customMailingCountry: form.mailingAddressDifferent
          ? form.customMailingCountry.trim() || null
          : null,
      });
      await refreshUser();
      toast('Contact info saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void doSave();
  }

  const fs = familySettings.data;
  const familyAddressString = fs
    ? [
        [fs.addressLine1, fs.addressLine2].filter(Boolean).join(', '),
        [fs.city, fs.state, fs.postalCode].filter(Boolean).join(', '),
        fs.country,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {/* PhoneListCard + EmailListCard live OUTSIDE this <form> in
          their own cards — both lists persist immediately per-row
          (add/edit/delete fire their own mutations), so they don't
          share the address card's Save Changes button. Rendered as
          siblings here so the layout still reads top-to-bottom:
          phones → emails → home address → mailing address. */}
      <PhoneListCard />
      <EmailListCard />

      <SectionCard title="Home address">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-600">
            {form.addressSource === 'FAMILY'
              ? 'Using your family home address.'
              : 'Using a custom address for your profile.'}
          </p>
          <FamilyCustomToggle
            value={form.addressSource}
            onChange={(next) => setForm((f) => ({ ...f, addressSource: next }))}
            disabled={update.isPending}
          />
        </div>

        {form.addressSource === 'FAMILY' ? (
          <div className="rounded-md border border-gray-200 bg-gray-50/40 p-3 text-sm">
            {familySettings.isLoading ? (
              <p className="text-gray-500">Loading…</p>
            ) : !fs || !familyAddressString ? (
              <p className="text-gray-500">No family address on file yet.</p>
            ) : (
              <p className="text-gray-800">{familyAddressString}</p>
            )}
            <div className="mt-2">
              <Link
                href="/family/settings?tab=addresses"
                className="text-sm font-medium text-campus-700 hover:text-campus-600"
              >
                Edit family address →
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <EditField
              id="customAddressLine1"
              label="Street address"
              value={form.customAddressLine1}
              onChange={(v) => setForm((f) => ({ ...f, customAddressLine1: v }))}
              className="sm:col-span-2"
              dirty={dirtyFields.has('customAddressLine1')}
            />
            <EditField
              id="customAddressLine2"
              label="Apartment / unit"
              value={form.customAddressLine2}
              onChange={(v) => setForm((f) => ({ ...f, customAddressLine2: v }))}
              className="sm:col-span-2"
              dirty={dirtyFields.has('customAddressLine2')}
            />
            <EditField
              id="customCity"
              label="City"
              value={form.customCity}
              onChange={(v) => setForm((f) => ({ ...f, customCity: v }))}
              dirty={dirtyFields.has('customCity')}
            />
            <EditField
              id="customState"
              label="State / province"
              value={form.customState}
              onChange={(v) => setForm((f) => ({ ...f, customState: v }))}
              dirty={dirtyFields.has('customState')}
            />
            <EditField
              id="customPostalCode"
              label="ZIP / postal code"
              value={form.customPostalCode}
              onChange={(v) => setForm((f) => ({ ...f, customPostalCode: v }))}
              dirty={dirtyFields.has('customPostalCode')}
            />
            <EditField
              id="customCountry"
              label="Country"
              value={form.customCountry}
              onChange={(v) => setForm((f) => ({ ...f, customCountry: v }))}
              dirty={dirtyFields.has('customCountry')}
            />
          </div>
        )}
      </SectionCard>

      <SectionCard title="Mailing address">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.mailingAddressDifferent}
            onChange={(e) =>
              setForm((f) => ({ ...f, mailingAddressDifferent: e.target.checked }))
            }
            className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500"
          />
          Mailing address is different from home address
        </label>
        {form.mailingAddressDifferent ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <EditField
              id="customMailingLine1"
              label="Street address"
              value={form.customMailingLine1}
              onChange={(v) => setForm((f) => ({ ...f, customMailingLine1: v }))}
              className="sm:col-span-2"
              dirty={dirtyFields.has('customMailingLine1')}
            />
            <EditField
              id="customMailingLine2"
              label="Apartment / unit"
              value={form.customMailingLine2}
              onChange={(v) => setForm((f) => ({ ...f, customMailingLine2: v }))}
              className="sm:col-span-2"
              dirty={dirtyFields.has('customMailingLine2')}
            />
            <EditField
              id="customMailingCity"
              label="City"
              value={form.customMailingCity}
              onChange={(v) => setForm((f) => ({ ...f, customMailingCity: v }))}
              dirty={dirtyFields.has('customMailingCity')}
            />
            <EditField
              id="customMailingState"
              label="State / province"
              value={form.customMailingState}
              onChange={(v) => setForm((f) => ({ ...f, customMailingState: v }))}
              dirty={dirtyFields.has('customMailingState')}
            />
            <EditField
              id="customMailingPostalCode"
              label="ZIP / postal code"
              value={form.customMailingPostalCode}
              onChange={(v) => setForm((f) => ({ ...f, customMailingPostalCode: v }))}
              dirty={dirtyFields.has('customMailingPostalCode')}
            />
            <EditField
              id="customMailingCountry"
              label="Country"
              value={form.customMailingCountry}
              onChange={(v) => setForm((f) => ({ ...f, customMailingCountry: v }))}
              dirty={dirtyFields.has('customMailingCountry')}
            />
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-500">
            Mailing address is the same as your home address.
          </p>
        )}
      </SectionCard>

      <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      <StickySaveBar
        isDirty={isDirty}
        onSave={() => void doSave()}
        onDiscard={() => setForm(initial)}
        saving={update.isPending}
      />
    </form>
  );
}

// ─── Phone list card (used by Contact tab) ─────────────────

const PHONE_TYPES: Array<{ value: PersonPhoneType; label: string }> = [
  { value: 'CELL', label: 'Cell' },
  { value: 'HOME', label: 'Home' },
  { value: 'WORK', label: 'Work' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * Multi-phone list. Each row carries the number, a type dropdown,
 * a texts-allowed checkbox, a primary radio, and a delete button.
 * Mutations are per-row and persist immediately — there's no shared
 * Save button — because the rest of the form (address) is a single
 * transaction and the phone list would conflate "save now" with
 * "save the address too." Per-row writes keep the lists independent.
 *
 * The server keeps iam_person.primary_phone synced with the primary
 * row so existing surfaces (family page, EC table, /profile/me other
 * readers) keep working without joining this table.
 */
function PhoneListCard() {
  const { data, isLoading } = useMyPhones();
  const add = useAddMyPhone();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [draftNumber, setDraftNumber] = useState('');
  const [draftType, setDraftType] = useState<PersonPhoneType>('CELL');

  async function onAdd() {
    if (!draftNumber.trim()) {
      toast('Phone number is required.', 'error');
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
            <PhoneRow key={p.id} phone={p} canDelete={phones.length > 1} />
          ))}
        </ul>
      )}

      {addOpen ? (
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
                {PHONE_TYPES.map((t) => (
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
      )}
    </SectionCard>
  );
}

function PhoneRow({ phone, canDelete }: { phone: PersonPhoneDto; canDelete: boolean }) {
  const update = useUpdateMyPhone(phone.id);
  const remove = useDeleteMyPhone(phone.id);
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
        {editing ? (
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
            onClick={() => setEditing(true)}
            title="Edit phone number"
            className="text-base font-medium text-gray-900 hover:text-campus-700"
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
            disabled={update.isPending}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:opacity-60"
          >
            {PHONE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="inline-flex items-center gap-1 text-xs text-gray-700"
          title="Schools may send broadcast SMS to phones with this enabled."
        >
          <input
            type="checkbox"
            checked={phone.textsAllowed}
            onChange={(e) => void toggleField('textsAllowed', e.target.checked)}
            disabled={update.isPending}
            className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
          />
          💬 Texts OK
        </label>
        <label
          className="inline-flex items-center gap-1 text-xs text-gray-700"
          title="The default number schools and other surfaces use."
        >
          <input
            type="radio"
            name="primary-phone"
            checked={phone.isPrimary}
            onChange={() => void toggleField('isPrimary', true)}
            disabled={update.isPending || phone.isPrimary}
            className="h-4 w-4 border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
          />
          Primary
        </label>
        <span className="ml-auto">
          <button
            type="button"
            onClick={() => void onRemove()}
            disabled={!canDelete || remove.isPending}
            title={canDelete ? 'Remove this phone' : 'Add another phone before removing this one.'}
            aria-label="Remove phone"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-200 bg-white text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            🗑
          </button>
        </span>
      </div>
    </li>
  );
}

// ─── Email list card (used by Contact tab) ─────────────────

const EMAIL_TYPES: Array<{ value: PersonEmailType; label: string }> = [
  { value: 'PERSONAL', label: 'Personal' },
  { value: 'WORK', label: 'Work' },
  { value: 'SCHOOL', label: 'School' },
  { value: 'OTHER', label: 'Other' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Multi-email list. Mirrors PhoneListCard's per-row mutation shape —
 * adding / changing type / flipping primary / deleting persists
 * immediately so the card is independent of the address-card's Save
 * Changes button. The server keeps platform_person_emails as the
 * source of truth for "contact email" across the family roster and
 * the completion checker; the login email (platform_users.email)
 * stays separate and is read-only here.
 */
function EmailListCard() {
  const { data, isLoading } = useMyEmails();
  const add = useAddMyEmail();
  const { toast } = useToast();
  const loginEmail = useAuthStore((s) => s.user?.email ?? null);
  const [addOpen, setAddOpen] = useState(false);
  const [draftEmail, setDraftEmail] = useState('');
  const [draftType, setDraftType] = useState<PersonEmailType>('PERSONAL');

  async function onAdd() {
    const trimmed = draftEmail.trim();
    if (!trimmed) {
      toast('Enter an email first.', 'error');
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
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

  const emails = data ?? [];

  return (
    <SectionCard title="Email addresses">
      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : emails.length === 0 && !addOpen ? (
        <p className="text-sm text-gray-500">No emails on file yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {emails.map((e) => (
            <EmailRow key={e.id} email={e} canDelete={emails.length > 1} />
          ))}
        </ul>
      )}

      {addOpen ? (
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-700">Email address</label>
              <input
                type="email"
                value={draftEmail}
                onChange={(e) => setDraftEmail(e.target.value)}
                placeholder="you@example.com"
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
                {EMAIL_TYPES.map((t) => (
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
      )}

      {loginEmail && (
        <p className="mt-3 text-xs text-gray-500">
          Your login email (<span className="font-medium text-gray-700">{loginEmail}</span>) is
          managed in Account settings — changing your primary contact email here doesn’t change
          how you sign in.
        </p>
      )}
    </SectionCard>
  );
}

function EmailRow({ email, canDelete }: { email: PersonEmailDto; canDelete: boolean }) {
  const update = useUpdateMyEmail(email.id);
  const remove = useDeleteMyEmail(email.id);
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
            disabled={update.isPending}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:opacity-60"
          >
            {EMAIL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="inline-flex items-center gap-1 text-xs text-gray-700"
          title="The default email schools and other surfaces use."
        >
          <input
            type="radio"
            name="primary-email"
            checked={email.isPrimary}
            onChange={() => void toggleField('isPrimary', true)}
            disabled={update.isPending || email.isPrimary}
            className="h-4 w-4 border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
          />
          Primary
        </label>
        <span className="ml-auto">
          <button
            type="button"
            onClick={() => void onRemove()}
            disabled={!canDelete || remove.isPending}
            title={canDelete ? 'Remove this email' : 'Add another email before removing this one.'}
            aria-label="Remove email"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-200 bg-white text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            🗑
          </button>
        </span>
      </div>
    </li>
  );
}

// ─── Occupation tab ────────────────────────────────────────

const EMPLOYMENT_STATUSES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Not Specified' },
  { value: 'EMPLOYED_FULL_TIME', label: 'Employed full-time' },
  { value: 'EMPLOYED_PART_TIME', label: 'Employed part-time' },
  { value: 'SELF_EMPLOYED', label: 'Self-employed' },
  { value: 'STAY_AT_HOME_PARENT', label: 'Stay-at-home parent' },
  { value: 'RETIRED', label: 'Retired' },
  { value: 'UNEMPLOYED', label: 'Unemployed' },
  { value: 'STUDENT', label: 'Student' },
];

// Statuses that have employer / industry / job title / work
// location. Everything else (Retired, Unemployed, Stay-at-home
// parent, Student, Not Specified) shows only the Additional
// information notes — a retired grandparent might note "available
// for pickup anytime", a student might note their schedule.
const EMPLOYED_STATUSES = new Set([
  'EMPLOYED_FULL_TIME',
  'EMPLOYED_PART_TIME',
  'SELF_EMPLOYED',
]);

const WORK_LOCATION_TYPES: Array<{ value: WorkLocationType; label: string }> = [
  { value: 'OFFICE', label: 'Office / On-site' },
  { value: 'REMOTE', label: 'Remote' },
  { value: 'HYBRID', label: 'Hybrid' },
];

const INDUSTRIES = [
  'Education',
  'Healthcare',
  'Technology',
  'Finance',
  'Legal',
  'Government',
  'Retail',
  'Manufacturing',
  'Construction',
  'Agriculture',
  'Transportation',
  'Hospitality',
  'Non-profit',
  'Military',
  'Other',
];

/**
 * Employment + work-contact fields. Schools use this to understand
 * parent availability and to know where to reach a parent during
 * work hours. The work address is optional — gated behind a single
 * checkbox so the form stays short for the common case.
 */
function OccupationTab({ profile }: { profile: ProfileDto }) {
  const { toast } = useToast();
  const update = useUpdateMyProfile();

  const initial = useMemo(
    () => ({
      employmentStatus: profile.employmentStatus ?? '',
      employer: profile.employer ?? '',
      jobTitle: profile.jobTitle ?? '',
      industry: profile.industry ?? '',
      workLocationType: (profile.workLocationType ?? '') as WorkLocationType | '',
      workAddressLine1: profile.workAddressLine1 ?? '',
      workAddressLine2: profile.workAddressLine2 ?? '',
      workCity: profile.workCity ?? '',
      workState: profile.workState ?? '',
      workPostalCode: profile.workPostalCode ?? '',
      workCountry: profile.workCountry ?? '',
      occupationNotes: profile.occupationNotes ?? '',
    }),
    [profile],
  );
  const [form, setForm] = useState(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => {
    setForm(initial);
  }, [initial]);

  // Status drives field visibility. "Employed" statuses surface the
  // full employment + work-location surface; everything else collapses
  // to just the Additional information notes field. We compute it
  // from the form value so the UI switches the moment the dropdown
  // changes, not only after save.
  const isEmployed = EMPLOYED_STATUSES.has(form.employmentStatus);
  // Work-location radio. OFFICE / HYBRID render the address grid;
  // REMOTE hides it and shows a "no address needed" note. HYBRID
  // adds a "this is your primary office" hint above the grid.
  const showWorkAddress =
    isEmployed &&
    (form.workLocationType === 'OFFICE' || form.workLocationType === 'HYBRID');

  async function doSave() {
    if (!isDirty || update.isPending) return;
    try {
      await update.mutateAsync({
        employmentStatus: form.employmentStatus || null,
        // Non-employed statuses null out the employment surface so a
        // user who switches from EMPLOYED → RETIRED doesn't leave a
        // stale employer / title / industry on file. The address
        // columns follow the same logic; the workLocationType column
        // gets nulled too so the saved value matches the rendered UI.
        employer: isEmployed ? form.employer.trim() || null : null,
        jobTitle: isEmployed ? form.jobTitle.trim() || null : null,
        industry: isEmployed ? form.industry || null : null,
        workLocationType: isEmployed && form.workLocationType ? form.workLocationType : null,
        workAddressLine1: showWorkAddress ? form.workAddressLine1.trim() || null : null,
        workAddressLine2: showWorkAddress ? form.workAddressLine2.trim() || null : null,
        workCity: showWorkAddress ? form.workCity.trim() || null : null,
        workState: showWorkAddress ? form.workState.trim() || null : null,
        workPostalCode: showWorkAddress ? form.workPostalCode.trim() || null : null,
        workCountry: showWorkAddress ? form.workCountry.trim() || null : null,
        occupationNotes: form.occupationNotes.trim() || null,
      });
      toast('Occupation saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void doSave();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <SectionCard title="Employment">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={isEmployed ? undefined : 'sm:col-span-2'}>
            <label htmlFor="employmentStatus" className="block text-xs font-medium text-gray-700">
              Employment status
              {dirtyFields.has('employmentStatus') && <DirtyDot />}
            </label>
            <select
              id="employmentStatus"
              value={form.employmentStatus}
              onChange={(e) => setForm((f) => ({ ...f, employmentStatus: e.target.value }))}
              className={cn(
                'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500',
                dirtyFields.has('employmentStatus')
                  ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
                  : 'border border-gray-300',
              )}
            >
              {EMPLOYMENT_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          {isEmployed && (
            <>
              <div>
                <label htmlFor="industry" className="block text-xs font-medium text-gray-700">
                  Industry
                  {dirtyFields.has('industry') && <DirtyDot />}
                </label>
                <select
                  id="industry"
                  value={form.industry}
                  onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))}
                  className={cn(
                    'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500',
                    dirtyFields.has('industry')
                      ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
                      : 'border border-gray-300',
                  )}
                >
                  <option value="">— Not specified —</option>
                  {INDUSTRIES.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </div>
              <EditField
                id="employer"
                label="Employer / company"
                value={form.employer}
                onChange={(v) => setForm((f) => ({ ...f, employer: v }))}
                autoComplete="organization"
                dirty={dirtyFields.has('employer')}
              />
              <EditField
                id="jobTitle"
                label="Job title / position"
                value={form.jobTitle}
                onChange={(v) => setForm((f) => ({ ...f, jobTitle: v }))}
                autoComplete="organization-title"
                dirty={dirtyFields.has('jobTitle')}
              />
            </>
          )}
        </div>
      </SectionCard>

      {isEmployed && (
        <SectionCard title="Work location">
          <fieldset>
            <legend className="sr-only">Work location</legend>
            <div className="flex flex-col gap-2">
              {WORK_LOCATION_TYPES.map((opt) => (
                <label
                  key={opt.value}
                  className="inline-flex items-center gap-2 text-sm text-gray-900"
                >
                  <input
                    type="radio"
                    name="workLocationType"
                    value={opt.value}
                    checked={form.workLocationType === opt.value}
                    onChange={() =>
                      setForm((f) => ({ ...f, workLocationType: opt.value }))
                    }
                    className="h-4 w-4 border-gray-300 text-campus-700 focus:ring-campus-500"
                  />
                  <span>{opt.label}</span>
                  {dirtyFields.has('workLocationType') &&
                    form.workLocationType === opt.value && <DirtyDot />}
                </label>
              ))}
            </div>
          </fieldset>

          {form.workLocationType === 'REMOTE' && (
            <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
              Works remotely — no office address needed.
            </p>
          )}

          {form.workLocationType === 'HYBRID' && (
            <p className="mt-3 text-xs text-gray-500">Enter your primary office location.</p>
          )}

          {showWorkAddress && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <EditField
                id="workAddressLine1"
                label="Street address"
                value={form.workAddressLine1}
                onChange={(v) => setForm((f) => ({ ...f, workAddressLine1: v }))}
                className="sm:col-span-2"
                dirty={dirtyFields.has('workAddressLine1')}
              />
              <EditField
                id="workAddressLine2"
                label="Suite / floor"
                value={form.workAddressLine2}
                onChange={(v) => setForm((f) => ({ ...f, workAddressLine2: v }))}
                className="sm:col-span-2"
                dirty={dirtyFields.has('workAddressLine2')}
              />
              <EditField
                id="workCity"
                label="City"
                value={form.workCity}
                onChange={(v) => setForm((f) => ({ ...f, workCity: v }))}
                dirty={dirtyFields.has('workCity')}
              />
              <EditField
                id="workState"
                label="State / province"
                value={form.workState}
                onChange={(v) => setForm((f) => ({ ...f, workState: v }))}
                dirty={dirtyFields.has('workState')}
              />
              <EditField
                id="workPostalCode"
                label="ZIP / postal code"
                value={form.workPostalCode}
                onChange={(v) => setForm((f) => ({ ...f, workPostalCode: v }))}
                dirty={dirtyFields.has('workPostalCode')}
              />
              <EditField
                id="workCountry"
                label="Country"
                value={form.workCountry}
                onChange={(v) => setForm((f) => ({ ...f, workCountry: v }))}
                dirty={dirtyFields.has('workCountry')}
              />
            </div>
          )}

          <p className="mt-3 text-xs text-gray-500">
            Schools use this to understand your availability and may use it as an emergency
            contact during work hours.
          </p>
        </SectionCard>
      )}

      <SectionCard title="Additional information">
        <label htmlFor="occupationNotes" className="block text-xs font-medium text-gray-700">
          Notes
          {dirtyFields.has('occupationNotes') && <DirtyDot />}
        </label>
        <textarea
          id="occupationNotes"
          value={form.occupationNotes}
          onChange={(e) =>
            setForm((f) => ({ ...f, occupationNotes: e.target.value.slice(0, OCCUPATION_NOTES_MAX) }))
          }
          rows={4}
          maxLength={OCCUPATION_NOTES_MAX}
          placeholder="Share anything relevant for the school — shift schedules, availability during school hours, preferred contact times, travel schedule, or other notes."
          className={cn(
            'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500',
            dirtyFields.has('occupationNotes')
              ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
              : 'border border-gray-300',
          )}
        />
        <p className="mt-1 flex items-center justify-between text-xs text-gray-500">
          <span>
            Share anything relevant for the school — shift schedules, availability during school
            hours, preferred contact times, travel schedule, or other notes.
          </span>
          <span
            className={cn(
              'ml-2 shrink-0 tabular-nums',
              form.occupationNotes.length >= OCCUPATION_NOTES_MAX && 'text-red-600',
            )}
            aria-live="polite"
          >
            {form.occupationNotes.length} / {OCCUPATION_NOTES_MAX}
          </span>
        </p>
      </SectionCard>

      <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      <StickySaveBar
        isDirty={isDirty}
        onSave={() => void doSave()}
        onDiscard={() => setForm(initial)}
        saving={update.isPending}
      />
    </form>
  );
}

const OCCUPATION_NOTES_MAX = 500;

function DirtyDot() {
  return (
    <span
      aria-label="Modified"
      title="Modified — save to keep this change"
      className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
    />
  );
}

// ─── Medical tab ───────────────────────────────────────────

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

/**
 * Mirrors the child Medical tab — source toggle + doctor/insurance
 * + allergies/medications/conditions cards. Everything optional;
 * the medical info is useful for staff field-trip planning and
 * emergency-responder context but not required.
 */
function MedicalTab({ profile: _profile }: { profile: ProfileDto }) {
  const { data, isLoading } = useMyMedical();
  const update = useUpdateMyMedical();
  const { toast } = useToast();

  const [source, setSource] = useState<'FAMILY' | 'CUSTOM'>('FAMILY');
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

  async function flipSource(next: 'FAMILY' | 'CUSTOM') {
    if (next === source) return;
    try {
      await update.mutateAsync({ medicalSource: next });
      setSource(next);
      toast(
        next === 'FAMILY' ? 'Now using family doctor & insurance' : 'Switched to your own doctor',
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change source.', 'error');
    }
  }

  async function saveDoctor() {
    try {
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
      setDoctorDirty(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  function onDiscardDoctor() {
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
    <SectionCard
      title="Medical & Health"
      description="Optional. Useful for staff field-trip planning, school events, and emergency responders."
    >
      <AdultAllergiesCard
        items={data.allergies}
        onChange={(next) => void commitList('allergies', next, 'Allergies updated')}
        busy={update.isPending}
      />
      <AdultMedicationsCard
        items={data.medications}
        onChange={(next) => void commitList('medications', next, 'Medications updated')}
        busy={update.isPending}
      />
      <AdultConditionsCard
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
            familyLabel="Use family"
            customLabel="Use my own"
          />
        </div>

        {source === 'FAMILY' ? (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 text-sm text-gray-700">
              <ReadOnlyInline label="Doctor name" value={doctor.name} />
              <ReadOnlyInline label="Doctor phone" value={formatPhone(doctor.phone)} />
              <div className="sm:col-span-2">
                <ReadOnlyInline label="Clinic" value={doctor.clinic} />
              </div>
              <ReadOnlyInline label="Insurance provider" value={doctor.insuranceProvider} />
              <ReadOnlyInline label="Policy number" value={doctor.insurancePolicy} />
              <ReadOnlyInline label="Group number" value={doctor.insuranceGroup} />
            </div>
            <div className="mt-3">
              <Link
                href="/family/settings?tab=health"
                className="text-sm font-medium text-campus-700 hover:text-campus-600"
              >
                Edit family medical info →
              </Link>
            </div>
          </>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <EditField id="docName" label="Doctor name" value={doctor.name} onChange={(v) => patchDoctor('name', v)} />
            <div>
              <label htmlFor="docPhone" className="block text-xs font-medium text-gray-700">
                Doctor phone
              </label>
              <PhoneInput
                id="docPhone"
                value={doctor.phone}
                onChange={(raw) => patchDoctor('phone', raw)}
              />
            </div>
            <EditField id="docClinic" label="Clinic" value={doctor.clinic} onChange={(v) => patchDoctor('clinic', v)} className="sm:col-span-2" />
            <EditField id="insProv" label="Insurance provider" value={doctor.insuranceProvider} onChange={(v) => patchDoctor('insuranceProvider', v)} />
            <EditField id="insPolicy" label="Policy number" value={doctor.insurancePolicy} onChange={(v) => patchDoctor('insurancePolicy', v)} />
            <EditField id="insGroup" label="Group number" value={doctor.insuranceGroup} onChange={(v) => patchDoctor('insuranceGroup', v)} />
          </div>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <EditField id="bloodType" label="Blood type" value={doctor.bloodType} onChange={(v) => patchDoctor('bloodType', v)} />
        </div>
        <div className="mt-3">
          <label className="block text-xs font-medium text-gray-700">Medical notes</label>
          <textarea
            value={doctor.medicalNotes}
            onChange={(e) => patchDoctor('medicalNotes', e.target.value)}
            rows={3}
            placeholder="Anything school nurses, coaches, or emergency responders should know…"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          />
        </div>
      </div>
      <StickySaveBar
        isDirty={doctorDirty}
        onSave={() => void saveDoctor()}
        onDiscard={onDiscardDoctor}
        saving={update.isPending}
      />
    </SectionCard>
  );
}

function ReadOnlyInline({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-700">{label}</p>
      <p className="mt-1 text-sm text-gray-900">{value && value.trim() ? value : <span className="text-gray-400">—</span>}</p>
    </div>
  );
}

function AdultAllergiesCard({
  items,
  onChange,
  busy,
}: {
  items: AdultAllergyEntry[];
  onChange: (next: AdultAllergyEntry[]) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<AdultAllergyEntry>({ name: '', severity: 'MILD', type: 'FOOD' });
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
          <button type="button" onClick={() => setShowAdd(true)} className="text-sm font-medium text-campus-700 hover:text-campus-600">
            + Add allergy
          </button>
        )}
      </div>
      {items.length === 0 && !showAdd ? (
        <p className="mt-2 text-xs text-gray-500">No allergies recorded.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((a, i) => (
            <li key={a.name + i} className="flex items-center justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm">
              <span>
                <span className="font-medium text-gray-900">{a.name}</span>
                {a.severity && (
                  <span className="ml-2 text-xs text-gray-500">
                    {ALLERGY_SEVERITIES.find((s) => s.value === a.severity)?.label}
                  </span>
                )}
                {a.type && <span className="ml-2 text-xs text-gray-400">({a.type.toLowerCase()})</span>}
              </span>
              <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={busy} className="text-xs text-red-700 hover:text-red-800 disabled:opacity-60">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {showAdd && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Allergy (e.g. Peanuts)" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 sm:col-span-2" />
          <select value={draft.severity ?? 'MILD'} onChange={(e) => setDraft({ ...draft, severity: e.target.value as AdultAllergyEntry['severity'] })} className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500">
            {ALLERGY_SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select value={draft.type ?? 'FOOD'} onChange={(e) => setDraft({ ...draft, type: e.target.value as AdultAllergyEntry['type'] })} className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500">
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

function AdultMedicationsCard({
  items,
  onChange,
  busy,
}: {
  items: AdultMedicationEntry[];
  onChange: (next: AdultMedicationEntry[]) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<AdultMedicationEntry>({ name: '', dosage: '', frequency: '', prescriber: '' });
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
          <input type="text" value={draft.dosage ?? ''} onChange={(e) => setDraft({ ...draft, dosage: e.target.value })} placeholder="Dosage" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500" />
          <input type="text" value={draft.frequency ?? ''} onChange={(e) => setDraft({ ...draft, frequency: e.target.value })} placeholder="Frequency" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500" />
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

function AdultConditionsCard({
  items,
  onChange,
  busy,
}: {
  items: AdultConditionEntry[];
  onChange: (next: AdultConditionEntry[]) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<AdultConditionEntry>({ name: '', diagnosedDate: '', notes: '' });
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
          <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Condition" className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 sm:col-span-2" />
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

// ─── About tab ─────────────────────────────────────────────

const BIO_MAX = 500;

/**
 * Bio + interests + languages. Bio is a single free-text field
 * (500 char limit, hint shows live counter). Interests and
 * languages are tag lists — each tag is just a string, rendered as
 * a chip with × to remove + an inline "+ Add" input. The arrays
 * persist via the same PATCH /profile/me as the rest of the page.
 */
function AboutTab({ profile }: { profile: ProfileDto }) {
  const { toast } = useToast();
  const update = useUpdateMyProfile();

  const initial = useMemo(
    () => ({
      bio: profile.bio ?? '',
      interests: profile.interests ?? [],
      languages: profile.languages ?? [],
    }),
    [profile.bio, profile.interests, profile.languages],
  );
  const [form, setForm] = useState(initial);
  // useFormDirty doesn't deep-compare arrays — fall back to a manual
  // check that's good enough for tag lists.
  const isDirty =
    form.bio !== initial.bio ||
    !arrayEq(form.interests, initial.interests) ||
    !arrayEq(form.languages, initial.languages);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  async function onSave() {
    if (!isDirty || update.isPending) return;
    try {
      await update.mutateAsync({
        bio: form.bio.trim() || null,
        interests: form.interests,
        languages: form.languages,
      });
      toast('About saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionCard title="Bio">
        <textarea
          id="bio"
          value={form.bio}
          onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value.slice(0, BIO_MAX) }))}
          rows={4}
          maxLength={BIO_MAX}
          placeholder="Tell schools a bit about yourself."
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
        />
        <p className="mt-1 text-right text-xs text-gray-500">
          {form.bio.length} / {BIO_MAX}
        </p>
      </SectionCard>

      <SectionCard
        title="Interests & skills"
        description="Useful for volunteer matching, coaching, guest speaking, and parent-school collaboration."
      >
        <TagList
          items={form.interests}
          onChange={(next) => setForm((f) => ({ ...f, interests: next }))}
          placeholder="e.g. Robotics coaching, photography, mentoring…"
          addLabel="+ Add interest or skill"
        />
      </SectionCard>

      <SectionCard
        title="Languages spoken"
        description="Helps schools route translation needs and parent communication."
      >
        <TagList
          items={form.languages}
          onChange={(next) => setForm((f) => ({ ...f, languages: next }))}
          placeholder="e.g. English, Spanish, ASL…"
          addLabel="+ Add language"
        />
      </SectionCard>

      <StickySaveBar
        isDirty={isDirty}
        onSave={() => void onSave()}
        onDiscard={() => setForm(initial)}
        saving={update.isPending}
      />
    </div>
  );
}

function TagList({
  items,
  onChange,
  placeholder,
  addLabel,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
}) {
  const [draft, setDraft] = useState('');

  function commitDraft() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (items.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...items, trimmed]);
    setDraft('');
  }

  return (
    <div>
      {items.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <li
              key={item + i}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-sm text-gray-800"
            >
              <span>{item}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                aria-label={'Remove ' + item}
                className="-mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-xs text-gray-500 hover:bg-gray-200 hover:text-gray-800"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          placeholder={placeholder}
          className="block flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
        />
        <button
          type="button"
          onClick={commitDraft}
          disabled={!draft.trim()}
          className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60"
        >
          {addLabel}
        </button>
      </div>
    </div>
  );
}

function arrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Primitives ────────────────────────────────────────────

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

function EditField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  required,
  hint,
  error,
  autoComplete,
  dirty,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  autoComplete?: string;
  dirty?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
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
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        autoComplete={autoComplete}
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

function ReadOnlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-700">{label}</p>
      <p className="mt-1 text-sm text-gray-900">
        {value && value.trim() ? value : <span className="text-gray-400">—</span>}
      </p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Family connection ─────────────────────────────────────

/**
 * Self-service surface for the bidirectional family-link feature.
 * The page doesn't know whether the caller is already LINKED into a
 * family (there's no endpoint that resolves "am I a child somewhere?"
 * yet), so we always show both options. If the user is already linked,
 * the accept endpoint surfaces a 400 inline.
 *
 * The final commit of this series gates this section behind "user has
 * no PARENT persona" — parents manage at /family, only children/
 * students should see these cards. For now the section is unconditional.
 */
function FamilyConnectionSection() {
  return (
    <section className="mt-6 rounded-card border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Family connection</h2>
      <p className="mt-1 text-xs text-gray-600">
        Connect your account to a parent&rsquo;s family, or hand them a code so they can connect
        you.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <GenerateChildCodeBlock />
        <EnterParentCodeBlock />
      </div>
    </section>
  );
}

function GenerateChildCodeBlock() {
  const generate = useGenerateChildCode();
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const { toast } = useToast();

  async function onClick() {
    if (code) return;
    try {
      const r = await generate.mutateAsync();
      setCode(r.code);
      setExpiresAt(r.expiresAt);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not generate a code. Please try again.';
      toast(message, 'error');
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('Code copied', 'success');
    } catch {
      toast("Couldn't copy. Select the code and copy manually.", 'error');
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-gray-200 bg-gray-50/40 p-3">
      <p className="text-sm font-medium text-gray-900">Generate a code for your parent</p>
      <p className="text-xs text-gray-600">
        Your parent enters this code on CampusOS to add you to their family.
      </p>
      {!code ? (
        <button
          type="button"
          onClick={() => void onClick()}
          disabled={generate.isPending}
          className="mt-1 inline-flex w-fit items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60"
        >
          {generate.isPending ? 'Generating…' : 'Generate code'}
        </button>
      ) : (
        <>
          <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-2">
            <code className="font-mono text-base font-semibold tracking-[0.2em] text-gray-900">
              {code}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex items-center rounded-md bg-campus-700 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-campus-600"
            >
              Copy
            </button>
          </div>
          {expiresAt && (
            <p className="text-xs text-gray-500">
              Expires{' '}
              {new Date(expiresAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}

function EnterParentCodeBlock() {
  const accept = useAcceptFamilyLink();
  const { refreshUser } = useAuthActions();
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase().replace(/-/g, '');
    if (trimmed.length !== 8) {
      setError('Codes are 8 characters.');
      return;
    }
    setError(null);
    try {
      await accept.mutateAsync({ code: trimmed });
      await refreshUser();
      toast("You're connected to your family", 'success');
      setCode('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError('Invalid or expired code.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Try again in a few minutes.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError('That code can’t link here. You may already be connected.');
      } else {
        setError('Could not link. Please try again.');
      }
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-gray-200 bg-gray-50/40 p-3">
      <p className="text-sm font-medium text-gray-900">Enter a parent&rsquo;s family code</p>
      <p className="text-xs text-gray-600">
        Use the 8-character code your parent generated to join their family.
      </p>
      <form onSubmit={onSubmit} className="mt-1 flex gap-2">
        <input
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
          className={
            'block flex-1 rounded-md border bg-white px-3 py-2 font-mono text-sm uppercase tracking-wider text-gray-900 ' +
            'shadow-sm placeholder:font-mono placeholder:text-gray-300 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
            (error ? 'border-red-300' : 'border-gray-300')
          }
        />
        <button
          type="submit"
          disabled={accept.isPending}
          className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
        >
          {accept.isPending && <LoadingSpinner size="sm" />}
          <span>{accept.isPending ? 'Linking…' : 'Link'}</span>
        </button>
      </form>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
