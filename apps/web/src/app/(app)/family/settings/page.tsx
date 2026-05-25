'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  FAMILY_CONTACT_CATEGORIES,
  useAddFamilyEmergencyContact,
  useDeleteFamilyEmergencyContact,
  useFamilyContactPreferences,
  useFamilyEmergencyContacts,
  useFamilySettings,
  useFamilyView,
  useReorderFamilyEmergencyContacts,
  useUpdateFamilyContactPreferences,
  useUpdateFamilyMember,
  useUpdateFamilySettings,
  type FamilyContactCategory,
  type FamilyEmergencyContactDto,
  type FamilyMemberDto,
  type FamilySettingsDto,
  type UpdateFamilySettingsPayload,
} from '@/hooks/use-family-children';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useBeforeUnloadOnDirty, useFormDirty } from '@/hooks/use-form-dirty';
import { cn } from '@/components/ui/cn';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { formatPhone } from '@/lib/phone-format';

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
        {active === 'emergency' && (
          <EmergencyTab editable={settings.canEdit} members={members} />
        )}
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
    }),
    [settings.displayName],
  );
  const [form, setForm] = useState(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  const editable = settings.canEdit;
  // Only ACTIVE members (already linked to an iam_person) can be
  // routed for any contact category — PLACEHOLDER / PENDING_INVITE
  // rows have no person_id and would fail the service-side membership
  // check anyway.
  const eligibleContacts = members.filter((m) => m.status === 'ACTIVE' && m.personId);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || !isDirty) return;
    try {
      const payload: UpdateFamilySettingsPayload = {};
      if (form.displayName !== initial.displayName) payload.displayName = form.displayName;
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

      {/* Category routing replaces the single primary-contact dropdown
          that used to live here. The GENERAL category is the new
          "primary contact for the family" — when it changes, the server
          also flips platform_family_members.is_primary_contact so the
          /family page badge + /family/settings hero stay in sync. */}
      <PrimaryContactCategoriesCard editable={editable} eligibleContacts={eligibleContacts} />

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

// ─── Primary contacts by category ──────────────────────────

const CATEGORY_META: Record<
  FamilyContactCategory,
  { label: string; icon: string; hint: string }
> = {
  GENERAL: {
    label: 'General / Default',
    icon: '📋',
    hint: 'All communications unless specified below.',
  },
  ELECTRONIC_APPROVALS: {
    label: 'Electronic Approvals',
    icon: '✍️',
    hint: 'Permission slips, consent forms, policy acknowledgements.',
  },
  TRANSPORTATION: {
    label: 'Transportation',
    icon: '🚌',
    hint: 'Bus route changes, pickup/drop-off, transport alerts.',
  },
  HEALTH_MEDICAL: {
    label: 'Health & Medical',
    icon: '🏥',
    hint: 'Nurse calls, medication administration, health alerts.',
  },
  BILLING_FINANCIAL: {
    label: 'Billing & Financial',
    icon: '💰',
    hint: 'Invoices, payment reminders, fee notifications.',
  },
  ACADEMIC: {
    label: 'Academic',
    icon: '📚',
    hint: 'Grade reports, teacher conferences, academic alerts.',
  },
  BEHAVIOUR_DISCIPLINE: {
    label: 'Behaviour & Discipline',
    icon: '🎯',
    hint: 'Incident reports, BIP updates, restorative conferences.',
  },
  EMERGENCY: {
    label: 'Emergency',
    icon: '🚨',
    hint: 'Emergency alerts, lockdowns, reunification.',
  },
};

/**
 * 8-row primary-contact router. Each category drops down the
 * eligible guardians and persists via PATCH /family/contact-preferences.
 * The card maintains its own dirty state independent of the outer
 * Family-tab form — the Save Changes button gates only on the rows
 * that actually changed, sends a partial update, and the server
 * upserts category-by-category. Empty (unset) state is allowed at
 * read time but a save requires every saved category to point to a
 * valid guardian (server validates).
 */
function PrimaryContactCategoriesCard({
  editable,
  eligibleContacts,
}: {
  editable: boolean;
  eligibleContacts: FamilyMemberDto[];
}) {
  const { data, isLoading } = useFamilyContactPreferences();
  const update = useUpdateFamilyContactPreferences();
  const { toast } = useToast();

  // Build initial state per category — fall back to '' (unset) for
  // any category the server hasn't seeded yet. This happens on first
  // visit for a family that has no primary contact set; the server's
  // lazy seed only fires when a primary exists.
  const initial = useMemo(() => {
    const m: Record<FamilyContactCategory, string> = {} as Record<FamilyContactCategory, string>;
    for (const c of FAMILY_CONTACT_CATEGORIES) m[c] = '';
    for (const row of data ?? []) m[row.category] = row.primaryPersonId;
    return m;
  }, [data]);

  const [form, setForm] = useState<Record<FamilyContactCategory, string>>(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  async function onSave() {
    if (!editable || !isDirty) return;
    const preferences = (Array.from(dirtyFields) as FamilyContactCategory[])
      .filter((category) => form[category])
      .map((category) => ({ category, primaryPersonId: form[category]! }));
    if (preferences.length === 0) return;
    try {
      await update.mutateAsync({ preferences });
      toast('Contact routing saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  if (eligibleContacts.length === 0) {
    return (
      <Card
        title="Primary Contacts by Category"
        description="Specify which guardian is the primary contact for each area. Schools will reach out to this person first for matters in each category."
      >
        <p className="text-sm text-gray-600">
          No connected guardians yet. Add or invite a guardian on{' '}
          <Link href="/family" className="text-campus-700 hover:text-campus-600">
            the family page
          </Link>{' '}
          to start routing contact categories.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Primary Contacts by Category"
      description="Specify which guardian is the primary contact for each area. Schools will reach out to this person first for matters in each category."
    >
      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th>Category</th>
                <th>Primary Contact</th>
              </tr>
            </thead>
            <tbody>
              {FAMILY_CONTACT_CATEGORIES.map((category) => {
                const meta = CATEGORY_META[category];
                const dirty = dirtyFields.has(category);
                return (
                  <tr key={category} className="border-b border-gray-100 last:border-b-0">
                    <td className="py-3 pr-3 align-top">
                      <div className="flex items-start gap-2">
                        <span aria-hidden className="text-base leading-none">
                          {meta.icon}
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">{meta.label}</div>
                          <p className="text-xs text-gray-500">{meta.hint}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 align-top">
                      <label className="sr-only" htmlFor={'contact-cat-' + category}>
                        Primary contact for {meta.label}
                        {dirty && ' (modified)'}
                      </label>
                      <div className="flex items-center gap-2">
                        <select
                          id={'contact-cat-' + category}
                          value={form[category]}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, [category]: e.target.value }))
                          }
                          disabled={!editable}
                          className={cn(
                            'block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
                            dirty
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
                        {dirty && (
                          <span
                            aria-label="Modified"
                            title="Modified — save to keep this change"
                            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editable && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!isDirty || update.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
          >
            {update.isPending && <LoadingSpinner size="sm" />}
            <span>{update.isPending ? 'Saving…' : 'Save Categories'}</span>
          </button>
        </div>
      )}
    </Card>
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

// ─── Merged rows: guardians + manual contacts ──────────────

/**
 * One row in the unified emergency-contacts table. Guardian rows
 * are synthesised on the fly from useFamilyView.members; manual rows
 * come straight from useFamilyEmergencyContacts. The two are joined
 * in the UI (no backend merge) so each list keeps its own primary
 * key + invalidation cadence.
 */
type EcRow =
  | {
      kind: 'guardian';
      // The id used by the reorder endpoint. For guardian rows this
      // is platform_family_members.id; for manual rows it's
      // platform_family_emergency_contacts.id. The server picks the
      // right table by checking which set the id belongs to.
      id: string;
      memberId: string;
      personId: string | null;
      name: string;
      phone: string | null;
      pickup: boolean;
      isCurrentUser: boolean;
      // Position in the unified namespace. Used for the merged sort.
      priority: number;
      // Tiebreaker for two rows with priority=0 (fresh families).
      // Lower tieBreak wins. Guardians use joined_at (encoded via
      // index position in the source members[] array); manuals use
      // created_at via the priorityOrder column.
      tieBreak: number;
    }
  | {
      kind: 'manual';
      id: string;
      contact: FamilyEmergencyContactDto;
      priority: number;
      tieBreak: number;
    };

const MANUAL_RELATIONSHIPS = [
  'Grandparent',
  'Aunt/Uncle',
  'Sibling',
  'Neighbor',
  'Family Friend',
  'Babysitter/Nanny',
  'Other',
];

/**
 * Family Emergency Contacts tab.
 *
 * Guardian rows are auto-populated from platform_family_members
 * (ACTIVE rows only — placeholders without an iam_person have no
 * phone to surface yet and would be useless on a contact list).
 * They are non-deletable + their name/phone is read-only since
 * those come from the guardian's own profile. Pickup toggle is
 * editable.
 *
 * Manual rows are full CRUD. Both kinds share a single priority
 * namespace — a closer-living grandparent can outrank a long-
 * commuting parent; a neighbor can sit between two co-parents.
 * Reorder arrows fire on EVERY row.
 *
 * No people-search modal — guardians are auto-populated, so the
 * Add flow is manual-only.
 */
function EmergencyTab({
  editable,
  members,
}: {
  editable: boolean;
  members: FamilyMemberDto[];
}) {
  const { data: manualContacts, isLoading } = useFamilyEmergencyContacts();
  const reorder = useReorderFamilyEmergencyContacts();
  const [addOpen, setAddOpen] = useState(false);
  const { toast } = useToast();

  // Build the merged list. Initial tie-break (when both sides have
  // priority=0 on a fresh family): guardian rows by joined_at index,
  // manual rows by created_at (we use priorityOrder as a proxy since
  // the wire payload doesn't currently surface created_at; manuals
  // ordered ASC by priorityOrder already encode createdAt for ties
  // via the server's ORDER BY).
  const guardianSource = members.filter((m) => m.status === 'ACTIVE');
  const guardianRows: EcRow[] = guardianSource.map((m, i) => ({
    kind: 'guardian' as const,
    id: m.id,
    memberId: m.id,
    personId: m.personId,
    name:
      (m.preferredName?.trim() ? m.preferredName : null) ||
      [m.firstName, m.lastName].filter(Boolean).join(' ') ||
      m.email ||
      'Guardian',
    phone: m.primaryPhone,
    pickup: m.emergencyAuthorizedPickup,
    isCurrentUser: m.isCurrentUser,
    priority: m.emergencyPriorityOrder,
    // 1000 + i puts unreordered guardians ahead of unreordered manuals
    // (which use 2000 + i below) on the priority=0 tie, matching the
    // previous "guardians first" default UX.
    tieBreak: 1000 + i,
  }));
  const manualRows: EcRow[] = (manualContacts ?? []).map((c, i) => ({
    kind: 'manual' as const,
    id: c.id,
    contact: c,
    priority: c.priorityOrder,
    tieBreak: 2000 + i,
  }));
  const rows: EcRow[] = [...guardianRows, ...manualRows].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.tieBreak - b.tieBreak;
  });

  async function move(index: number, direction: 'up' | 'down') {
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= rows.length) return;
    const ids = rows.map((r) => r.id);
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
        description="Guardians appear automatically with their profile info. Reorder any row — priority is your family's choice, not determined by role. Shared with every child whose Contact tab inherits from family."
      >
        {isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500">No emergency contacts yet.</p>
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
                {rows.map((row, idx) =>
                  row.kind === 'guardian' ? (
                    <GuardianContactRow
                      key={'guardian:' + row.memberId}
                      row={row}
                      index={idx}
                      total={rows.length}
                      editable={editable}
                      busy={reorder.isPending}
                      onMoveUp={() => void move(idx, 'up')}
                      onMoveDown={() => void move(idx, 'down')}
                    />
                  ) : (
                    <ManualContactRow
                      key={'manual:' + row.contact.id}
                      contact={row.contact}
                      index={idx}
                      total={rows.length}
                      editable={editable}
                      busy={reorder.isPending}
                      onMoveUp={() => void move(idx, 'up')}
                      onMoveDown={() => void move(idx, 'down')}
                    />
                  ),
                )}
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

function GuardianContactRow({
  row,
  index,
  total,
  editable,
  busy,
  onMoveUp,
  onMoveDown,
}: {
  row: Extract<EcRow, { kind: 'guardian' }>;
  index: number;
  total: number;
  editable: boolean;
  busy: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const update = useUpdateFamilyMember(row.memberId);
  const { toast } = useToast();
  const isFirst = index === 0;
  const isLast = index === total - 1;

  async function togglePickup(next: boolean) {
    try {
      await update.mutateAsync({ emergencyAuthorizedPickup: next });
      toast(next ? 'Authorized for pickup' : 'Pickup authorization removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <tr className="border-b border-gray-100 last:border-b-0">
      <td className="px-2 py-3 text-gray-500">{index + 1}</td>
      <td className="px-2 py-3">
        <div className="font-medium text-gray-900">
          {row.name}
          {row.isCurrentUser && (
            <span className="ml-2 text-xs font-normal text-gray-500">(you)</span>
          )}
        </div>
      </td>
      <td className="px-2 py-3 text-gray-700">Parent/Guardian</td>
      <td className="px-2 py-3 text-gray-700">
        {row.phone ? (
          formatPhone(row.phone)
        ) : (
          <span
            className="text-xs text-amber-700"
            title="This guardian hasn't set a phone number on their profile yet."
          >
            ⚠️ No phone — ask them to update their profile
          </span>
        )}
      </td>
      <td className="px-2 py-3">
        {editable ? (
          <label
            className="inline-flex cursor-pointer items-center gap-1 text-sm"
            title="Toggle whether this guardian is authorized to pick the child up from school"
          >
            <input
              type="checkbox"
              checked={row.pickup}
              onChange={(e) => void togglePickup(e.target.checked)}
              disabled={update.isPending}
              className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
            />
            <span className={row.pickup ? 'text-emerald-700' : 'text-gray-500'}>
              {row.pickup ? '✅ Yes' : '❌ No'}
            </span>
          </label>
        ) : row.pickup ? (
          <span className="text-emerald-700">✅ Yes</span>
        ) : (
          <span className="text-gray-500">❌ No</span>
        )}
      </td>
      <td className="px-2 py-3">
        <span
          title="Auto-populated from your family guardians. Name and phone come from this guardian's own profile."
          className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/20"
        >
          Guardian
        </span>
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
            {/* No delete — guardians stay on the list as long as
                they're in the family. */}
          </div>
        </td>
      )}
    </tr>
  );
}

function ManualContactRow({
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
        <div>{formatPhone(contact.phonePrimary)}</div>
        {contact.phoneAlternate && (
          <div className="text-xs text-gray-500">{formatPhone(contact.phoneAlternate)}</div>
        )}
      </td>
      <td className="px-2 py-3">
        {contact.authorizedPickup ? (
          <span className="text-emerald-700">✅ Yes</span>
        ) : (
          <span className="text-gray-500">❌ No</span>
        )}
      </td>
      <td className="px-2 py-3">
        <span
          title="Manual entry — added by you, not synced from a user profile."
          className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700"
        >
          Manual
        </span>
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

// ─── Add Emergency Contact modal (manual entry only) ─────

/**
 * Simplified add-contact modal. The previous version included a
 * CampusOS-user search to "link" a contact; that flow has been
 * removed from this surface — guardians are now auto-populated,
 * so the only thing this modal needs to handle is the manual
 * "additional contact" case (grandparent, neighbor, babysitter,
 * etc.). The /people/search endpoint still exists for future use.
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

  const [form, setForm] = useState({
    name: '',
    relationship: MANUAL_RELATIONSHIPS[0]!,
    phonePrimary: '',
    phoneAlternate: '',
    email: '',
    authorizedPickup: false,
  });

  function reset() {
    setForm({
      name: '',
      relationship: MANUAL_RELATIONSHIPS[0]!,
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

  async function onAdd() {
    if (!form.name.trim()) {
      toast('Name is required.', 'error');
      return;
    }
    if (!form.relationship.trim()) {
      toast('Relationship is required.', 'error');
      return;
    }
    if (!form.phonePrimary.trim()) {
      toast('Primary phone is required.', 'error');
      return;
    }
    try {
      await add.mutateAsync({
        name: form.name.trim(),
        relationship: form.relationship.trim(),
        phonePrimary: form.phonePrimary.trim(),
        phoneAlternate: form.phoneAlternate.trim() || undefined,
        email: form.email.trim() || undefined,
        authorizedPickup: form.authorizedPickup,
      });
      toast('Emergency contact added', 'success');
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the contact.', 'error');
    }
  }

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
      <div className="grid gap-3 sm:grid-cols-2">
        <SettingsField
          label="Name"
          value={form.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          required
          className="sm:col-span-2"
        />
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-700">
            Relationship<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            value={form.relationship}
            onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
          >
            {MANUAL_RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <PhoneFieldSettings
          label="Primary phone"
          value={form.phonePrimary}
          onChange={(raw) => setForm((f) => ({ ...f, phonePrimary: raw }))}
          required
        />
        <PhoneFieldSettings
          label="Alternate phone"
          value={form.phoneAlternate}
          onChange={(raw) => setForm((f) => ({ ...f, phoneAlternate: raw }))}
        />
        <SettingsField
          label="Email"
          value={form.email}
          onChange={(v) => setForm((f) => ({ ...f, email: v }))}
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
          <div>
            <label htmlFor="doctorPhone" className="block text-xs font-medium text-gray-700">
              Doctor phone
              {dirtyFields.has('doctorPhone') && (
                <span
                  aria-label="Modified"
                  title="Modified — save to keep this change"
                  className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
                />
              )}
            </label>
            <PhoneInput
              id="doctorPhone"
              value={form.doctorPhone}
              onChange={(raw) => setForm((f) => ({ ...f, doctorPhone: raw }))}
              disabled={!editable}
              dirty={dirtyFields.has('doctorPhone')}
            />
          </div>
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

function PhoneFieldSettings({
  label,
  value,
  onChange,
  required,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (raw: string) => void;
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
      <PhoneInput value={value} onChange={onChange} disabled={disabled} />
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
