'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAuthActions } from '@/lib/auth-context';
import { useMyProfile, useUpdateMyProfile } from '@/hooks/use-profile';
import { useAcceptFamilyLink, useGenerateChildCode } from '@/hooks/use-family-children';

/**
 * /profile — self-service identity editor.
 *
 * Reads + writes the calling user's iam_person row via /profile/me.
 * Endpoint is no longer gated on usr-001:read/write so 0-persona
 * users (freshly registered, no school relationship yet) can still
 * land here and fix typos in their own name. Cross-user access is
 * impossible — the API uses req.user.personId on every read and
 * write, so the form is always editing "you."
 *
 * Form scope deliberately mirrors the iam_person columns the user is
 * allowed to set on themselves: first / middle / last / preferred
 * names, phone, date of birth. Login email is read-only here because
 * changing it requires an IdP-side verification flow that isn't built
 * yet; user shows it so the field doesn't quietly vanish from the
 * UI. Demographics / household / emergency contact / employment etc.
 * still live on dedicated surfaces (the admin profile route keeps the
 * tabbed shape).
 *
 * On successful save we refresh /auth/me into the Zustand auth store
 * so the top bar, sidebar greeting, and persona switcher pick up the
 * new firstName / preferredName immediately.
 */
export default function MyProfilePage() {
  const { refreshUser } = useAuthActions();
  const { toast } = useToast();
  const profile = useMyProfile();
  const update = useUpdateMyProfile();

  const [form, setForm] = useState<{
    firstName: string;
    middleName: string;
    lastName: string;
    preferredName: string;
    primaryPhone: string;
    dateOfBirth: string;
  } | null>(null);
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string }>({});

  // Seed the form from the API once on first load; subsequent edits
  // are owned by the form state until Save Changes lands a new
  // ProfileResponseDto, at which point we reseed.
  useEffect(() => {
    if (!profile.data || form !== null) return;
    setForm({
      firstName: profile.data.firstName ?? '',
      middleName: profile.data.middleName ?? '',
      lastName: profile.data.lastName ?? '',
      preferredName: profile.data.preferredName ?? '',
      primaryPhone: profile.data.primaryPhone ?? '',
      dateOfBirth: profile.data.dateOfBirth ?? '',
    });
  }, [profile.data, form]);

  if (profile.isLoading || !form) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (profile.isError || !profile.data) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Couldn’t load your profile"
          description="Try refreshing. If the problem persists, contact support."
        />
      </div>
    );
  }

  const p = profile.data;

  function field<K extends keyof NonNullable<typeof form>>(key: K, value: string) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    if (errors[key as keyof typeof errors]) {
      setErrors((e) => ({ ...e, [key]: undefined }));
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form) return;
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
        dateOfBirth: form.dateOfBirth ? form.dateOfBirth : null,
      });
      // Pull the fresh user shape into Zustand so the top-bar pill,
      // sidebar greeting, and persona switcher all reflect the new
      // first / preferred name without a hard refresh.
      await refreshUser();
      toast('Profile updated', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save. Try again.';
      toast(message, 'error');
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader title="My Profile" description="Your personal information" />

      <form
        onSubmit={onSubmit}
        noValidate
        className="mt-4 rounded-card border border-gray-200 bg-white p-6 shadow-sm"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="firstName"
            label="First name"
            value={form.firstName}
            onChange={(v) => field('firstName', v)}
            error={errors.firstName}
            required
            autoComplete="given-name"
          />
          <Field
            id="middleName"
            label="Middle name"
            value={form.middleName}
            onChange={(v) => field('middleName', v)}
            autoComplete="additional-name"
          />
          <Field
            id="lastName"
            label="Last name"
            value={form.lastName}
            onChange={(v) => field('lastName', v)}
            error={errors.lastName}
            required
            autoComplete="family-name"
          />
          <Field
            id="preferredName"
            label="Preferred name"
            value={form.preferredName}
            onChange={(v) => field('preferredName', v)}
            hint="Used throughout CampusOS instead of your first name."
            autoComplete="nickname"
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            id="email"
            label="Email"
            value={p.loginEmail ?? ''}
            onChange={() => {
              /* read-only */
            }}
            type="email"
            readOnly
            hint="Email changes need a separate verification flow."
          />
          <Field
            id="primaryPhone"
            label="Phone"
            value={form.primaryPhone}
            onChange={(v) => field('primaryPhone', v)}
            type="tel"
            autoComplete="tel"
          />
          <Field
            id="dateOfBirth"
            label="Date of birth"
            value={form.dateOfBirth}
            onChange={(v) => field('dateOfBirth', v)}
            type="date"
          />
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
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

      <FamilyConnectionSection />
    </div>
  );
}

// ─── Field primitive ─────────────────────────────────────

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  readOnly?: boolean;
  autoComplete?: string;
  hint?: string;
  error?: string;
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  required,
  readOnly,
  autoComplete,
  hint,
  error,
}: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        readOnly={readOnly}
        autoComplete={autoComplete}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={
          'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ' +
          'placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
          (readOnly ? 'cursor-not-allowed bg-gray-50 text-gray-500 ' : '') +
          (error ? 'border-red-300' : 'border-gray-300')
        }
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ─── Family connection ───────────────────────────────────

/**
 * Self-service surface for the bidirectional family-link feature.
 * The page doesn't know whether the caller is already LINKED into a
 * family (there's no endpoint that resolves "am I a child somewhere?"
 * yet), so we always show both options. If the user is already linked,
 * the accept endpoint surfaces a 400 inline.
 *
 *   Generate a code for your parent — POST /family/generate-child-code.
 *     Returns an 8-char CHILD_LINK token the parent enters at /family
 *     to add the user to their family as a LINKED child.
 *
 *   Enter a parent's family code — POST /family/link.
 *     Accepts both a parent's FAMILY_INVITE code (user joins the
 *     parent's family) and a parent-issued CHILD_LINK that named
 *     this user. The API dispatches on type + metadata.
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
      // Linking activates the inviter's persona, not necessarily the
      // caller's, but the wire shape may still change (e.g. linked_at
      // visible to the user). Refresh /auth/me so any persona derived
      // from this link surfaces in the top bar.
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
