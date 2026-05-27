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
  useUpdateFamilyEmergencyContact,
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
        {active === 'family' && (
          <FamilyTab settings={settings} members={members} onNavigate={select} />
        )}
        {active === 'addresses' && <AddressesTab settings={settings} />}
        {active === 'emergency' && (
          <EmergencyTab settings={settings} editable={settings.canEdit} members={members} />
        )}
        {active === 'health' && <HealthTab settings={settings} />}
      </div>
    </>
  );
}

// ─── Family tab ────────────────────────────────────────────

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
 * Family tab. New layout, top to bottom:
 *
 *   1. FamilyCompletionCard — weighted progress bar + checklist that
 *      deep-links to the tab/page where each missing item lives.
 *   2. Family name (display name override).
 *   3. Family members — compact list + deep-link to /family for the
 *      actual roster management (invite, add, promote, remove).
 *   4. Primary contacts by category — 8-row routing table.
 *   5. ONE Save Changes button at the bottom. Saves the display name
 *      AND any dirty contact-category routes in parallel.
 *
 * The single-save shape is intentional: the previous two-button
 * layout invited "did I save both?" confusion, and the categories
 * card's separate button rejected a stale displayName change because
 * the two forms didn't share state. Lifting both into FamilyTab fixes
 * that and surfaces dirty state per section via small dot indicators.
 */
function FamilyTab({
  settings,
  members,
  onNavigate,
}: {
  settings: FamilySettingsDto;
  members: FamilyMemberDto[];
  onNavigate: (tab: TabKey) => void;
}) {
  const updateSettings = useUpdateFamilySettings();
  const updatePrefs = useUpdateFamilyContactPreferences();
  const { data: prefsData } = useFamilyContactPreferences();
  const { toast } = useToast();

  // Only ACTIVE members (already linked to an iam_person) can be
  // routed for any contact category — PLACEHOLDER / PENDING_INVITE
  // rows have no person_id and would fail the service-side membership
  // check anyway.
  const eligibleContacts = members.filter((m) => m.status === 'ACTIVE' && m.personId);

  // Unified state: family display name + the 8 category routes.
  // Save fires both endpoints in parallel when their respective
  // slices are dirty.
  const initial = useMemo(() => {
    const prefs: Record<FamilyContactCategory, string> = {} as Record<
      FamilyContactCategory,
      string
    >;
    for (const c of FAMILY_CONTACT_CATEGORIES) prefs[c] = '';
    for (const row of prefsData ?? []) prefs[row.category] = row.primaryPersonId;
    return {
      displayName: settings.displayName ?? '',
      ...prefs,
    };
  }, [settings.displayName, prefsData]);

  type FormShape = typeof initial;
  const [form, setForm] = useState<FormShape>(initial);
  const { isDirty, dirtyFields } = useFormDirty(form, initial);
  useBeforeUnloadOnDirty(isDirty);
  useEffect(() => setForm(initial), [initial]);

  const editable = settings.canEdit;
  const nameDirty = dirtyFields.has('displayName');
  const dirtyCategories = (Array.from(dirtyFields) as Array<keyof FormShape>).filter(
    (k): k is FamilyContactCategory =>
      k !== 'displayName' && (FAMILY_CONTACT_CATEGORIES as readonly string[]).includes(k),
  );
  const categoriesDirty = dirtyCategories.length > 0;
  const busy = updateSettings.isPending || updatePrefs.isPending;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || !isDirty || busy) return;
    const tasks: Promise<unknown>[] = [];
    if (nameDirty) {
      const payload: UpdateFamilySettingsPayload = { displayName: form.displayName };
      tasks.push(updateSettings.mutateAsync(payload));
    }
    if (categoriesDirty) {
      const preferences = dirtyCategories
        .filter((category) => form[category])
        .map((category) => ({ category, primaryPersonId: form[category]! }));
      if (preferences.length > 0) {
        tasks.push(updatePrefs.mutateAsync({ preferences }));
      }
    }
    try {
      await Promise.all(tasks);
      toast('Family settings saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <SectionOverviewCard settings={settings} onNavigate={onNavigate} />

      <IncompleteItemsBanner settings={settings} section="family" />

      <Card id="family-name" title="Family name" dirty={nameDirty}>
        <Field
          id="displayName"
          label="Display name"
          value={form.displayName}
          onChange={(v) => setForm((f) => ({ ...f, displayName: v }))}
          placeholder='e.g. "The Tromsness Family"'
          disabled={!editable}
          hint="Displayed on your family page and shared with schools."
          dirty={nameDirty}
        />
      </Card>

      <Card id="family-members" title="Family members">
        <FamilyMembersList members={members} />
      </Card>

      <Card
        id="family-categories"
        title="Primary contacts by category"
        description="Specify which guardian is the primary contact for each area. Schools will reach out to this person first for matters in each category."
        dirty={categoriesDirty}
      >
        {eligibleContacts.length === 0 ? (
          <p className="text-sm text-gray-600">
            No connected guardians yet. Add or invite a guardian on{' '}
            <Link href="/family" className="text-campus-700 hover:text-campus-600">
              the family page
            </Link>{' '}
            to start routing contact categories.
          </p>
        ) : (
          <CategoryRoutingTable
            value={form}
            onChange={(category, personId) =>
              setForm((f) => ({ ...f, [category]: personId }))
            }
            dirtyFields={dirtyFields}
            eligibleContacts={eligibleContacts}
            editable={editable}
          />
        )}
      </Card>

      {editable && (
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!isDirty || busy}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
          >
            {busy && <LoadingSpinner size="sm" />}
            <span>{busy ? 'Saving…' : 'Save Changes'}</span>
          </button>
        </div>
      )}
    </form>
  );
}

// ─── Completion status ─────────────────────────────────────

type SectionKey = 'family' | 'addresses' | 'emergency' | 'health';

const SECTION_META: Record<SectionKey, { label: string; tabKey: TabKey }> = {
  family: { label: 'Family', tabKey: 'family' },
  addresses: { label: 'Addresses', tabKey: 'addresses' },
  emergency: { label: 'Emergency Contacts', tabKey: 'emergency' },
  health: { label: 'Health & Insurance', tabKey: 'health' },
};

/**
 * A single completion check. `weight` rolls up into the global
 * percentage; `section` groups items into the 4 tab buckets.
 *
 * Fix navigation is mode-driven:
 *   - `scrollTargetId` → the fix lives on the same tab as the
 *     item; the per-tab banner renders [Fix ↓] that scrollIntoView's
 *     the matching `<section id="...">`.
 *   - `href` → the fix lives on a different page (e.g. /family for
 *     children, /profile for guardians); the banner renders [Fix →].
 *   - Neither → no actionable fix surface; the bullet is informational.
 */
interface CompletionItem {
  key: string;
  label: string;
  complete: boolean;
  weight: number;
  section: SectionKey;
  scrollTargetId?: string;
  href?: string;
}

interface CompletionSectionState {
  items: CompletionItem[];
  incomplete: CompletionItem[];
  complete: boolean;
  remaining: number;
}

interface CompletionState {
  items: CompletionItem[];
  percent: number;
  bySection: Record<SectionKey, CompletionSectionState>;
}

/**
 * Single source of truth for the 11 weighted completion checks +
 * how they roll up into the 4 section buckets. All renderers
 * (SectionOverviewCard on the Family tab, IncompleteItemsBanner on
 * every tab) read from this — so the bookkeeping is in one place
 * and the rendering layer just consumes results.
 *
 * Items themselves are computed in a useMemo on the loaded data;
 * the data is fetched via the React Query hooks each consumer would
 * call anyway (`useFamilyView` / `useFamilyEmergencyContacts` /
 * `useFamilyContactPreferences`), and React Query dedupes the
 * underlying network calls so multiple consumers don't cost extra.
 */
function useCompletionState(settings: FamilySettingsDto): CompletionState {
  const familyView = useFamilyView();
  const { data: ecs } = useFamilyEmergencyContacts();
  const { data: prefsData } = useFamilyContactPreferences();
  const members = familyView.data?.members ?? [];
  const children = familyView.data?.children ?? [];
  const prefs = prefsData ?? null;

  const items = useMemo<CompletionItem[]>(() => {
    const hasName = Boolean(settings.displayName?.trim());
    const hasGeneralPrimary = (prefs ?? []).some(
      (p) => p.category === 'GENERAL' && p.primaryPersonId,
    );
    const hasHomeAddress = Boolean(
      settings.addressLine1 && settings.city && settings.state && settings.postalCode,
    );
    const activeGuardians = members.filter((m) => m.status === 'ACTIVE');
    const guardiansWithPhone = activeGuardians.filter(
      (m) => (m.primaryPhone ?? '').trim().length > 0,
    ).length;
    const manualECsWithPhone = (ecs ?? []).filter(
      (c) => c.phonePrimary && c.phonePrimary.trim().length > 0,
    ).length;
    const totalContactsWithPhone = guardiansWithPhone + manualECsWithPhone;
    const enoughEmergency = totalContactsWithPhone >= 2;
    const hasDoctor =
      Boolean(settings.doctorName?.trim()) || settings.hasFamilyDoctor === false;
    const hasInsurance =
      Boolean(settings.insuranceProvider?.trim()) || settings.hasInsurance === false;
    const hasAnyChild = children.length > 0;
    const unlinkedChildren = children.filter((c) => c.status !== 'LINKED');
    const allChildrenLinked = hasAnyChild && unlinkedChildren.length === 0;
    const guardiansComplete =
      activeGuardians.length > 0 &&
      activeGuardians.every(
        (m) => (m.primaryPhone ?? '').trim() && (m.email ?? '').trim(),
      );
    const generalPersonId = (prefs ?? []).find((p) => p.category === 'GENERAL')?.primaryPersonId;
    const customisedPrefs = (prefs ?? []).some(
      (p) =>
        p.category !== 'GENERAL' && p.primaryPersonId && p.primaryPersonId !== generalPersonId,
    );
    const mailingSatisfied = !settings.mailingAddressDifferent
      ? true
      : Boolean(settings.mailingLine1 && settings.mailingCity && settings.mailingState);

    return [
      {
        key: 'family-name',
        label: 'Family name set',
        complete: hasName,
        weight: 5,
        section: 'family',
        scrollTargetId: 'family-name',
      },
      {
        key: 'primary-contact',
        label: 'Primary contact assigned (General)',
        complete: hasGeneralPrimary,
        weight: 5,
        section: 'family',
        scrollTargetId: 'family-categories',
      },
      {
        key: 'communication-prefs',
        label: 'Communication preferences customised',
        complete: customisedPrefs,
        weight: 5,
        section: 'family',
        scrollTargetId: 'family-categories',
      },
      {
        key: 'at-least-one-child',
        label: 'At least one child added',
        complete: hasAnyChild,
        weight: 10,
        section: 'family',
        href: '/family',
      },
      {
        key: 'all-children-linked',
        label: allChildrenLinked
          ? 'All children have linked accounts'
          : hasAnyChild
            ? `Children have accounts (${children.length - unlinkedChildren.length} of ${children.length} connected)`
            : 'All children have linked accounts',
        complete: allChildrenLinked,
        weight: 10,
        section: 'family',
        href: '/family',
      },
      {
        key: 'guardian-profiles',
        label: 'All guardian profiles complete (phone + email)',
        complete: guardiansComplete,
        weight: 10,
        section: 'family',
        href: '/profile',
      },
      {
        key: 'home-address',
        label: 'Home address on file',
        complete: hasHomeAddress,
        weight: 15,
        section: 'addresses',
        scrollTargetId: 'addresses-home',
      },
      {
        key: 'mailing-address',
        label: 'Mailing address (if different from home)',
        complete: mailingSatisfied,
        weight: 5,
        section: 'addresses',
        scrollTargetId: 'addresses-mailing',
      },
      {
        key: 'emergency-contacts',
        label:
          totalContactsWithPhone >= 2
            ? 'At least 2 emergency contacts with phone'
            : totalContactsWithPhone === 0
              ? 'At least 2 emergency contacts with phone — none on file'
              : `At least 2 emergency contacts with phone — only ${totalContactsWithPhone} on file`,
        complete: enoughEmergency,
        weight: 15,
        section: 'emergency',
        scrollTargetId: 'emergency-list',
      },
      {
        key: 'family-doctor',
        label: 'Family doctor on file (or mark as none)',
        complete: hasDoctor,
        weight: 10,
        section: 'health',
        scrollTargetId: 'health-doctor',
      },
      {
        key: 'family-insurance',
        label: 'Insurance on file (or mark as none)',
        complete: hasInsurance,
        weight: 10,
        section: 'health',
        scrollTargetId: 'health-insurance',
      },
    ];
  }, [settings, members, children, prefs, ecs]);

  const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
  const earned = items.filter((i) => i.complete).reduce((sum, i) => sum + i.weight, 0);
  const percent = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100);

  const bySection = (Object.keys(SECTION_META) as SectionKey[]).reduce(
    (acc, key) => {
      const sectionItems = items.filter((i) => i.section === key);
      const incomplete = sectionItems.filter((i) => !i.complete);
      acc[key] = {
        items: sectionItems,
        incomplete,
        complete: incomplete.length === 0,
        remaining: incomplete.length,
      };
      return acc;
    },
    {} as Record<SectionKey, CompletionSectionState>,
  );

  return { items, percent, bySection };
}

/**
 * Family-tab overview. Replaces the legacy 11-row checklist with a
 * 4-row section roll-up so the surface stays compact; per-item
 * diagnostics live on each tab's IncompleteItemsBanner.
 */
function SectionOverviewCard({
  settings,
  onNavigate,
}: {
  settings: FamilySettingsDto;
  onNavigate: (tab: TabKey) => void;
}) {
  const { percent, bySection } = useCompletionState(settings);
  const order: SectionKey[] = ['family', 'addresses', 'emergency', 'health'];

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900">Family profile</h2>
        <span className="text-sm font-semibold text-gray-900" aria-live="polite">
          {percent}% complete
        </span>
      </div>
      <div
        className="mt-2 h-2 w-full rounded-full bg-gray-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className="h-2 rounded-full bg-green-500 transition-[width]"
          style={{ width: percent + '%' }}
        />
      </div>
      <ul className="mt-3 flex flex-col gap-1">
        {order.map((key) => {
          const meta = SECTION_META[key];
          const section = bySection[key];
          const rowClasses =
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left';
          const interactive = !section.complete;
          const remainingLabel =
            section.remaining === 1 ? '1 item remaining' : `${section.remaining} items remaining`;
          const content = (
            <>
              <span aria-hidden className={section.complete ? 'text-green-600' : 'text-red-400'}>
                {section.complete ? '✅' : '❌'}
              </span>
              <span className={section.complete ? 'text-gray-700' : 'text-gray-900'}>
                {meta.label} — {section.complete ? 'complete' : remainingLabel}
              </span>
              {interactive && (
                <span className="ml-auto text-xs font-medium text-campus-700">Fix →</span>
              )}
            </>
          );
          return (
            <li key={key}>
              {interactive ? (
                <button
                  type="button"
                  onClick={() => onNavigate(meta.tabKey)}
                  className={cn(rowClasses, 'hover:bg-gray-50')}
                >
                  {content}
                </button>
              ) : (
                <div className={cn(rowClasses, 'cursor-default')}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function scrollToId(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Per-tab status strip. Shows a compact amber alert listing the
 * tab's incomplete items (each with [Fix ↓] / [Fix →] depending on
 * whether the destination is in-tab or cross-page), or a small
 * green "Section complete" bar when there are none.
 *
 * Goes at the top of every tab. Family tab shows it below the
 * 4-section overview, focused on Family-section items only.
 */
function IncompleteItemsBanner({
  settings,
  section,
}: {
  settings: FamilySettingsDto;
  section: SectionKey;
}) {
  const { bySection } = useCompletionState(settings);
  const state = bySection[section];

  if (state.complete) {
    return (
      <section
        aria-live="polite"
        className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800"
      >
        <span aria-hidden>✅</span>
        <span>Section complete</span>
      </section>
    );
  }

  const noun = state.remaining === 1 ? 'item' : 'items';
  return (
    <section
      aria-live="polite"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
    >
      <p className="text-sm font-semibold text-amber-900">
        <span aria-hidden className="mr-1">
          ⚠️
        </span>
        {state.remaining} {noun} to complete
      </p>
      <ul className="mt-1 flex flex-col gap-1 text-sm text-amber-900">
        {state.incomplete.map((item) => (
          <li
            key={item.key}
            className="flex flex-wrap items-center gap-2"
          >
            <span aria-hidden className="text-amber-700">
              •
            </span>
            <span className="flex-1 min-w-0">{item.label}</span>
            <IncompleteFixAction item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function IncompleteFixAction({ item }: { item: CompletionItem }) {
  const classes =
    'inline-flex items-center justify-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-900 shadow-sm hover:bg-amber-100';
  if (item.scrollTargetId) {
    const id = item.scrollTargetId;
    return (
      <button type="button" onClick={() => scrollToId(id)} className={classes}>
        Fix ↓
      </button>
    );
  }
  if (item.href) {
    return (
      <Link href={item.href} className={classes}>
        Fix →
      </Link>
    );
  }
  return null;
}

// ─── Compact family-members list ───────────────────────────

/**
 * Replaces the old chip-cloud roster summary with a two-section list
 * that shows guardian-role + child-account status at a glance.
 * Mutations still live on /family — this card is reference data
 * with a deep-link.
 */
function FamilyMembersList({ members }: { members: FamilyMemberDto[] }) {
  const familyView = useFamilyView();
  const guardians = members.filter((m) => m.status === 'ACTIVE');
  const placeholderGuardians = members.filter((m) => m.status !== 'ACTIVE');
  const children = familyView.data?.children ?? [];
  const isParent = familyView.data?.viewerRole === 'PARENT';

  return (
    <div className="flex flex-col gap-5 text-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Guardians</p>
        {guardians.length === 0 && placeholderGuardians.length === 0 ? (
          <p className="mt-1 text-gray-500">No guardians on file.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {guardians.map((m) => {
              const heroName = m.preferredName?.trim() ? m.preferredName : m.firstName;
              return (
                <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="text-gray-900">
                    {heroName} {m.lastName}
                    {m.isCurrentUser && (
                      <span className="ml-1 text-xs font-normal text-gray-500">(you)</span>
                    )}
                  </span>
                  {m.isPrimaryContact ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                      ⭐ Primary
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500">Guardian</span>
                  )}
                </li>
              );
            })}
            {placeholderGuardians.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-gray-500"
              >
                <span>
                  {m.firstName} {m.lastName}
                </span>
                <span className="text-xs">
                  {m.status === 'PENDING_INVITE' ? 'Invite sent' : 'Pending'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {isParent && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Link
              href="/family?action=invite-guardian"
              className="inline-flex items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            >
              Invite Guardian
            </Link>
            <Link
              href="/family?action=add-guardian"
              className="inline-flex items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            >
              Add Guardian
            </Link>
          </div>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Children</p>
        {children.length === 0 ? (
          <p className="mt-1 text-gray-500">No children on file.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {children.map((c) => {
              const heroName = c.preferredName?.trim() ? c.preferredName : c.firstName;
              const linked = c.status === 'LINKED';
              return (
                <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="text-gray-900">
                    {heroName}
                    {c.preferredName?.trim() && c.preferredName !== c.firstName && (
                      <span className="ml-1 text-xs text-gray-500">
                        ({c.firstName} {c.lastName})
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'text-xs font-medium',
                      linked ? 'text-green-700' : 'text-amber-700',
                    )}
                  >
                    {linked ? '✅ Connected' : '⚠️ No account'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {isParent && (
          <div className="mt-2">
            <Link
              href="/family"
              className="text-sm font-medium text-campus-700 hover:text-campus-600"
            >
              Manage children →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Category routing table (controlled child of FamilyTab) ─

function CategoryRoutingTable({
  value,
  onChange,
  dirtyFields,
  eligibleContacts,
  editable,
}: {
  value: Record<string, string>;
  onChange: (category: FamilyContactCategory, personId: string) => void;
  dirtyFields: ReadonlySet<string>;
  eligibleContacts: FamilyMemberDto[];
  editable: boolean;
}) {
  return (
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
                      value={value[category] ?? ''}
                      onChange={(e) => onChange(category, e.target.value)}
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
      <IncompleteItemsBanner settings={settings} section="addresses" />
      <Card
        id="addresses-home"
        title="Home address"
        description="Required — used by schools and for shipping."
      >
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

      <Card id="addresses-mailing" title="Mailing address">
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
  settings,
  editable,
  members,
}: {
  settings: FamilySettingsDto;
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
      <IncompleteItemsBanner settings={settings} section="emergency" />
      <Card
        id="emergency-list"
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
        <PickupBadge
          value={row.pickup}
          onToggle={(next) => void togglePickup(next)}
          busy={update.isPending}
          editable={editable}
        />
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
  const update = useUpdateFamilyEmergencyContact(contact.id);
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

  async function togglePickup(next: boolean) {
    try {
      await update.mutateAsync({ authorizedPickup: next });
      toast(next ? 'Authorized for pickup' : 'Pickup authorization removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
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
        <PickupBadge
          value={contact.authorizedPickup}
          onToggle={(next) => void togglePickup(next)}
          busy={update.isPending}
          editable={editable}
        />
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

/**
 * Pickup-authorization badge — a single clickable pill that
 * replaces the older checkbox + ✅/❌ text combo in the emergency-
 * contacts Pickup column. Clicking persists immediately via the
 * row's existing toggle handler; the row passes `busy` while the
 * mutation is pending so a double-click doesn't fire two writes.
 *
 *   Authorized (true)   → green pill "✓ Yes"
 *   Not authorized (false) → grey pill "No"
 *
 * Read-only callers (canEdit === false) render the same pill
 * without the click affordance and without the focus ring.
 */
function PickupBadge({
  value,
  onToggle,
  busy,
  editable,
}: {
  value: boolean;
  onToggle: (next: boolean) => void;
  busy: boolean;
  editable: boolean;
}) {
  const yes = value;
  const className = cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
    yes
      ? 'border-green-200 bg-green-50 text-green-700'
      : 'border-gray-200 bg-gray-50 text-gray-500',
    editable && !busy
      ? yes
        ? 'cursor-pointer hover:bg-green-100'
        : 'cursor-pointer hover:bg-gray-100'
      : 'cursor-default',
    busy && 'opacity-60',
  );
  const label = yes ? '✓ Yes' : 'No';
  const title = editable
    ? yes
      ? 'Authorized for pickup — click to remove'
      : 'Not authorized — click to allow pickup'
    : yes
      ? 'Authorized for pickup'
      : 'Not authorized for pickup';

  if (!editable) {
    return (
      <span className={className} title={title}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onToggle(!yes)}
      disabled={busy}
      title={title}
      aria-pressed={yes}
      className={className}
    >
      {label}
    </button>
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

  // noDoctor / noInsurance are the UI inverses of has_family_doctor /
  // has_insurance. They flip on the explicit-opt-out checkbox and
  // serialize back as `false` (or null when unchecked AND fields are
  // empty — leaving the row in "not answered" so first-time users
  // don't get an opt-out auto-applied). Existing rows with NULL keep
  // their checkbox unchecked.
  const initial = useMemo(
    () => ({
      doctorName: settings.doctorName ?? '',
      doctorPhone: settings.doctorPhone ?? '',
      doctorClinic: settings.doctorClinic ?? '',
      insuranceProvider: settings.insuranceProvider ?? '',
      insurancePolicy: settings.insurancePolicy ?? '',
      insuranceGroup: settings.insuranceGroup ?? '',
      noDoctor: settings.hasFamilyDoctor === false,
      noInsurance: settings.hasInsurance === false,
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
      if (k === 'noDoctor' || k === 'noInsurance') continue;
      if (form[k] !== initial[k]) (payload as Record<string, unknown>)[k] = form[k];
    }
    // Doctor opt-out: checked → has_family_doctor = false AND clear
    // the doctor fields server-side so the next read doesn't carry
    // a stale name. Unchecked: only flip back to has_family_doctor =
    // true if the user has filled in *any* doctor field — otherwise
    // we leave it null ("not answered"), the legacy state.
    if (form.noDoctor !== initial.noDoctor) {
      if (form.noDoctor) {
        payload.hasFamilyDoctor = false;
        payload.doctorName = null;
        payload.doctorPhone = null;
        payload.doctorClinic = null;
      } else {
        payload.hasFamilyDoctor = null;
      }
    }
    if (form.noInsurance !== initial.noInsurance) {
      if (form.noInsurance) {
        payload.hasInsurance = false;
        payload.insuranceProvider = null;
        payload.insurancePolicy = null;
        payload.insuranceGroup = null;
      } else {
        payload.hasInsurance = null;
      }
    }
    // Filling in a doctor field implicitly answers "yes we have one"
    // — flip has_family_doctor to true so the read stays consistent
    // (false + filled fields would be self-contradictory).
    const willHaveDoctorFields =
      (form.doctorName || form.doctorPhone || form.doctorClinic) && !form.noDoctor;
    if (willHaveDoctorFields && settings.hasFamilyDoctor !== true) {
      payload.hasFamilyDoctor = true;
    }
    const willHaveInsuranceFields =
      (form.insuranceProvider || form.insurancePolicy || form.insuranceGroup) &&
      !form.noInsurance;
    if (willHaveInsuranceFields && settings.hasInsurance !== true) {
      payload.hasInsurance = true;
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
      <IncompleteItemsBanner settings={settings} section="health" />
      <Card id="health-doctor" title="Family doctor">
        <OptOutCheckbox
          id="noDoctor"
          label="We don't have a family doctor"
          checked={form.noDoctor}
          onChange={(v) => setForm((f) => ({ ...f, noDoctor: v }))}
          dirty={dirtyFields.has('noDoctor')}
          disabled={!editable}
        />
        {form.noDoctor ? (
          <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
            No family doctor on file. Children can still specify their own doctor on their
            Medical tab.
          </p>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
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
        )}
      </Card>

      <Card id="health-insurance" title="Family insurance">
        <OptOutCheckbox
          id="noInsurance"
          label="We don't have insurance"
          checked={form.noInsurance}
          onChange={(v) => setForm((f) => ({ ...f, noInsurance: v }))}
          dirty={dirtyFields.has('noInsurance')}
          disabled={!editable}
        />
        {form.noInsurance ? (
          <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
            No insurance on file.
          </p>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
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
        )}
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
  id,
  title,
  description,
  children,
  dirty,
}: {
  id?: string;
  title?: string;
  description?: string;
  children: React.ReactNode;
  dirty?: boolean;
}) {
  return (
    <section
      id={id}
      className="rounded-card border border-gray-200 bg-white p-5 shadow-sm scroll-mt-4"
    >
      {(title || description) && (
        <div className="mb-3">
          {title && (
            <h2 className="text-sm font-semibold text-gray-900">
              {title}
              {dirty && (
                <span
                  aria-label="Unsaved changes in this section"
                  title="Unsaved changes in this section"
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
                />
              )}
            </h2>
          )}
          {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
        </div>
      )}
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

/**
 * Checkbox + label primitive for an explicit "we don't have one"
 * opt-out toggle. Used by HealthTab for the family doctor and
 * insurance sections; the dirty dot follows the same blue-circle
 * convention as Field.
 */
function OptOutCheckbox({
  id,
  label,
  checked,
  onChange,
  disabled,
  dirty,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  dirty?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex items-center gap-2 text-sm text-gray-700',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500 disabled:opacity-60"
      />
      <span>{label}</span>
      {dirty && (
        <span
          aria-label="Modified"
          title="Modified — save to keep this change"
          className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500"
        />
      )}
    </label>
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
