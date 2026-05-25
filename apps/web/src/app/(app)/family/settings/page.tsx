'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  useAddFamilyEmergencyContact,
  useDeleteFamilyEmergencyContact,
  useFamilyEmergencyContacts,
  useFamilySettings,
  useFamilyView,
  useUpdateFamilySettings,
  type FamilyEmergencyContactDto,
  type FamilyMemberDto,
  type FamilySettingsDto,
  type UpdateFamilySettingsPayload,
} from '@/hooks/use-family-children';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import { useBeforeUnloadOnDirty, useFormDirty } from '@/hooks/use-form-dirty';
import { cn } from '@/components/ui/cn';

/**
 * /family/settings — tabbed layout for household-wide attributes.
 *
 * Four tabs (URL-synced via ?tab=…):
 *   Family             — display name + primary contact + member roster
 *   Addresses          — home + optional separate mailing address
 *   Emergency Contacts — family-level shared list (enhanced in a
 *                        later commit with priority arrows + linked
 *                        user search; today the card carries add/
 *                        remove only).
 *   Health & Insurance — family doctor + insurance + medical notes
 *
 * Each tab is an independent form with its own dirty-state diff +
 * Save Changes button. Switching tabs while dirty keeps the form
 * state in memory (no per-tab cancel/discard); the next switch in
 * preserves any in-flight edits. Browser-level navigate-away
 * prompts come from useBeforeUnloadOnDirty.
 *
 * Read-only mode (canEdit=false) — when the API resolves the caller
 * as a CHILD viewer of someone else's family. The PATCH endpoint
 * returns 403 in that case; this page mirrors by hiding Save
 * buttons and disabling every input.
 */
export default function FamilySettingsPage() {
  const { data, isLoading, error } = useFamilySettings();
  const familyView = useFamilyView();

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

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Hero settings={data} />
      <Tabs settings={data} members={familyView.data?.members ?? []} />
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────

function Hero({ settings }: { settings: FamilySettingsDto }) {
  const heroName = settings.displayName?.trim() || 'Your Family';
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">{heroName}</h1>
          <p className="mt-1 text-sm text-gray-500">
            Family settings and shared information.
          </p>
        </div>
        {!settings.canEdit && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
            Read-only
          </span>
        )}
      </div>
      <BackLink className="mt-3" />
    </header>
  );
}

function BackLink({ className }: { className?: string }) {
  return (
    <Link
      href="/family"
      className={cn(
        'inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700',
        className,
      )}
    >
      ← My Family
    </Link>
  );
}

// ─── Tab bar + routing ────────────────────────────────────

type TabKey = 'family' | 'addresses' | 'emergency' | 'health';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'family', label: 'Family' },
  { key: 'addresses', label: 'Addresses' },
  { key: 'emergency', label: 'Emergency Contacts' },
  { key: 'health', label: 'Health & Insurance' },
];

function isTabKey(s: string | null): s is TabKey {
  return s !== null && TABS.some((t) => t.key === s);
}

function Tabs({
  settings,
  members,
}: {
  settings: FamilySettingsDto;
  members: FamilyMemberDto[];
}) {
  const searchParams = useSearchParams();
  const initial = searchParams?.get('tab');
  const [active, setActive] = useState<TabKey>(
    isTabKey(initial ?? null) ? (initial as TabKey) : 'family',
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
      <nav className="border-b border-gray-200" aria-label="Family settings tabs">
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

      <div className="mt-6">
        {active === 'family' && <FamilyTab settings={settings} members={members} />}
        {active === 'addresses' && <AddressesTab settings={settings} />}
        {active === 'emergency' && <EmergencyTab editable={settings.canEdit} />}
        {active === 'health' && <HealthTab settings={settings} />}
      </div>
    </>
  );
}

// ─── Family tab ────────────────────────────────────────────

function FamilyTab({
  settings,
  members,
}: {
  settings: FamilySettingsDto;
  members: FamilyMemberDto[];
}) {
  const update = useUpdateFamilySettings();
  const { toast } = useToast();

  const initial = useMemo(
    () => ({
      displayName: settings.displayName ?? '',
      primaryContactPersonId: settings.primaryContactPersonId ?? '',
    }),
    [settings.displayName, settings.primaryContactPersonId],
  );
  const [form, setForm] = useState(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  const editable = settings.canEdit;
  // Only ACTIVE members (already linked to an iam_person) can be
  // promoted to primary contact — PLACEHOLDER / PENDING_INVITE rows
  // have no person_id and would fail the service-side membership
  // check anyway.
  const eligibleContacts = members.filter((m) => m.status === 'ACTIVE' && m.personId);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || !isDirty) return;
    try {
      const payload: UpdateFamilySettingsPayload = {};
      if (form.displayName !== initial.displayName) payload.displayName = form.displayName;
      if (
        form.primaryContactPersonId !== initial.primaryContactPersonId &&
        form.primaryContactPersonId
      ) {
        payload.primaryContactPersonId = form.primaryContactPersonId;
      }
      await update.mutateAsync(payload);
      toast('Family settings saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <Card title="Family name">
        <Field
          id="displayName"
          label="Display name"
          value={form.displayName}
          onChange={(v) => setForm((f) => ({ ...f, displayName: v }))}
          placeholder='e.g. "The Tromsness Family"'
          disabled={!editable}
          hint="Displayed on your family page and shared with schools."
          dirty={dirtyFields.has('displayName')}
        />
      </Card>

      <Card title="Primary contact">
        {eligibleContacts.length === 0 ? (
          <p className="text-sm text-gray-600">
            No connected guardians yet. Add or invite a guardian on{' '}
            <Link href="/family" className="text-campus-700 hover:text-campus-600">
              the family page
            </Link>{' '}
            to designate one.
          </p>
        ) : (
          <div>
            <label
              htmlFor="primaryContactPersonId"
              className="block text-xs font-medium text-gray-700"
            >
              Primary contact
              {dirtyFields.has('primaryContactPersonId') && (
                <span
                  aria-label="Modified"
                  title="Modified — save to keep this change"
                  className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
                />
              )}
            </label>
            <select
              id="primaryContactPersonId"
              value={form.primaryContactPersonId}
              onChange={(e) =>
                setForm((f) => ({ ...f, primaryContactPersonId: e.target.value }))
              }
              disabled={!editable}
              className={cn(
                'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
                dirtyFields.has('primaryContactPersonId')
                  ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
                  : 'border border-gray-300',
              )}
            >
              <option value="">— Not set —</option>
              {eligibleContacts.map((m) => {
                const name =
                  (m.preferredName?.trim() ? m.preferredName : null) ||
                  [m.firstName, m.lastName].filter(Boolean).join(' ') ||
                  m.email ||
                  'Member';
                return (
                  <option key={m.id} value={m.personId ?? ''}>
                    {name}
                  </option>
                );
              })}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              The primary point of contact for schools and notifications.
            </p>
          </div>
        )}
      </Card>

      <Card title="Family members">
        <FamilyRosterSummary members={members} />
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
  );
}

/**
 * Read-only summary of who's in the family — guardians + children —
 * with deep-link to /family for the actual roster management. The
 * Family tab focuses on settings; promotion / invite / add UI stays
 * on the dedicated family page so this card doesn't grow into a
 * second copy of those flows.
 */
function FamilyRosterSummary({ members }: { members: FamilyMemberDto[] }) {
  const familyView = useFamilyView();
  const guardians = members;
  const children = familyView.data?.children ?? [];

  return (
    <div className="text-sm">
      <p className="text-xs font-medium text-gray-700">Guardians</p>
      {guardians.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">No guardians on file.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-2">
          {guardians.map((m) => {
            const heroName = m.preferredName?.trim() ? m.preferredName : m.firstName;
            return (
              <li
                key={m.id}
                className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700"
              >
                {heroName} {m.lastName}
                {m.isPrimaryContact && <span className="text-[10px] text-gray-500">(primary)</span>}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-xs font-medium text-gray-700">Children</p>
      {children.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">No children on file.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-2">
          {children.map((c) => {
            const heroName = c.preferredName?.trim() ? c.preferredName : c.firstName;
            return (
              <li
                key={c.id}
                className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700"
              >
                {heroName}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3">
        <Link
          href="/family"
          className="text-sm font-medium text-campus-700 hover:text-campus-600"
        >
          Manage family members →
        </Link>
      </div>
    </div>
  );
}

// ─── Addresses tab ─────────────────────────────────────────

function AddressesTab({ settings }: { settings: FamilySettingsDto }) {
  const update = useUpdateFamilySettings();
  const { toast } = useToast();

  const initial = useMemo(
    () => ({
      addressLine1: settings.addressLine1 ?? '',
      addressLine2: settings.addressLine2 ?? '',
      city: settings.city ?? '',
      state: settings.state ?? '',
      postalCode: settings.postalCode ?? '',
      country: settings.country ?? '',
      homePhone: settings.homePhone ?? '',
      mailingAddressDifferent: settings.mailingAddressDifferent,
      mailingLine1: settings.mailingLine1 ?? '',
      mailingLine2: settings.mailingLine2 ?? '',
      mailingCity: settings.mailingCity ?? '',
      mailingState: settings.mailingState ?? '',
      mailingPostalCode: settings.mailingPostalCode ?? '',
      mailingCountry: settings.mailingCountry ?? '',
    }),
    [settings],
  );
  const [form, setForm] = useState(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  const editable = settings.canEdit;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || !isDirty) return;
    const payload: UpdateFamilySettingsPayload = {};
    for (const k of Object.keys(form) as Array<keyof typeof form>) {
      if (form[k] !== initial[k]) {
        // typescript: assign each key separately
        (payload as Record<string, unknown>)[k] = form[k];
      }
    }
    try {
      await update.mutateAsync(payload);
      toast('Addresses saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <Card title="Home address" description="Required — used by schools and for shipping.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="addressLine1"
            label="Street address"
            value={form.addressLine1}
            onChange={(v) => setForm((f) => ({ ...f, addressLine1: v }))}
            disabled={!editable}
            className="sm:col-span-2"
            dirty={dirtyFields.has('addressLine1')}
          />
          <Field
            id="addressLine2"
            label="Apartment / unit"
            value={form.addressLine2}
            onChange={(v) => setForm((f) => ({ ...f, addressLine2: v }))}
            disabled={!editable}
            className="sm:col-span-2"
            dirty={dirtyFields.has('addressLine2')}
          />
          <Field
            id="city"
            label="City"
            value={form.city}
            onChange={(v) => setForm((f) => ({ ...f, city: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('city')}
          />
          <Field
            id="state"
            label="State / province"
            value={form.state}
            onChange={(v) => setForm((f) => ({ ...f, state: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('state')}
          />
          <Field
            id="postalCode"
            label="ZIP / postal code"
            value={form.postalCode}
            onChange={(v) => setForm((f) => ({ ...f, postalCode: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('postalCode')}
          />
          <Field
            id="country"
            label="Country"
            value={form.country}
            onChange={(v) => setForm((f) => ({ ...f, country: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('country')}
          />
          <Field
            id="homePhone"
            label="Home phone"
            type="tel"
            value={form.homePhone}
            onChange={(v) => setForm((f) => ({ ...f, homePhone: v }))}
            disabled={!editable}
            className="sm:col-span-2"
            dirty={dirtyFields.has('homePhone')}
          />
        </div>
      </Card>

      <Card title="Mailing address">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.mailingAddressDifferent}
            onChange={(e) =>
              setForm((f) => ({ ...f, mailingAddressDifferent: e.target.checked }))
            }
            disabled={!editable}
            className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500"
          />
          Mailing address is different from home address
        </label>

        {form.mailingAddressDifferent ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              id="mailingLine1"
              label="Street address"
              value={form.mailingLine1}
              onChange={(v) => setForm((f) => ({ ...f, mailingLine1: v }))}
              disabled={!editable}
              className="sm:col-span-2"
              dirty={dirtyFields.has('mailingLine1')}
            />
            <Field
              id="mailingLine2"
              label="Apartment / unit"
              value={form.mailingLine2}
              onChange={(v) => setForm((f) => ({ ...f, mailingLine2: v }))}
              disabled={!editable}
              className="sm:col-span-2"
              dirty={dirtyFields.has('mailingLine2')}
            />
            <Field
              id="mailingCity"
              label="City"
              value={form.mailingCity}
              onChange={(v) => setForm((f) => ({ ...f, mailingCity: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('mailingCity')}
            />
            <Field
              id="mailingState"
              label="State / province"
              value={form.mailingState}
              onChange={(v) => setForm((f) => ({ ...f, mailingState: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('mailingState')}
            />
            <Field
              id="mailingPostalCode"
              label="ZIP / postal code"
              value={form.mailingPostalCode}
              onChange={(v) => setForm((f) => ({ ...f, mailingPostalCode: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('mailingPostalCode')}
            />
            <Field
              id="mailingCountry"
              label="Country"
              value={form.mailingCountry}
              onChange={(v) => setForm((f) => ({ ...f, mailingCountry: v }))}
              disabled={!editable}
              dirty={dirtyFields.has('mailingCountry')}
            />
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-500">
            Mailing address is the same as home address.
          </p>
        )}
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
  );
}

// ─── Emergency tab ─────────────────────────────────────────

/**
 * Placeholder for the upcoming priority-arrow + linked-user-search
 * table (commit 3 of this redesign). For now wraps the existing
 * FamilyEmergencyContactsCard so the tab is reachable and the
 * existing list is still editable.
 */
function EmergencyTab({ editable }: { editable: boolean }) {
  return <FamilyEmergencyContactsCard editable={editable} />;
}

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
    <Card
      title="Family emergency contacts"
      description="Shared with every child whose Contact tab is set to inherit from family. Per-child overrides live on each child's Contact tab."
    >
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
    </Card>
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

// ─── Health & Insurance tab ────────────────────────────────

function HealthTab({ settings }: { settings: FamilySettingsDto }) {
  const update = useUpdateFamilySettings();
  const { toast } = useToast();

  const initial = useMemo(
    () => ({
      doctorName: settings.doctorName ?? '',
      doctorPhone: settings.doctorPhone ?? '',
      doctorClinic: settings.doctorClinic ?? '',
      insuranceProvider: settings.insuranceProvider ?? '',
      insurancePolicy: settings.insurancePolicy ?? '',
      insuranceGroup: settings.insuranceGroup ?? '',
      medicalNotes: settings.medicalNotes ?? '',
    }),
    [settings],
  );
  const [form, setForm] = useState(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  const editable = settings.canEdit;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || !isDirty) return;
    const payload: UpdateFamilySettingsPayload = {};
    for (const k of Object.keys(form) as Array<keyof typeof form>) {
      if (form[k] !== initial[k]) (payload as Record<string, unknown>)[k] = form[k];
    }
    try {
      await update.mutateAsync(payload);
      toast('Health & insurance saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <Card title="Family doctor">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="doctorName"
            label="Doctor name"
            value={form.doctorName}
            onChange={(v) => setForm((f) => ({ ...f, doctorName: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('doctorName')}
          />
          <Field
            id="doctorPhone"
            label="Doctor phone"
            type="tel"
            value={form.doctorPhone}
            onChange={(v) => setForm((f) => ({ ...f, doctorPhone: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('doctorPhone')}
          />
          <Field
            id="doctorClinic"
            label="Clinic / practice"
            value={form.doctorClinic}
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
            value={form.insuranceProvider}
            onChange={(v) => setForm((f) => ({ ...f, insuranceProvider: v }))}
            disabled={!editable}
            className="sm:col-span-2"
            dirty={dirtyFields.has('insuranceProvider')}
          />
          <Field
            id="insurancePolicy"
            label="Policy number"
            value={form.insurancePolicy}
            onChange={(v) => setForm((f) => ({ ...f, insurancePolicy: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('insurancePolicy')}
          />
          <Field
            id="insuranceGroup"
            label="Group number"
            value={form.insuranceGroup}
            onChange={(v) => setForm((f) => ({ ...f, insuranceGroup: v }))}
            disabled={!editable}
            dirty={dirtyFields.has('insuranceGroup')}
          />
        </div>
      </Card>

      <Card
        title="Family medical notes"
        description="Shared with schools and inherited by children whose Medical tab uses family info."
      >
        <label htmlFor="medicalNotes" className="block text-xs font-medium text-gray-700">
          Notes
          {dirtyFields.has('medicalNotes') && (
            <span
              aria-label="Modified"
              title="Modified — save to keep this change"
              className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
            />
          )}
        </label>
        <textarea
          id="medicalNotes"
          value={form.medicalNotes}
          onChange={(e) => setForm((f) => ({ ...f, medicalNotes: e.target.value }))}
          rows={4}
          disabled={!editable}
          placeholder="Anything school nurses, coaches, or teachers should know about your family."
          className={cn(
            'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
            dirtyFields.has('medicalNotes')
              ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
              : 'border border-gray-300',
          )}
        />
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
  );
}

// ─── Primitives ────────────────────────────────────────────

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
      </div>
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
