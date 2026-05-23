'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError } from '@/lib/api-client';
import { useAcceptFamilyLink, useCreateFamilyChild } from '@/hooks/use-family-children';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';

/**
 * Add child wizard — Section 3 of the persona-registration design.
 *
 * Two steps:
 *
 *   Step 1 — Basic info (first / last / DOB / gender)
 *
 *   Step 2 — Account decision. Three options:
 *
 *     A) "They don't have an account yet"
 *        Persist PLACEHOLDER, redirect to /family. Parent can create
 *        the account or send a link later.
 *
 *     B) "I have their link code"
 *        Persist PLACEHOLDER, then immediately call POST /family/link
 *        with the supplied 8-char code. On 404, surface inline ("Code
 *        not found"); the placeholder row stays so the parent can
 *        retry without re-entering the basic info.
 *
 *     C) "Create an account for them"
 *        Persist PLACEHOLDER, then call POST
 *        /family/children/:id/create-account. The COPPA gate refuses
 *        an email on under-13 accounts at the API; we mirror that
 *        client-side by disabling the email field when DOB resolves
 *        to <13.
 */
export default function AddChildPage() {
  const router = useRouter();
  const { toast } = useToast();
  const createChild = useCreateFamilyChild();
  const acceptLink = useAcceptFamilyLink();
  // We pre-bind the per-child account mutation lazily — see step-2
  // submit handlers below.
  const [step, setStep] = useState<1 | 2>(1);
  const [basic, setBasic] = useState({ firstName: '', lastName: '', dateOfBirth: '', gender: '' });
  const [basicErrors, setBasicErrors] = useState<{
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
  }>({});

  function validateBasic() {
    const errs: typeof basicErrors = {};
    if (!basic.firstName.trim()) errs.firstName = 'First name is required';
    if (!basic.lastName.trim()) errs.lastName = 'Last name is required';
    if (basic.dateOfBirth) {
      const d = new Date(basic.dateOfBirth);
      if (Number.isNaN(d.getTime())) errs.dateOfBirth = 'Invalid date';
      else if (d > new Date()) errs.dateOfBirth = 'Date of birth cannot be in the future';
    }
    setBasicErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function onNext(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (validateBasic()) setStep(2);
  }

  const age = ageInYears(basic.dateOfBirth);

  // Used by all three Step-2 choices. Returns the newly-created
  // child id so the chained mutations can target it.
  async function persistPlaceholder(): Promise<string> {
    const child = await createChild.mutateAsync({
      firstName: basic.firstName.trim(),
      lastName: basic.lastName.trim(),
      dateOfBirth: basic.dateOfBirth || undefined,
      gender: basic.gender || undefined,
    });
    return child.id;
  }

  async function chooseNoAccount() {
    try {
      await persistPlaceholder();
      toast(`${basic.firstName} added to your family`, 'success');
      router.replace('/family');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save.';
      toast(message, 'error');
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title="Add a child"
        description={
          step === 1
            ? "Start with the basics — you'll choose how to connect their account next."
            : 'Now choose how to connect them to CampusOS.'
        }
        actions={
          <Link href="/family" className="text-sm font-medium text-gray-500 hover:text-gray-700">
            Cancel
          </Link>
        }
      />

      <ol className="mb-6 flex items-center gap-2 text-xs font-medium text-gray-500">
        <li className={step >= 1 ? 'text-campus-700' : ''}>1. Basic info</li>
        <li aria-hidden>·</li>
        <li className={step >= 2 ? 'text-campus-700' : ''}>2. Account</li>
      </ol>

      {step === 1 ? (
        <form
          onSubmit={onNext}
          noValidate
          className="rounded-card border border-gray-200 bg-white p-5 shadow-sm"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="firstName"
              label="First name"
              value={basic.firstName}
              onChange={(v) => setBasic((b) => ({ ...b, firstName: v }))}
              error={basicErrors.firstName}
              required
            />
            <Field
              id="lastName"
              label="Last name"
              value={basic.lastName}
              onChange={(v) => setBasic((b) => ({ ...b, lastName: v }))}
              error={basicErrors.lastName}
              required
            />
          </div>
          <Field
            id="dateOfBirth"
            label="Date of birth"
            type="date"
            value={basic.dateOfBirth}
            onChange={(v) => setBasic((b) => ({ ...b, dateOfBirth: v }))}
            error={basicErrors.dateOfBirth}
            className="mt-3"
          />
          <div className="mt-3">
            <label htmlFor="gender" className="block text-xs font-medium text-gray-700">
              Gender (optional)
            </label>
            <select
              id="gender"
              name="gender"
              value={basic.gender}
              onChange={(e) => setBasic((b) => ({ ...b, gender: e.target.value }))}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500"
            >
              <option value="">Prefer not to say</option>
              <option value="F">Female</option>
              <option value="M">Male</option>
              <option value="X">Non-binary</option>
              <option value="O">Other</option>
            </select>
          </div>
          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-600"
            >
              Next
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <OptionA onChoose={chooseNoAccount} busy={createChild.isPending} />
          <OptionB
            persistPlaceholder={persistPlaceholder}
            acceptLink={acceptLink.mutateAsync}
            onSuccess={() => {
              toast(`${basic.firstName} is now linked`, 'success');
              router.replace('/family');
            }}
          />
          <OptionC
            persistPlaceholder={persistPlaceholder}
            childAge={age}
            onSuccess={() => {
              toast(`${basic.firstName} now has a CampusOS account`, 'success');
              router.replace('/family');
            }}
          />
          <div className="mt-2 flex justify-start">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              ← Back to basic info
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Option cards ─────────────────────────────────────────

function OptionA({ onChoose, busy }: { onChoose: () => Promise<void>; busy: boolean }) {
  return (
    <Card
      title="They don't have an account yet"
      description="Save the basics now. You can create their account or send a link invitation later."
      accent="amber"
      footer={
        <PrimaryButton onClick={() => void onChoose()} disabled={busy}>
          {busy && <LoadingSpinner size="sm" />}
          <span>{busy ? 'Saving…' : 'Add as placeholder'}</span>
        </PrimaryButton>
      }
    />
  );
}

function OptionB({
  persistPlaceholder,
  acceptLink,
  onSuccess,
}: {
  persistPlaceholder: () => Promise<string>;
  acceptLink: (payload: { code: string }) => Promise<unknown>;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const cleaned = code.trim().toUpperCase().replace(/-/g, '');
    if (cleaned.length !== 8) {
      setError('Codes are 8 characters.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // The link code is the child's; the placeholder we create is
      // the parent's slot. The accept call links the child's
      // canonical iam_person via the invitation's metadata
      // (familyChildId points at the inviter's family_child row, not
      // ours). The accepter persona is the caller, so the linked
      // child surfaces in the INVITER's family — not always what the
      // user wants but it matches the API behaviour.
      await persistPlaceholder();
      await acceptLink({ code: cleaned });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError('Invalid or expired link code.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Try again in a few minutes.');
      } else {
        const message = err instanceof Error ? err.message : 'Could not link the code.';
        toast(message, 'error');
      }
      setBusy(false);
    }
  }

  return (
    <Card
      title="I have their link code"
      description="Enter the 8-character code from your child's existing CampusOS account."
      accent="green"
      footer={
        <form onSubmit={onSubmit} className="flex w-full flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex-1">
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
                'block w-full rounded-md border bg-white px-3 py-2 font-mono text-sm uppercase tracking-wider text-gray-900 shadow-sm placeholder:font-mono placeholder:text-gray-300 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
                (error ? 'border-red-300' : 'border-gray-300')
              }
            />
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          </div>
          <PrimaryButton type="submit" disabled={busy}>
            {busy && <LoadingSpinner size="sm" />}
            <span>{busy ? 'Linking…' : 'Link & finish'}</span>
          </PrimaryButton>
        </form>
      }
    />
  );
}

function OptionC({
  persistPlaceholder,
  childAge,
  onSuccess,
}: {
  persistPlaceholder: () => Promise<string>;
  childAge: number | null;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isUnder13 = childAge !== null && childAge < 13;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email or leave blank.');
      return;
    }
    if (isUnder13 && trimmed) {
      setError('Under-13 accounts are parent-managed and can’t carry their own email.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const childId = await persistPlaceholder();
      // Chained POST — we can't pre-bind the mutation hook because
      // the child id only exists after the first call. Use apiFetch
      // directly so the chain stays in the same handler.
      const { apiFetch } = await import('@/lib/api-client');
      await apiFetch(`/api/v1/family/children/${childId}/create-account`, {
        method: 'POST',
        body: JSON.stringify(trimmed ? { email: trimmed } : {}),
      });
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create the account.';
      toast(message, 'error');
      setBusy(false);
    }
  }

  return (
    <Card
      title="Create an account for them"
      description={
        isUnder13
          ? 'Under-13 accounts are parent-managed (COPPA). No child email required.'
          : "Provide their email, or leave blank if you'll manage their account."
      }
      accent="purple"
      footer={
        <form onSubmit={onSubmit} className="flex w-full flex-col gap-2 sm:flex-row sm:items-start">
          {!isUnder13 ? (
            <div className="flex-1">
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="kid@example.com (optional)"
                autoComplete="off"
                aria-invalid={!!error}
                className={
                  'block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
                  (error ? 'border-red-300' : 'border-gray-300')
                }
              />
              {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
            </div>
          ) : null}
          <PrimaryButton
            type="submit"
            disabled={busy}
            className={isUnder13 ? 'w-full sm:w-auto' : ''}
          >
            {busy && <LoadingSpinner size="sm" />}
            <span>{busy ? 'Creating…' : 'Create & finish'}</span>
          </PrimaryButton>
        </form>
      }
    />
  );
}

// ─── shared primitives ───────────────────────────────────

type Accent = 'amber' | 'green' | 'purple';
const ACCENTS: Record<Accent, string> = {
  amber: 'border-l-amber-400',
  green: 'border-l-green-400',
  purple: 'border-l-purple-400',
};

function Card({
  title,
  description,
  accent,
  footer,
}: {
  title: string;
  description: string;
  accent: Accent;
  footer: React.ReactNode;
}) {
  return (
    <div
      className={
        'rounded-card border border-l-4 border-gray-200 bg-white p-5 shadow-sm ' + ACCENTS[accent]
      }
    >
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{description}</p>
      <div className="mt-4">{footer}</div>
    </div>
  );
}

function PrimaryButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={
        'inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60 ' +
        (className ?? '')
      }
    >
      {children}
    </button>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  type = 'text',
  required,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  required?: boolean;
  className?: string;
}) {
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
        required={required}
        aria-invalid={!!error}
        className={
          'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
          (error ? 'border-red-300' : 'border-gray-300')
        }
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function ageInYears(dateString: string): number | null {
  if (!dateString) return null;
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
