'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useAddHouseholdMember,
  useMyHousehold,
  useRemoveHouseholdMember,
  useUpdateHousehold,
  useUpdateHouseholdMember,
  useUpdateMyProfile,
  useUpdateProfile,
} from '@/hooks/use-profile';
import {
  HOUSEHOLD_ROLES,
  HOUSEHOLD_ROLE_LABELS,
  PHONE_TYPES,
  PHONE_TYPE_LABELS,
  profileCompleteness,
} from '@/lib/profile-format';
import type {
  HouseholdDto,
  HouseholdRole,
  PhoneType,
  ProfileDto,
  UpdateAdminProfilePayload,
  UpdateProfilePayload,
} from '@/lib/types';

type Props = {
  profile: ProfileDto;
  isAdminView: boolean;
};

export function PersonalInfoTab({ profile, isAdminView }: Props) {
  const updateMy = useUpdateMyProfile();
  const updateAdmin = useUpdateProfile(profile.personId);
  const { toast } = useToast();

  const [middleName, setMiddleName] = useState(profile.middleName ?? '');
  const [preferredName, setPreferredName] = useState(profile.preferredName ?? '');
  const [suffix, setSuffix] = useState(profile.suffix ?? '');
  const [previousNamesText, setPreviousNamesText] = useState(
    (profile.previousNames ?? []).join(', '),
  );
  const [primaryPhone, setPrimaryPhone] = useState(profile.primaryPhone ?? '');
  const [phoneTypePrimary, setPhoneTypePrimary] = useState<PhoneType | ''>(
    profile.phoneTypePrimary ?? '',
  );
  const [secondaryPhone, setSecondaryPhone] = useState(profile.secondaryPhone ?? '');
  const [phoneTypeSecondary, setPhoneTypeSecondary] = useState<PhoneType | ''>(
    profile.phoneTypeSecondary ?? '',
  );
  const [workPhone, setWorkPhone] = useState(profile.workPhone ?? '');
  const [personalEmail, setPersonalEmail] = useState(profile.personalEmail ?? '');
  const [preferredLanguage, setPreferredLanguage] = useState(profile.preferredLanguage);
  const [notes, setNotes] = useState(profile.notes ?? '');

  // Admin-only identity fields
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [dateOfBirth, setDateOfBirth] = useState(profile.dateOfBirth ?? '');

  const requirePrimaryPhone = !!profile.primaryPhone;
  const primaryPhoneInvalid = requirePrimaryPhone && primaryPhone.trim() === '';

  const dirty =
    middleName !== (profile.middleName ?? '') ||
    preferredName !== (profile.preferredName ?? '') ||
    suffix !== (profile.suffix ?? '') ||
    previousNamesText !== (profile.previousNames ?? []).join(', ') ||
    primaryPhone !== (profile.primaryPhone ?? '') ||
    phoneTypePrimary !== (profile.phoneTypePrimary ?? '') ||
    secondaryPhone !== (profile.secondaryPhone ?? '') ||
    phoneTypeSecondary !== (profile.phoneTypeSecondary ?? '') ||
    workPhone !== (profile.workPhone ?? '') ||
    personalEmail !== (profile.personalEmail ?? '') ||
    preferredLanguage !== profile.preferredLanguage ||
    notes !== (profile.notes ?? '') ||
    (isAdminView &&
      (firstName !== profile.firstName ||
        lastName !== profile.lastName ||
        dateOfBirth !== (profile.dateOfBirth ?? '')));

  const onSave = async () => {
    if (primaryPhoneInvalid) {
      toast('Primary phone is required', 'error');
      return;
    }
    const previousNames = previousNamesText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const payload: UpdateProfilePayload & UpdateAdminProfilePayload = {
      middleName: middleName || null,
      preferredName: preferredName || null,
      suffix: suffix || null,
      previousNames,
      primaryPhone: primaryPhone || null,
      phoneTypePrimary: phoneTypePrimary || null,
      secondaryPhone: secondaryPhone || null,
      phoneTypeSecondary: phoneTypeSecondary || null,
      workPhone: workPhone || null,
      personalEmail: personalEmail || null,
      preferredLanguage,
      notes: notes || null,
    };
    if (isAdminView) {
      payload.firstName = firstName;
      payload.lastName = lastName;
      payload.dateOfBirth = dateOfBirth || null;
    }
    try {
      if (isAdminView) await updateAdmin.mutateAsync(payload);
      else await updateMy.mutateAsync(payload);
      toast('Profile updated', 'success');
    } catch (err) {
      toast((err as { message?: string }).message ?? 'Save failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <Section title="Name">
        <Field label={isAdminView ? 'First name *' : 'First name (read-only)'}>
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            disabled={!isAdminView}
          />
        </Field>
        <Field label="Middle name">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={middleName} onChange={(e) => setMiddleName(e.target.value)} />
        </Field>
        <Field label={isAdminView ? 'Last name *' : 'Last name (read-only)'}>
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            disabled={!isAdminView}
          />
        </Field>
        <Field label="Suffix" hint="Jr, Sr, III, etc.">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={suffix} onChange={(e) => setSuffix(e.target.value)} />
        </Field>
        <Field label="Preferred name" hint="What should we call you?">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={preferredName}
            onChange={(e) => setPreferredName(e.target.value)}
          />
        </Field>
        <Field label="Previous names" hint="Comma-separated, e.g. maiden name">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={previousNamesText}
            onChange={(e) => setPreviousNamesText(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Contact">
        <Field label={requirePrimaryPhone ? 'Primary phone *' : 'Primary phone'}>
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={primaryPhone}
            onChange={(e) => setPrimaryPhone(e.target.value)}
          />
          {primaryPhoneInvalid && (
            <p className="mt-1 text-xs text-rose-600">Primary phone is required.</p>
          )}
        </Field>
        <Field label="Primary phone type">
          <PhoneTypeSelect value={phoneTypePrimary} onChange={setPhoneTypePrimary} />
        </Field>
        <Field label="Secondary phone">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={secondaryPhone}
            onChange={(e) => setSecondaryPhone(e.target.value)}
          />
        </Field>
        <Field label="Secondary phone type">
          <PhoneTypeSelect value={phoneTypeSecondary} onChange={setPhoneTypeSecondary} />
        </Field>
        <Field label="Work phone">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={workPhone} onChange={(e) => setWorkPhone(e.target.value)} />
        </Field>
        <Field label="Personal email" hint="Distinct from your login email below">
          <input
            type="email"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={personalEmail}
            onChange={(e) => setPersonalEmail(e.target.value)}
          />
        </Field>
      </Section>

      {isAdminView && (
        <Section title="Identity (admin only)">
          <Field label="Date of birth">
            <input
              type="date"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
            />
          </Field>
        </Section>
      )}

      <Section title="Preferences">
        <Field label="Preferred language">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={preferredLanguage}
            onChange={(e) => setPreferredLanguage(e.target.value)}
          />
        </Field>
        <Field label="Notes" hint="Private to you and admins">
          <textarea
            className="min-h-[80px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </Section>

      <SaveBar
        dirty={dirty}
        loading={updateMy.isPending || updateAdmin.isPending}
        onSave={onSave}
      />
    </div>
  );
}

export function HouseholdTab({ profile, isAdminView }: Props) {
  // The /profile/me path uses /households/my; for admin view of another
  // person, we'd ideally fetch their household by id, but the current
  // backend doesn't expose a GET /households/by-person/:personId. The
  // composed profile already includes household membership summary, so
  // for now the admin view of someone else just renders the summary
  // read-only with a hint. The owning user can edit from /profile/me.
  const myHousehold = useMyHousehold(!isAdminView);
  const summary = profile.household;
  const fullHousehold = isAdminView ? null : myHousehold.data ?? null;

  if (isAdminView) {
    if (!summary) {
      return (
        <p className="text-sm text-gray-500">
          {profile.firstName} is not currently a member of a household.
        </p>
      );
    }
    return (
      <div className="rounded-card border border-gray-200 bg-white p-5">
        <p className="text-sm font-semibold text-gray-900">{summary.name ?? 'Household'}</p>
        <p className="mt-1 text-sm text-gray-600">
          {profile.firstName} is {HOUSEHOLD_ROLE_LABELS[summary.role]}
          {summary.isPrimaryContact ? ' · primary contact' : ''}.
        </p>
        <p className="mt-3 text-xs text-gray-500">
          Admins can&apos;t edit another person&apos;s household here. The household members manage
          shared details from their own profile.
        </p>
      </div>
    );
  }

  if (myHousehold.isLoading)
    return <p className="text-sm text-gray-500">Loading household…</p>;
  if (!fullHousehold)
    return (
      <p className="text-sm text-gray-500">
        You&apos;re not currently a member of a household.
      </p>
    );

  return <HouseholdEditor household={fullHousehold} />;
}

function HouseholdEditor({ household }: { household: HouseholdDto }) {
  const update = useUpdateHousehold(household.id);
  const removeMember = useRemoveHouseholdMember(household.id);
  const { toast } = useToast();

  const [name, setName] = useState(household.name ?? '');
  const [addressLine1, setAddressLine1] = useState(household.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(household.addressLine2 ?? '');
  const [city, setCity] = useState(household.city ?? '');
  const [stateField, setStateField] = useState(household.state ?? '');
  const [postalCode, setPostalCode] = useState(household.postalCode ?? '');
  const [country, setCountry] = useState(household.country ?? '');
  const [homePhone, setHomePhone] = useState(household.homePhone ?? '');
  const [homeLanguage, setHomeLanguage] = useState(household.homeLanguage);
  const [mailingAddressSame, setMailingAddressSame] = useState(household.mailingAddressSame);
  const [notes, setNotes] = useState(household.notes ?? '');
  const [showAdd, setShowAdd] = useState(false);

  // Reset on household change.
  useEffect(() => {
    setName(household.name ?? '');
    setAddressLine1(household.addressLine1 ?? '');
    setAddressLine2(household.addressLine2 ?? '');
    setCity(household.city ?? '');
    setStateField(household.state ?? '');
    setPostalCode(household.postalCode ?? '');
    setCountry(household.country ?? '');
    setHomePhone(household.homePhone ?? '');
    setHomeLanguage(household.homeLanguage);
    setMailingAddressSame(household.mailingAddressSame);
    setNotes(household.notes ?? '');
  }, [household]);

  const dirty =
    name !== (household.name ?? '') ||
    addressLine1 !== (household.addressLine1 ?? '') ||
    addressLine2 !== (household.addressLine2 ?? '') ||
    city !== (household.city ?? '') ||
    stateField !== (household.state ?? '') ||
    postalCode !== (household.postalCode ?? '') ||
    country !== (household.country ?? '') ||
    homePhone !== (household.homePhone ?? '') ||
    homeLanguage !== household.homeLanguage ||
    mailingAddressSame !== household.mailingAddressSame ||
    notes !== (household.notes ?? '');

  const onSave = async () => {
    try {
      await update.mutateAsync({
        name: name || null,
        addressLine1: addressLine1 || null,
        addressLine2: addressLine2 || null,
        city: city || null,
        state: stateField || null,
        postalCode: postalCode || null,
        country: country || null,
        homePhone: homePhone || null,
        homeLanguage,
        mailingAddressSame,
        notes: notes || null,
      });
      toast('Household updated', 'success');
    } catch (err) {
      toast((err as { message?: string }).message ?? 'Save failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <Section title="Household">
        <Field label="Household name" hint='e.g. "The Chen Family"'>
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={name}
            disabled={!household.canEdit}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Shared address">
        <Field label="Address line 1">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={addressLine1}
            disabled={!household.canEdit}
            onChange={(e) => setAddressLine1(e.target.value)}
          />
        </Field>
        <Field label="Address line 2">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={addressLine2}
            disabled={!household.canEdit}
            onChange={(e) => setAddressLine2(e.target.value)}
          />
        </Field>
        <Field label="City">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={city}
            disabled={!household.canEdit}
            onChange={(e) => setCity(e.target.value)}
          />
        </Field>
        <Field label="State / region">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={stateField}
            disabled={!household.canEdit}
            onChange={(e) => setStateField(e.target.value)}
          />
        </Field>
        <Field label="Postal code">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={postalCode}
            disabled={!household.canEdit}
            onChange={(e) => setPostalCode(e.target.value)}
          />
        </Field>
        <Field label="Country">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={country}
            disabled={!household.canEdit}
            onChange={(e) => setCountry(e.target.value)}
          />
        </Field>
        <Field label="Home phone">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={homePhone}
            disabled={!household.canEdit}
            onChange={(e) => setHomePhone(e.target.value)}
          />
        </Field>
        <Field label="Home language">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={homeLanguage}
            disabled={!household.canEdit}
            onChange={(e) => setHomeLanguage(e.target.value)}
          />
        </Field>
        <label className="col-span-full mt-2 flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={mailingAddressSame}
            disabled={!household.canEdit}
            onChange={(e) => setMailingAddressSame(e.target.checked)}
          />
          Mailing address is the same as the home address
        </label>
        <Field label="Notes" hint="Visible to household members and admins">
          <textarea
            className="min-h-[80px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={notes}
            disabled={!household.canEdit}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Members">
        <ul className="col-span-full divide-y divide-gray-100 rounded-card border border-gray-200">
          {household.members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {m.preferredName ?? m.firstName} {m.lastName}
                </p>
                <p className="text-xs text-gray-500">
                  {HOUSEHOLD_ROLE_LABELS[m.role]}
                  {m.isPrimaryContact ? ' · primary contact' : ''}
                </p>
              </div>
              {household.canEdit && (
                <MemberInlineActions
                  householdId={household.id}
                  memberId={m.id}
                  role={m.role}
                  isPrimaryContact={m.isPrimaryContact}
                  onRemove={async () => {
                    if (!confirm(`Remove ${m.firstName} from the household?`)) return;
                    try {
                      await removeMember.mutateAsync(m.id);
                      toast(`${m.firstName} removed from household`, 'success');
                    } catch (err) {
                      toast((err as { message?: string }).message ?? 'Remove failed', 'error');
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        {household.canEdit && (
          <div className="col-span-full">
            <button
              type="button"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
              onClick={() => setShowAdd(true)}
            >
              Add household member
            </button>
          </div>
        )}
      </Section>

      <SaveBar
        dirty={dirty}
        disabled={!household.canEdit}
        loading={update.isPending}
        onSave={onSave}
      />

      <AddMemberModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        householdId={household.id}
      />
    </div>
  );
}

function MemberInlineActions({
  householdId,
  memberId,
  role,
  isPrimaryContact,
  onRemove,
}: {
  householdId: string;
  memberId: string;
  role: HouseholdRole;
  isPrimaryContact: boolean;
  onRemove: () => void;
}) {
  const update = useUpdateHouseholdMember(householdId, memberId);
  const { toast } = useToast();
  const [r, setR] = useState<HouseholdRole>(role);
  const [primary, setPrimary] = useState(isPrimaryContact);

  useEffect(() => {
    setR(role);
    setPrimary(isPrimaryContact);
  }, [role, isPrimaryContact]);

  const dirty = r !== role || primary !== isPrimaryContact;
  return (
    <div className="flex items-center gap-2">
      <select
        className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
        value={r}
        onChange={(e) => setR(e.target.value as HouseholdRole)}
      >
        {HOUSEHOLD_ROLES.map((opt) => (
          <option key={opt} value={opt}>
            {HOUSEHOLD_ROLE_LABELS[opt]}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={primary}
          onChange={(e) => setPrimary(e.target.checked)}
        />
        Primary
      </label>
      <button
        type="button"
        disabled={!dirty || update.isPending}
        className="rounded-md bg-campus-600 px-2 py-1 text-xs font-medium text-white hover:bg-campus-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        onClick={async () => {
          try {
            await update.mutateAsync({
              role: r,
              isPrimaryContact: primary,
            });
            toast('Member updated', 'success');
          } catch (err) {
            toast((err as { message?: string }).message ?? 'Save failed', 'error');
          }
        }}
      >
        Save
      </button>
      <button type="button" className="text-xs text-rose-600 hover:underline" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

function AddMemberModal({
  open,
  onClose,
  householdId,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
}) {
  const add = useAddHouseholdMember(householdId);
  const { toast } = useToast();
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState<HouseholdRole>('OTHER');

  return (
    <Modal open={open} onClose={onClose} title="Add household member">
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          Enter the person&apos;s ID to add them to your household. (A directory picker is a future
          improvement.)
        </p>
        <Field label="Person ID *">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            placeholder="UUID"
          />
        </Field>
        <Field label="Role *">
          <select
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={role}
            onChange={(e) => setRole(e.target.value as HouseholdRole)}
          >
            {HOUSEHOLD_ROLES.map((opt) => (
              <option key={opt} value={opt}>
                {HOUSEHOLD_ROLE_LABELS[opt]}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-campus-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            disabled={!personId || add.isPending}
            onClick={async () => {
              try {
                await add.mutateAsync({ personId, role });
                toast('Member added', 'success');
                setPersonId('');
                setRole('OTHER');
                onClose();
              } catch (err) {
                toast((err as { message?: string }).message ?? 'Add failed', 'error');
              }
            }}
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function EmergencyContactTab({ profile, isAdminView }: Props) {
  const updateMy = useUpdateMyProfile();
  const updateAdmin = useUpdateProfile(profile.personId);
  const { toast } = useToast();
  const ec = profile.emergencyContact;
  const [name, setName] = useState(ec?.name ?? '');
  const [relationship, setRelationship] = useState(ec?.relationship ?? '');
  const [phone, setPhone] = useState(ec?.phone ?? '');
  const [email, setEmail] = useState(ec?.email ?? '');

  useEffect(() => {
    setName(profile.emergencyContact?.name ?? '');
    setRelationship(profile.emergencyContact?.relationship ?? '');
    setPhone(profile.emergencyContact?.phone ?? '');
    setEmail(profile.emergencyContact?.email ?? '');
  }, [profile.emergencyContact]);

  const supportedPersona =
    profile.personType === 'STAFF' || profile.personType === 'STUDENT';
  if (!supportedPersona) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Emergency contacts are recorded in school records for staff and students. Guardians and
        other personas don&apos;t have an emergency contact stored here yet — this is a planned
        Phase 2 polish item.
      </div>
    );
  }

  const dirty =
    name !== (ec?.name ?? '') ||
    relationship !== (ec?.relationship ?? '') ||
    phone !== (ec?.phone ?? '') ||
    email !== (ec?.email ?? '');

  const onSave = async () => {
    if (!name.trim()) {
      toast('Name is required', 'error');
      return;
    }
    const payload: UpdateProfilePayload = {
      emergencyContact: {
        name: name.trim(),
        relationship: relationship || null,
        phone: phone || null,
        email: email || null,
        isPrimary: true,
      },
    };
    try {
      if (isAdminView) await updateAdmin.mutateAsync(payload);
      else await updateMy.mutateAsync(payload);
      toast('Emergency contact saved', 'success');
    } catch (err) {
      toast((err as { message?: string }).message ?? 'Save failed', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Whom should we contact in an emergency related to {profile.preferredName ?? profile.firstName}?
      </p>
      <Section title="Contact">
        <Field label="Name *">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Relationship">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
          />
        </Field>
        <Field label="Phone">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        {profile.personType === 'STAFF' && (
          <Field label="Email">
            <input
              type="email"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        )}
      </Section>
      <SaveBar
        dirty={dirty}
        loading={updateMy.isPending || updateAdmin.isPending}
        onSave={onSave}
      />
    </div>
  );
}

export function DemographicsTab({ profile, isAdminView }: Props) {
  const updateMy = useUpdateMyProfile();
  const updateAdmin = useUpdateProfile(profile.personId);
  const { toast } = useToast();
  const d = profile.demographics;
  const [primaryLanguage, setPrimaryLanguage] = useState(d?.primaryLanguage ?? '');
  const [gender, setGender] = useState(d?.gender ?? '');
  const [ethnicity, setEthnicity] = useState(d?.ethnicity ?? '');
  const [birthCountry, setBirthCountry] = useState(d?.birthCountry ?? '');
  const [citizenship, setCitizenship] = useState(d?.citizenship ?? '');
  const [medicalAlertNotes, setMedicalAlertNotes] = useState(d?.medicalAlertNotes ?? '');

  useEffect(() => {
    setPrimaryLanguage(profile.demographics?.primaryLanguage ?? '');
    setGender(profile.demographics?.gender ?? '');
    setEthnicity(profile.demographics?.ethnicity ?? '');
    setBirthCountry(profile.demographics?.birthCountry ?? '');
    setCitizenship(profile.demographics?.citizenship ?? '');
    setMedicalAlertNotes(profile.demographics?.medicalAlertNotes ?? '');
  }, [profile.demographics]);

  const dirty =
    primaryLanguage !== (d?.primaryLanguage ?? '') ||
    (isAdminView &&
      (gender !== (d?.gender ?? '') ||
        ethnicity !== (d?.ethnicity ?? '') ||
        birthCountry !== (d?.birthCountry ?? '') ||
        citizenship !== (d?.citizenship ?? '') ||
        medicalAlertNotes !== (d?.medicalAlertNotes ?? '')));

  const onSave = async () => {
    const payload: UpdateAdminProfilePayload = {
      primaryLanguage: primaryLanguage || null,
    };
    if (isAdminView) {
      payload.gender = gender || null;
      payload.ethnicity = ethnicity || null;
      payload.birthCountry = birthCountry || null;
      payload.citizenship = citizenship || null;
      payload.medicalAlertNotes = medicalAlertNotes || null;
    }
    try {
      if (isAdminView) await updateAdmin.mutateAsync(payload);
      else await updateMy.mutateAsync(payload);
      toast('Demographics saved', 'success');
    } catch (err) {
      toast((err as { message?: string }).message ?? 'Save failed', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Demographics">
        <Field label="Date of birth (read-only)">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={profile.dateOfBirth ?? ''} disabled />
        </Field>
        <Field
          label={isAdminView ? 'Gender' : 'Gender (admin only)'}
          hint={isAdminView ? undefined : 'Contact your administrator to update'}
        >
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={gender}
            disabled={!isAdminView}
            onChange={(e) => setGender(e.target.value)}
          />
        </Field>
        <Field label={isAdminView ? 'Ethnicity' : 'Ethnicity (admin only)'}>
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={ethnicity}
            disabled={!isAdminView}
            onChange={(e) => setEthnicity(e.target.value)}
          />
        </Field>
        <Field label="Primary language">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={primaryLanguage}
            onChange={(e) => setPrimaryLanguage(e.target.value)}
          />
        </Field>
        <Field label={isAdminView ? 'Birth country' : 'Birth country (admin only)'}>
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={birthCountry}
            disabled={!isAdminView}
            onChange={(e) => setBirthCountry(e.target.value)}
          />
        </Field>
        <Field label={isAdminView ? 'Citizenship' : 'Citizenship (admin only)'}>
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={citizenship}
            disabled={!isAdminView}
            onChange={(e) => setCitizenship(e.target.value)}
          />
        </Field>
        <Field
          label={isAdminView ? 'Medical alert notes' : 'Medical alert notes (admin only)'}
          hint="Brief flag for substitute teachers (e.g. EpiPen in nurse's office)"
        >
          <textarea
            className="min-h-[60px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={medicalAlertNotes}
            disabled={!isAdminView}
            onChange={(e) => setMedicalAlertNotes(e.target.value)}
          />
        </Field>
      </Section>
      <SaveBar
        dirty={dirty}
        loading={updateMy.isPending || updateAdmin.isPending}
        onSave={onSave}
      />
    </div>
  );
}

export function EmploymentTab({ profile, isAdminView }: Props) {
  const updateMy = useUpdateMyProfile();
  const updateAdmin = useUpdateProfile(profile.personId);
  const { toast } = useToast();
  const e = profile.employment;
  const [employer, setEmployer] = useState(e?.employer ?? '');
  const [employerPhone, setEmployerPhone] = useState(e?.employerPhone ?? '');
  const [occupation, setOccupation] = useState(e?.occupation ?? '');
  const [workAddress, setWorkAddress] = useState(e?.workAddress ?? '');

  useEffect(() => {
    setEmployer(profile.employment?.employer ?? '');
    setEmployerPhone(profile.employment?.employerPhone ?? '');
    setOccupation(profile.employment?.occupation ?? '');
    setWorkAddress(profile.employment?.workAddress ?? '');
  }, [profile.employment]);

  const dirty =
    employer !== (e?.employer ?? '') ||
    employerPhone !== (e?.employerPhone ?? '') ||
    occupation !== (e?.occupation ?? '') ||
    workAddress !== (e?.workAddress ?? '');

  const onSave = async () => {
    const payload: UpdateProfilePayload = {
      employer: employer || null,
      employerPhone: employerPhone || null,
      occupation: occupation || null,
      workAddress: workAddress || null,
    };
    try {
      if (isAdminView) await updateAdmin.mutateAsync(payload);
      else await updateMy.mutateAsync(payload);
      toast('Employment saved', 'success');
    } catch (err) {
      toast((err as { message?: string }).message ?? 'Save failed', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Employment">
        <Field label="Employer">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={employer} onChange={(ev) => setEmployer(ev.target.value)} />
        </Field>
        <Field label="Employer phone">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={employerPhone}
            onChange={(ev) => setEmployerPhone(ev.target.value)}
          />
        </Field>
        <Field label="Occupation">
          <input
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={occupation}
            onChange={(ev) => setOccupation(ev.target.value)}
          />
        </Field>
        <Field label="Work address">
          <textarea
            className="min-h-[60px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500"
            value={workAddress}
            onChange={(ev) => setWorkAddress(ev.target.value)}
          />
        </Field>
      </Section>
      <SaveBar
        dirty={dirty}
        loading={updateMy.isPending || updateAdmin.isPending}
        onSave={onSave}
      />
    </div>
  );
}

export function AccountTab({ profile }: Props) {
  const completeness = useMemo(() => profileCompleteness(profile), [profile]);
  const keycloakUrl = process.env.NEXT_PUBLIC_KEYCLOAK_URL;

  return (
    <div className="space-y-6">
      <Section title="Login">
        <Field label="Login email" hint="Managed by your school's identity provider">
          <input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={profile.loginEmail ?? ''} disabled />
        </Field>
        <Field label="Password">
          {keycloakUrl ? (
            <a
              className="inline-block rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
              href={`${keycloakUrl}/realms/campusos/account`}
              target="_blank"
              rel="noreferrer"
            >
              Change password →
            </a>
          ) : (
            <p className="text-sm text-gray-500">
              Password changes happen in your school&apos;s identity provider.
            </p>
          )}
        </Field>
      </Section>
      <Section title="Profile completeness">
        <div className="col-span-full">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-gray-900">{completeness}% complete</span>
            <span className="text-xs text-gray-500">
              Filling in optional fields helps the school reach you when needed.
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-campus-600 transition-all"
              style={{ width: `${completeness}%` }}
            />
          </div>
        </div>
      </Section>
      {profile.profileUpdatedAt && (
        <p className="text-xs text-gray-500">
          Last updated {new Date(profile.profileUpdatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

// ── Shared layout helpers ──────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-700">{label}</span>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </label>
  );
}

function PhoneTypeSelect({
  value,
  onChange,
}: {
  value: PhoneType | '';
  onChange: (v: PhoneType | '') => void;
}) {
  return (
    <select className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 disabled:bg-gray-50 disabled:text-gray-500" value={value} onChange={(e) => onChange(e.target.value as PhoneType | '')}>
      <option value="">—</option>
      {PHONE_TYPES.map((t) => (
        <option key={t} value={t}>
          {PHONE_TYPE_LABELS[t]}
        </option>
      ))}
    </select>
  );
}

function SaveBar({
  dirty,
  disabled,
  loading,
  onSave,
}: {
  dirty: boolean;
  disabled?: boolean;
  loading: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex justify-end pt-2">
      <button
        type="button"
        className={cn(
          'inline-flex items-center rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-campus-700 disabled:cursor-not-allowed disabled:bg-gray-300',
          !dirty && 'opacity-50',
        )}
        disabled={!dirty || disabled || loading}
        onClick={onSave}
      >
        {loading ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
