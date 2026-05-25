'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, setAccessToken } from '@/lib/api-client';
import { useAuthActions } from '@/lib/auth-context';
import {
  useAuthStore,
  type ActivePersona,
  type AuthUser,
  type UserPersona,
} from '@/lib/auth-store';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

// Sentinel value used as the `busy` marker when the custom-email
// form is mid-submit; the preset buttons key their loading state on
// the account email, so a distinct token keeps the two paths from
// fighting over the same state.
const CUSTOM_EMAIL_BUSY = '__custom__';

interface MeResponse {
  user: {
    id: string;
    personId: string;
    email: string;
    firstName: string | null;
    middleName: string | null;
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

interface DevAccount {
  email: string;
  label: string;
  description: string;
}

const DEV_ACCOUNTS: DevAccount[] = [
  {
    email: 'admin@demo.campusos.dev',
    label: 'Platform Admin',
    description: 'All 444 permissions, every tenant',
  },
  {
    email: 'principal@demo.campusos.dev',
    label: 'School Admin',
    description: 'Full access within Demo Charter School',
  },
  {
    email: 'teacher@demo.campusos.dev',
    label: 'Teacher (James Rivera)',
    description: '6 classes, take attendance',
  },
  {
    email: 'student@demo.campusos.dev',
    label: 'Student (Maya Chen)',
    description: 'View own attendance and schedule',
  },
  {
    email: 'parent@demo.campusos.dev',
    label: 'Parent (David Chen)',
    description: "Maya Chen's father",
  },
  {
    email: 'newuser@demo.campusos.dev',
    label: 'New User (Alex Thompson)',
    description: 'Fresh account, no personas — exercises Getting Started',
  },
];

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuthActions();
  const queryClient = useQueryClient();
  const status = useAuthStore((s) => s.status);
  const setAuth = useAuthStore((s) => s.setAuth);
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [customEmail, setCustomEmail] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  // Same-origin only. The OIDC callback ignores any returnUrl in the
  // current URL (Keycloak strips the query string before redirect),
  // so this only matters for the dev-account shortcut path below.
  const rawReturn = searchParams?.get('returnUrl');
  const returnUrl = rawReturn && rawReturn.startsWith('/') ? rawReturn : null;
  const returnQuery = returnUrl ? '?returnUrl=' + encodeURIComponent(returnUrl) : '';

  useEffect(() => {
    if (status === 'authenticated') router.replace(returnUrl ?? '/dashboard');
  }, [status, router, returnUrl]);

  // Handle OIDC callback — Keycloak redirects back with ?token=
  useEffect(() => {
    const token = searchParams?.get('token');
    if (!token) return;
    (async () => {
      // Wipe React Query before swapping identities — see the same
      // guard in auth-context.tsx login(). Without this, a tab that
      // previously held another user's session renders that user's
      // cached /family + /profile data on first paint.
      queryClient.clear();
      setAccessToken(token);
      try {
        const me = await apiFetch<MeResponse>('/api/v1/auth/me');
        setAuth(token, meToAuthUser(me));
        router.replace(returnUrl ?? '/dashboard');
      } catch {
        toast('Could not load your profile. Please try again.', 'error');
      }
    })();
  }, [searchParams, setAuth, router, toast, returnUrl, queryClient]);

  const handleLogin = async (email: string) => {
    setBusy(email);
    try {
      await login(email, returnUrl ?? undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed. Please try again.';
      toast(message, 'error');
      setBusy(null);
    }
  };

  // Custom-email dev sign-in. Same /auth/dev-login backend as the
  // preset buttons (login() handles the POST + /auth/me follow-up) —
  // this just exposes a typed-in email path so accounts registered
  // through /register can sign in without being added to DEV_ACCOUNTS.
  const handleCustomSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = customEmail.trim();
    if (!trimmed) {
      setCustomError('Enter an email address.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setCustomError('Enter a valid email address.');
      return;
    }
    setCustomError(null);
    setBusy(CUSTOM_EMAIL_BUSY);
    try {
      await login(trimmed, returnUrl ?? undefined);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Login failed. Check the email and try again.';
      // Surface the failure inline so the user can correct without
      // dismissing a toast — same pattern as the registration form.
      setCustomError(message);
      setBusy(null);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-campus-700">CampusOS</h1>
          <p className="mt-2 text-sm text-gray-500">
            The School Operating System — sign in to continue
          </p>
        </div>

        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          <div className="border-b border-gray-100 bg-campus-50 px-5 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-campus-700">
              Development Sign-in
            </p>
            <p className="mt-0.5 text-xs text-campus-600">
              Bypasses Keycloak — for local testing only
            </p>
          </div>

          <ul className="divide-y divide-gray-100">
            {DEV_ACCOUNTS.map((acc) => {
              const loading = busy === acc.email;
              return (
                <li key={acc.email}>
                  <button
                    type="button"
                    onClick={() => handleLogin(acc.email)}
                    disabled={busy !== null}
                    className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors hover:bg-campus-50/40 disabled:opacity-60"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">{acc.label}</p>
                      <p className="text-xs text-gray-500">{acc.description}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-gray-400">{acc.email}</p>
                    </div>
                    {loading && <LoadingSpinner size="sm" />}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="h-px flex-1 bg-gray-200" aria-hidden />
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                Or sign in with email
              </span>
              <span className="h-px flex-1 bg-gray-200" aria-hidden />
            </div>
            <form onSubmit={handleCustomSubmit} className="flex flex-col gap-2 sm:flex-row">
              <label htmlFor="custom-email" className="sr-only">
                Email
              </label>
              <input
                id="custom-email"
                type="email"
                value={customEmail}
                onChange={(e) => {
                  setCustomEmail(e.target.value);
                  if (customError) setCustomError(null);
                }}
                placeholder="email@example.com"
                autoComplete="email"
                aria-invalid={!!customError}
                aria-describedby={customError ? 'custom-email-error' : undefined}
                disabled={busy !== null}
                className={
                  'block flex-1 rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ' +
                  'placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
                  'disabled:opacity-60 ' +
                  (customError ? 'border-red-300' : 'border-gray-300')
                }
              />
              <button
                type="submit"
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-1 rounded-md bg-campus-700 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
              >
                {busy === CUSTOM_EMAIL_BUSY && <LoadingSpinner size="sm" />}
                <span>{busy === CUSTOM_EMAIL_BUSY ? 'Signing in…' : 'Sign In'}</span>
              </button>
            </form>
            {customError && (
              <p id="custom-email-error" className="mt-2 text-xs text-red-600">
                {customError}
              </p>
            )}
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Tenant: <span className="font-mono">demo</span>
        </p>
        <p className="mt-3 text-center text-sm text-gray-600">
          Don&rsquo;t have an account?{' '}
          <Link
            href={'/register' + returnQuery}
            className="font-medium text-campus-700 hover:text-campus-600"
          >
            Create one
          </Link>
        </p>
        <p className="mt-1 text-center text-xs text-gray-500">
          Looking for a school?{' '}
          <Link href="/find-schools" className="font-medium text-campus-700 hover:text-campus-600">
            Find one accepting applications →
          </Link>
        </p>
      </div>
    </main>
  );
}
