'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  useAddFamilyEmergencyContact,
  useDeleteFamilyEmergencyContact,
  useFamilyEmergencyContacts,
  useFamilySettings,
  useUpdateFamilySettings,
  type FamilyEmergencyContactDto,
  type FamilySettingsDto,
  type UpdateFamilySettingsPayload,
} from '@/hooks/use-family-children';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import { useBeforeUnloadOnDirty, useFormDirty } from '@/hooks/use-form-dirty';
import { cn } from '@/components/ui/cn';

/**
 * /family/settings — household-wide shared attributes. Children
 * inherit display name, address, doctor, and insurance from this
 * record by default; per-child overrides ship in the next commit
 * (inheritance toggle).
 *
 * Read-only for child viewers; the API's canEdit flag drives the
 * input disabled state and the assertNotChildViewer guard in the
 * service is the authoritative server-side block.
 */
export default function FamilySettingsPage() {
  const { data, isLoading, error } = useFamilySettings();
  const update = useUpdateFamilySettings();
  const { toast } = useToast();

  const [form, setForm] = useState<UpdateFamilySettingsPayload>({});
  const [initial, setInitial] = useState<UpdateFamilySettingsPayload>({});
  // Cast to a plain Record so the hook can iterate keys uniformly —
  // UpdateFamilySettingsPayload has many narrow optional fields but
  // the dirty diff only cares about per-key equality.
  const { isDirty, dirtyFields } = useFormDirty(
    form as Record<string, unknown>,
    initial as Record<string, unknown>,
  );
  useBeforeUnloadOnDirty(isDirty);

  useEffect(() => {
    if (!data) return;
    const snapshot: UpdateFamilySettingsPayload = {
      displayName: data.displayName ?? '',
      addressLine1: data.addressLine1 ?? '',
      addressLine2: data.addressLine2 ?? '',
      city: data.city ?? '',
      state: data.state ?? '',
      postalCode: data.postalCode ?? '',
      country: data.country ?? '',
      homePhone: data.homePhone ?? '',
      doctorName: data.doctorName ?? '',
      doctorPhone: data.doctorPhone ?? '',
      doctorClinic: data.doctorClinic ?? '',
      insuranceProvider: data.insuranceProvider ?? '',
      insurancePolicy: data.insurancePolicy ?? '',
      insuranceGroup: data.insuranceGroup ?? '',
    };
    setForm(snapshot);
    setInitial(snapshot);
  }, [data]);

  if (isLoading) return <PageLoader label="Loading family settings…" />;
  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <BackLink />
        <p className="mt-4 text-sm text-red-600">Could not load family settings.</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <BackLink />
        <p className="mt-4 text-sm text-gray-600">No family record yet.</p>
      </div>
    );
  }

  const editable = data.canEdit;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || !isDirty) return;
    try {
      await update.mutateAsync(form);
      toast('Family settings saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <BackLink />
      <header className="mt-2 mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">Family Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Shared across your whole family. Children inherit these by default.
        </p>
        {!editable && (
          <p className="mt-2 text-xs text-amber-700">
            Read-only view — only a parent or guardian of this family can edit these fields.
          </p>
        )}
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <PrimaryContactCard data={data} />

        <Card title="Family name">
          <Field
            id="displayName"
            label="Display name"
            value={form.displayName ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, displayName: v }))}
            placeholder='e.g. "The Tromsness Family"'
            disabled={!editable}
            hint="Used in invitations and the family-page heading. Leave blank to use the household last name."
              dirty={dirtyFields.has('displayName')}
          />
        </Card>

        <Card title="Primary address">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="addressLine1"
              label="Street address"
              value={form.addressLine1 ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, addressLine1: v }))}
              disabled={!editable}
              className="sm:col-span-2"
              dirty={dirtyFields.has('addressLine1')}
            />
            <Field
              id="addressLine2"
              label="Apartment / unit"
              value={form.addressLine2 ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, addressLine2: v }))}
              disabled={!editable}
              className="sm:col-span-2"
              dirty={dirtyFields.has('addressLine2')}
            />
            <Field
              id="city"
              label="City"
              value={form.city ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, city: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('city')}
            />
            <Field
              id="state"
              label="State / province"
              value={form.state ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, state: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('state')}
            />
            <Field
              id="postalCode"
              label="ZIP / postal code"
              value={form.postalCode ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, postalCode: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('postalCode')}
            />
            <Field
              id="country"
              label="Country"
              value={form.country ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, country: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('country')}
            />
            <Field
              id="homePhone"
              label="Home phone"
              type="tel"
              value={form.homePhone ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, homePhone: v }))}
              disabled={!editable}
              className="sm:col-span-2"
              dirty={dirtyFields.has('homePhone')}
            />
          </div>
        </Card>

        <Card title="Family doctor">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="doctorName"
              label="Doctor name"
              value={form.doctorName ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, doctorName: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('doctorName')}
            />
            <Field
              id="doctorPhone"
              label="Doctor phone"
              type="tel"
              value={form.doctorPhone ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, doctorPhone: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('doctorPhone')}
            />
            <Field
              id="doctorClinic"
              label="Clinic"
              value={form.doctorClinic ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, doctorClinic: v }))}
              disabled={!editable}
              className="sm:col-span-2"
              dirty={dirtyFields.has('doctorClinic')}
            />
          </div>
        </Card>

        <Card title="Family insurance">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="insuranceProvider"
              label="Provider"
              value={form.insuranceProvider ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, insuranceProvider: v }))}
              disabled={!editable}
              className="sm:col-span-2"
              dirty={dirtyFields.has('insuranceProvider')}
            />
            <Field
              id="insurancePolicy"
              label="Policy number"
              value={form.insurancePolicy ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, insurancePolicy: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('insurancePolicy')}
            />
            <Field
              id="insuranceGroup"
              label="Group number"
              value={form.insuranceGroup ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, insuranceGroup: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('insuranceGroup')}
            />
          </div>
        </Card>

        {editable && (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!isDirty || update.isPending}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
            >
              {update.isPending && <LoadingSpinner size="sm" />}
              <span>{update.isPending ? 'Saving…' : 'Save Changes'}</span>
            </button>
          </div>
        )}
      </form>

      <div className="mt-5">
        <FamilyEmergencyContactsCard editable={editable} />
      </div>
    </div>
  );
}

/**
 * Family-level emergency contacts. Lives outside the main settings
 * <form> because list-shape data (add / edit / remove rows) doesn't
 * round-trip through a single Save Changes button — each row mutation
 * persists on its own.
 */
function FamilyEmergencyContactsCard({ editable }: { editable: boolean }) {
  const { data, isLoading } = useFamilyEmergencyContacts();
  const add = useAddFamilyEmergencyContact();
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
      setDraft({
        name: '',
        relationship: '',
        phonePrimary: '',
        phoneAlternate: '',
        email: '',
        authorizedPickup: false,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the contact.', 'error');
    }
  }

  const contacts = data ?? [];
  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-gray-900">Family emergency contacts</h2>
      <p className="mb-4 text-xs text-gray-500">
        Shared with every child whose Contact tab is set to inherit from family. Per-child
        overrides live on each child&rsquo;s Contact tab.
      </p>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : contacts.length === 0 && !showAdd ? (
        <p className="text-sm text-gray-500">No family emergency contacts yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {contacts.map((c, i) => (
            <FamilyEmergencyContactRow
              key={c.id}
              contact={c}
              index={i + 1}
              editable={editable}
            />
          ))}
        </ul>
      )}

      {editable &&
        (showAdd ? (
          <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 p-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <SettingsField
                label="Name"
                value={draft.name}
                onChange={(v) => setDraft({ ...draft, name: v })}
                required
              />
              <SettingsField
                label="Relationship"
                value={draft.relationship}
                onChange={(v) => setDraft({ ...draft, relationship: v })}
                placeholder="Spouse, Grandparent…"
                required
              />
              <SettingsField
                label="Primary phone"
                value={draft.phonePrimary}
                onChange={(v) => setDraft({ ...draft, phonePrimary: v })}
                required
              />
              <SettingsField
                label="Alternate phone"
                value={draft.phoneAlternate}
                onChange={(v) => setDraft({ ...draft, phoneAlternate: v })}
              />
              <SettingsField
                label="Email"
                value={draft.email}
                onChange={(v) => setDraft({ ...draft, email: v })}
                className="sm:col-span-2"
              />
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
              <button
                type="button"
                onClick={() => setShowAdd(false)}
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
                <span>{add.isPending ? 'Adding…' : 'Add Contact'}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="text-sm font-medium text-campus-700 hover:text-campus-600"
            >
              + Add contact
            </button>
          </div>
        ))}
    </section>
  );
}

function FamilyEmergencyContactRow({
  contact,
  index,
  editable,
}: {
  contact: FamilyEmergencyContactDto;
  index: number;
  editable: boolean;
}) {
  const remove = useDeleteFamilyEmergencyContact(contact.id);
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
          {contact.phoneAlternate && (
            <span className="text-gray-500"> · {contact.phoneAlternate}</span>
          )}
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
      {editable && (
        <button
          type="button"
          onClick={() => void onRemove()}
          disabled={remove.isPending}
          className="text-xs text-red-700 hover:text-red-800 disabled:opacity-60"
        >
          {remove.isPending ? 'Removing…' : 'Remove'}
        </button>
      )}
    </li>
  );
}

function SettingsField({
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

function BackLink() {
  return (
    <Link
      href="/family"
      className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700"
    >
      ← My Family
    </Link>
  );
}

function PrimaryContactCard({ data }: { data: FamilySettingsDto }) {
  return (
    <div className="rounded-card border border-gray-200 bg-gray-50/40 p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Primary point of contact</h2>
      {data.primaryContactName ? (
        <p className="mt-1 text-sm text-gray-700">
          <span className="font-medium">{data.primaryContactName}</span> is currently the primary
          contact for your family. Use the{' '}
          <Link href="/family" className="text-campus-700 hover:text-campus-600">
            Parents &amp; Guardians
          </Link>{' '}
          section to change who&rsquo;s primary.
        </p>
      ) : (
        <p className="mt-1 text-sm text-gray-700">
          No primary contact assigned. Visit{' '}
          <Link href="/family" className="text-campus-700 hover:text-campus-600">
            Parents &amp; Guardians
          </Link>{' '}
          to designate one.
        </p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  disabled,
  className,
  dirty,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
  dirty?: boolean;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
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
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
          dirty
            ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
            : 'border border-gray-300',
        )}
      />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

