'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useAuthActions } from '@/lib/auth-context';
import { useAuthStore } from '@/lib/auth-store';
import { useMyProfile, useUpdateMyProfile } from '@/hooks/use-profile';
import { useAcceptFamilyLink, useGenerateChildCode } from '@/hooks/use-family-children';
import { useBeforeUnloadOnDirty, useFormDirty } from '@/hooks/use-form-dirty';
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
      <FamilyConnectionSection />
    </div>
  );
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

type TabKey = 'account' | 'contact' | 'medical' | 'about';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'account', label: 'Account' },
  { key: 'contact', label: 'Contact' },
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

      <div className="mt-6">
        {active === 'account' && <AccountTab profile={profile} />}
        {active === 'contact' && <ContactTab profile={profile} />}
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

  const initial = useMemo(
    () => ({
      firstName: profile.firstName ?? '',
      middleName: profile.middleName ?? '',
      lastName: profile.lastName ?? '',
      preferredName: profile.preferredName ?? '',
      primaryPhone: profile.primaryPhone ?? '',
      dateOfBirth: profile.dateOfBirth ?? '',
      gender: profile.gender ?? '',
    }),
    [
      profile.firstName,
      profile.middleName,
      profile.lastName,
      profile.preferredName,
      profile.primaryPhone,
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
        middleName: form.middleName.trim() || null,
        lastName: form.lastName.trim(),
        preferredName: form.preferredName.trim() || null,
        primaryPhone: form.primaryPhone.trim() || null,
        dateOfBirth: form.dateOfBirth || null,
        gender: form.gender || null,
      });
      await refreshUser();
      toast('Profile updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save. Try again.', 'error');
    }
  }

  return (
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
            hint="Used throughout CampusOS instead of your first name."
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

        <div className="mt-4">
          <EditField
            id="primaryPhone"
            label="Phone"
            type="tel"
            value={form.primaryPhone}
            onChange={(v) => setField('primaryPhone', v)}
            autoComplete="tel"
            dirty={dirtyFields.has('primaryPhone')}
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
              <option value="">Not Specified</option>
              <option value="F">Female</option>
              <option value="M">Male</option>
            </select>
          </div>
        </div>

        <AccountInfo profile={profile} personas={personas} />

        <div className="mt-5 flex justify-end">
          <button
            type="submit"
            disabled={!isDirty || update.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
          >
            {update.isPending && <LoadingSpinner size="sm" />}
            <span>{update.isPending ? 'Saving…' : 'Save Changes'}</span>
          </button>
        </div>
      </form>
    </SectionCard>
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

// ─── Contact tab (stub — wired up in next commit) ──────────

function ContactTab({ profile: _profile }: { profile: ProfileDto }) {
  return (
    <SectionCard title="Contact">
      <p className="text-sm text-gray-500">
        Address, mailing, and work-contact controls land in the next commit. For now your phone
        lives on the Account tab.
      </p>
    </SectionCard>
  );
}

// ─── Medical tab (stub) ────────────────────────────────────

function MedicalTab({ profile: _profile }: { profile: ProfileDto }) {
  return (
    <SectionCard title="Medical & Health">
      <p className="text-sm text-gray-500">
        Optional health info for staff field-trip planning and emergency-responder context lands
        in a follow-up commit. Children&rsquo;s medical info is on each child&rsquo;s profile.
      </p>
    </SectionCard>
  );
}

// ─── About tab (stub) ──────────────────────────────────────

function AboutTab({ profile: _profile }: { profile: ProfileDto }) {
  return (
    <SectionCard title="About">
      <p className="text-sm text-gray-500">
        Bio, interests, and languages-spoken inputs land in a follow-up commit.
      </p>
    </SectionCard>
  );
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
