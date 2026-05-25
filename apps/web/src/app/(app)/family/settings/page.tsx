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
  usePeopleSearch,
  useReorderFamilyEmergencyContacts,
  useUpdateFamilySettings,
  type FamilyEmergencyContactDto,
  type FamilyMemberDto,
  type FamilySettingsDto,
  type PeopleSearchResult,
  type UpdateFamilySettingsPayload,
} from '@/hooks/use-family-children';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
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
 * Table layout with priority up/down arrows and a Linked badge.
 * Linked contacts are CampusOS users — their name/phone/email
 * surface the current iam_person values via a server-side JOIN
 * and update automatically when the linked user changes their
 * own profile. Manual contacts are free-form rows.
 */
function EmergencyTab({ editable }: { editable: boolean }) {
  const { data, isLoading } = useFamilyEmergencyContacts();
  const reorder = useReorderFamilyEmergencyContacts();
  const [addOpen, setAddOpen] = useState(false);
  const { toast } = useToast();

  const contacts = data ?? [];

  async function moveContact(index: number, direction: 'up' | 'down') {
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= contacts.length) return;
    const ids = contacts.map((c) => c.id);
    [ids[index], ids[swapWith]] = [ids[swapWith]!, ids[index]!];
    try {
      await reorder.mutateAsync(ids);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not reorder.', 'error');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="Family emergency contacts"
        description="Shared with every child whose Contact tab is set to inherit from family. Drag-free priority order — use the arrows. Linked contacts auto-update when the user changes their own profile."
      >
        {isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="text-sm text-gray-500">No family emergency contacts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <th className="px-2 py-2 w-10">#</th>
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Relationship</th>
                  <th className="px-2 py-2">Phone</th>
                  <th className="px-2 py-2">Pickup</th>
                  <th className="px-2 py-2">Source</th>
                  {editable && <th className="px-2 py-2 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {contacts.map((c, i) => (
                  <EmergencyContactTableRow
                    key={c.id}
                    contact={c}
                    index={i}
                    total={contacts.length}
                    editable={editable}
                    busy={reorder.isPending}
                    onMoveUp={() => void moveContact(i, 'up')}
                    onMoveDown={() => void moveContact(i, 'down')}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editable && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
            >
              + Add Emergency Contact
            </button>
          </div>
        )}
      </Card>

      <AddEmergencyContactModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function EmergencyContactTableRow({
  contact,
  index,
  total,
  editable,
  busy,
  onMoveUp,
  onMoveDown,
}: {
  contact: FamilyEmergencyContactDto;
  index: number;
  total: number;
  editable: boolean;
  busy: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const remove = useDeleteFamilyEmergencyContact(contact.id);
  const { toast } = useToast();
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const isLinked = contact.linkedPersonId !== null;

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
    <tr className="border-b border-gray-100 last:border-b-0">
      <td className="px-2 py-3 text-gray-500">{index + 1}</td>
      <td className="px-2 py-3">
        <div className="font-medium text-gray-900">{contact.name}</div>
        {contact.email && <div className="text-xs text-gray-500">{contact.email}</div>}
      </td>
      <td className="px-2 py-3 text-gray-700">{contact.relationship}</td>
      <td className="px-2 py-3 text-gray-700">
        <div>{contact.phonePrimary}</div>
        {contact.phoneAlternate && (
          <div className="text-xs text-gray-500">{contact.phoneAlternate}</div>
        )}
      </td>
      <td className="px-2 py-3">
        {contact.authorizedPickup ? (
          <span className="text-emerald-700" title="Authorized for pickup">
            ✅ Yes
          </span>
        ) : (
          <span className="text-gray-500">❌ No</span>
        )}
      </td>
      <td className="px-2 py-3">
        {isLinked ? (
          <span
            title="Linked to a CampusOS user — contact info auto-updates when they update their profile."
            className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 ring-1 ring-inset ring-sky-600/20"
          >
            🔗 Linked
          </span>
        ) : (
          <span
            title="Manual entry — contact info won't auto-update."
            className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700"
          >
            Manual
          </span>
        )}
      </td>
      {editable && (
        <td className="px-2 py-3">
          <div className="flex items-center justify-end gap-1">
            <IconButton
              label={isFirst ? 'Already at the top' : 'Move up'}
              onClick={onMoveUp}
              disabled={isFirst || busy}
            >
              ↑
            </IconButton>
            <IconButton
              label={isLast ? 'Already at the bottom' : 'Move down'}
              onClick={onMoveDown}
              disabled={isLast || busy}
            >
              ↓
            </IconButton>
            <IconButton
              label={'Remove ' + contact.name}
              onClick={() => void onRemove()}
              disabled={remove.isPending}
              danger
            >
              🗑
            </IconButton>
          </div>
        </td>
      )}
    </tr>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-300 bg-white text-xs text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40',
        danger && 'border-red-200 text-red-700 hover:bg-red-50',
      )}
    >
      {children}
    </button>
  );
}

// ─── Add Emergency Contact modal ────────────────────────

const EC_RELATIONSHIPS = [
  'Spouse',
  'Co-parent',
  'Grandfather',
  'Grandmother',
  'Aunt',
  'Uncle',
  'Sibling',
  'Neighbor',
  'Family friend',
  'Other',
];

/**
 * Modal with two routes to add a contact:
 *
 *   1. Search a CampusOS user. Selecting a hit fills + locks the
 *      name / phone / email fields and stamps linkedPersonId on the
 *      payload. The server will keep those fields fresh on read.
 *
 *   2. Enter manually. linkedPersonId stays null; the user fills the
 *      free-form fields. The save path treats those as authoritative.
 *
 * Relationship + authorized-for-pickup are always editable — they're
 * family-specific, not the linked person's own attributes.
 */
function AddEmergencyContactModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const add = useAddFamilyEmergencyContact();
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PeopleSearchResult | null>(null);
  const [form, setForm] = useState({
    name: '',
    relationship: EC_RELATIONSHIPS[0]!,
    phonePrimary: '',
    phoneAlternate: '',
    email: '',
    authorizedPickup: false,
  });
  const search = usePeopleSearch(query, open && selected === null);

  function reset() {
    setQuery('');
    setSelected(null);
    setForm({
      name: '',
      relationship: EC_RELATIONSHIPS[0]!,
      phonePrimary: '',
      phoneAlternate: '',
      email: '',
      authorizedPickup: false,
    });
  }

  function close() {
    reset();
    onClose();
  }

  function pickPerson(p: PeopleSearchResult) {
    setSelected(p);
    const fullName =
      (p.preferredName?.trim() ? p.preferredName : null) ||
      [p.firstName, p.lastName].filter(Boolean).join(' ');
    setForm((f) => ({
      ...f,
      name: fullName,
      phonePrimary: p.primaryPhone ?? '',
      email: p.email ?? '',
    }));
  }

  function unlink() {
    setSelected(null);
    // Keep the form values typed so far — the user can keep them or
    // edit further. Linked badge disappears.
  }

  async function onAdd() {
    if (!form.relationship.trim()) {
      toast('Relationship is required.', 'error');
      return;
    }
    // Manual mode requires name + primary phone (server enforces too;
    // surface the error early).
    if (!selected) {
      if (!form.name.trim()) {
        toast('Name is required.', 'error');
        return;
      }
      if (!form.phonePrimary.trim()) {
        toast('Primary phone is required.', 'error');
        return;
      }
    }
    try {
      await add.mutateAsync({
        linkedPersonId: selected?.id,
        name: selected ? undefined : form.name.trim(),
        relationship: form.relationship.trim(),
        phonePrimary: selected ? undefined : form.phonePrimary.trim(),
        phoneAlternate: form.phoneAlternate.trim() || undefined,
        email: selected ? undefined : form.email.trim() || undefined,
        authorizedPickup: form.authorizedPickup,
      });
      toast('Emergency contact added', 'success');
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the contact.', 'error');
    }
  }

  const fieldsLocked = selected !== null;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add Emergency Contact"
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
            type="button"
            onClick={() => void onAdd()}
            disabled={add.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
          >
            {add.isPending && <LoadingSpinner size="sm" />}
            <span>{add.isPending ? 'Adding…' : 'Add Contact'}</span>
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!selected && (
          <div>
            <label htmlFor="people-search" className="block text-xs font-medium text-gray-700">
              Search for a CampusOS user (optional)
            </label>
            <input
              id="people-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="🔍 Search by name or email…"
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
              autoComplete="off"
            />

            {query.trim().length >= 2 && (
              <div className="mt-2 rounded-md border border-gray-200 bg-gray-50/40">
                {search.isLoading ? (
                  <p className="px-3 py-2 text-sm text-gray-500">Searching…</p>
                ) : !search.data || search.data.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-500">No matches found.</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto">
                    {search.data.map((p) => {
                      const fullName =
                        (p.preferredName?.trim() ? p.preferredName : null) ||
                        [p.firstName, p.lastName].filter(Boolean).join(' ');
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => pickPerson(p)}
                            className="flex w-full items-center justify-between gap-2 border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-white"
                          >
                            <span>
                              <span className="font-medium text-gray-900">{fullName}</span>
                              {p.email && (
                                <span className="ml-2 text-xs text-gray-500">{p.email}</span>
                              )}
                            </span>
                            <span className="text-xs font-medium text-campus-700">Select</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {selected && (
          <div className="rounded-md border border-sky-200 bg-sky-50/60 p-3 text-xs text-sky-900">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">🔗 Linked to {form.name}&rsquo;s account</p>
              <button
                type="button"
                onClick={unlink}
                className="text-xs font-medium text-sky-700 hover:text-sky-900"
              >
                Unlink
              </button>
            </div>
            <p className="mt-1">
              Contact info updates automatically when {form.name} updates their CampusOS profile.
            </p>
          </div>
        )}

        {!selected && query.trim().length >= 2 && (
          <p className="text-xs text-gray-500">— or enter manually —</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <SettingsField
            label="Name"
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            required={!fieldsLocked}
            disabled={fieldsLocked}
          />
          <div>
            <label className="block text-xs font-medium text-gray-700">
              Relationship<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              value={form.relationship}
              onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
            >
              {EC_RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <SettingsField
            label="Primary phone"
            value={form.phonePrimary}
            onChange={(v) => setForm((f) => ({ ...f, phonePrimary: v }))}
            required={!fieldsLocked}
            disabled={fieldsLocked}
          />
          <SettingsField
            label="Alternate phone"
            value={form.phoneAlternate}
            onChange={(v) => setForm((f) => ({ ...f, phoneAlternate: v }))}
          />
          <SettingsField
            label="Email"
            value={form.email}
            onChange={(v) => setForm((f) => ({ ...f, email: v }))}
            disabled={fieldsLocked}
            className="sm:col-span-2"
          />
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.authorizedPickup}
              onChange={(e) => setForm((f) => ({ ...f, authorizedPickup: e.target.checked }))}
              className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500"
            />
            Authorized for pickup
          </label>
        </div>

        {!selected && (
          <p className="text-xs text-gray-500">
            Manual entry — contact info won&rsquo;t auto-update.
          </p>
        )}
      </div>
    </Modal>
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
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  disabled?: boolean;
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
        disabled={disabled}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
      />
    </div>
  );
}
