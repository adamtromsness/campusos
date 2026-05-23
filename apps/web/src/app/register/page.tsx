'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, apiFetch, setAccessToken } from '@/lib/api-client';
import {
  useAuthStore,
  type ActivePersona,
  type AuthUser,
  type UserPersona,
} from '@/lib/auth-store';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

/**
 * Public registration — Section 2 / Step 1 of the persona-registration
 * design. POSTs to /api/v1/auth/register which creates the canonical
 * iam_person + platform_users + family trio and returns a JWT pair.
 *
 * On success we set the access token on the api-client, push a fresh
 * /auth/me into the auth store (so AppLayout has the right activePersona
 * — null in this case) and route to /getting-started. Brand-new
 * accounts have zero personas, which is the cue for the Getting Started
 * page to render its onboarding action cards.
 */

interface RegisterResponse {
  accessToken: string;
  user: {
    id: string;
    personId: string;
    email: string;
    displayName: string;
  };
}

interface MeResponse {
  user: {
    id: string;
    personId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    preferredName: string | null;
    displayName: string;
  };
  activePersona: ActivePersona | null;
  personas: UserPersona[];
  permissions: string[];
}

function meToAuthUser(me: MeResponse): AuthUser {
  return {
    ...me.user,
    activePersona: me.activePersona,
    personas: me.personas,
    permissions: me.permissions,
  };
}

interface FieldErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  password?: string;
  confirmPassword?: string;
}

function validate(form: {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.firstName.trim()) errors.firstName = 'First name is required';
  if (!form.lastName.trim()) errors.lastName = 'Last name is required';
  if (!form.email.trim()) {
    errors.email = 'Email is required';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    errors.email = 'Enter a valid email address';
  }
  if (!form.password) {
    errors.password = 'Password is required';
  } else if (form.password.length < 8) {
    errors.password = 'At least 8 characters';
  }
  if (!form.confirmPassword) {
    errors.confirmPassword = 'Please confirm your password';
  } else if (form.confirmPassword !== form.password) {
    errors.confirmPassword = 'Passwords do not match';
  }
  return errors;
}

export default function RegisterPage() {
  const router = useRouter();
  const { toast } = useToast();
  const status = useAuthStore((s) => s.status);
  const setAuth = useAuthStore((s) => s.setAuth);

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // If someone already has a session, send them home.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key as keyof FieldErrors]) {
      setErrors((e) => ({ ...e, [key]: undefined }));
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = validate(form);
    if (Object.keys(v).length > 0) {
      setErrors(v);
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<RegisterResponse>('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
          password: form.password,
        }),
      });
      setAccessToken(res.accessToken);
      const me = await apiFetch<MeResponse>('/api/v1/auth/me');
      setAuth(res.accessToken, meToAuthUser(me));
      router.replace('/getting-started');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setErrors((prev) => ({
          ...prev,
          email: 'An account with this email already exists. Sign in instead.',
        }));
      } else {
        const message =
          err instanceof Error ? err.message : 'Could not create your account. Please try again.';
        toast(message, 'error');
      }
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-campus-700">CampusOS</h1>
          <p className="mt-2 text-sm text-gray-500">Create your account</p>
        </div>

        <form
          onSubmit={onSubmit}
          noValidate
          className="overflow-hidden rounded-card border border-gray-200 bg-white p-6 shadow-card"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field
              id="firstName"
              label="First name"
              value={form.firstName}
              onChange={(v) => set('firstName', v)}
              error={errors.firstName}
              autoComplete="given-name"
              required
            />
            <Field
              id="lastName"
              label="Last name"
              value={form.lastName}
              onChange={(v) => set('lastName', v)}
              error={errors.lastName}
              autoComplete="family-name"
              required
            />
          </div>

          <Field
            id="email"
            label="Email"
            type="email"
            value={form.email}
            onChange={(v) => set('email', v)}
            error={errors.email}
            autoComplete="email"
            required
            className="mt-3"
          />

          <Field
            id="phone"
            label="Phone (optional)"
            type="tel"
            value={form.phone}
            onChange={(v) => set('phone', v)}
            error={errors.phone}
            autoComplete="tel"
            className="mt-3"
          />

          <div className="mt-3">
            <label htmlFor="password" className="block text-xs font-medium text-gray-700">
              Password
            </label>
            <div className="relative mt-1">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                autoComplete="new-password"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'password-error' : undefined}
                className={
                  'block w-full rounded-md border bg-white px-3 py-2 pr-12 text-sm text-gray-900 ' +
                  'shadow-sm placeholder:text-gray-400 ' +
                  'focus:outline-none focus:ring-2 focus:ring-campus-500 focus:border-campus-500 ' +
                  (errors.password ? 'border-red-300' : 'border-gray-300')
                }
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-2 px-2 text-xs font-medium text-gray-500 hover:text-gray-700"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            {errors.password ? (
              <p id="password-error" className="mt-1 text-xs text-red-600">
                {errors.password}
              </p>
            ) : (
              <p className="mt-1 text-xs text-gray-500">At least 8 characters.</p>
            )}
          </div>

          <Field
            id="confirmPassword"
            label="Confirm password"
            type={showPassword ? 'text' : 'password'}
            value={form.confirmPassword}
            onChange={(v) => set('confirmPassword', v)}
            error={errors.confirmPassword}
            autoComplete="new-password"
            required
            className="mt-3"
          />

          <button
            type="submit"
            disabled={submitting}
            className={
              'mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-campus-700 px-3 py-2 ' +
              'text-sm font-semibold text-white shadow-sm transition-colors ' +
              'hover:bg-campus-600 focus:outline-none focus:ring-2 focus:ring-campus-500 focus:ring-offset-2 ' +
              'disabled:opacity-60'
            }
          >
            {submitting && <LoadingSpinner size="sm" />}
            <span>{submitting ? 'Creating account…' : 'Create Account'}</span>
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-campus-700 hover:text-campus-600">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  className?: string;
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  type = 'text',
  autoComplete,
  required,
  className,
}: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={
          'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 ' +
          'shadow-sm placeholder:text-gray-400 ' +
          'focus:outline-none focus:ring-2 focus:ring-campus-500 focus:border-campus-500 ' +
          (error ? 'border-red-300' : 'border-gray-300')
        }
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
