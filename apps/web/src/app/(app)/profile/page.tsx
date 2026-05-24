'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAuthActions } from '@/lib/auth-context';
import { useMyProfile, useUpdateMyProfile } from '@/hooks/use-profile';

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
