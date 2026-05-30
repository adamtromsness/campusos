'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError } from '@/lib/api-client';
import { useAuthActions } from '@/lib/auth-context';
import { useAuthStore } from '@/lib/auth-store';
import {
  useAcceptFamilyLink,
  useCheckDuplicate,
  useCreateFamilyChild,
  useGenerateFamilyCode,
  type CheckDuplicateResult,
  type GenerateLinkCodeDto,
} from '@/hooks/use-family-children';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';

/**
 * Add a person — Account Creation spec (layout, required DOB+gender,
 * duplicate detection, age-based variant). Generalises the original
 * add-child wizard: the Step-1 form now mirrors the profile Account tab
 * and the account it creates is a managed minor (≤18) or a managed adult
 * (>18, person_type GUARDIAN) with an optional "also a student" variant.
 *
 * Two steps:
 *
 *   Step 1 — Identity. First / middle / last / preferred / email /
 *            DOB* / gender* (both required to create an account). For
 *            adults, an explicit "also a student" opt-in. As the form is
 *            filled we run a privacy-safe duplicate check (email-blur or
 *            once name+DOB are present) and, on a strong match, offer to
 *            link the existing account instead of creating a duplicate.
 *
 *   Step 2 — Account decision (unchanged options A–D): placeholder only,
 *            enter their link code, create an account now, or generate a
 *            code for them to enter.
 */

// Inclusive gender options (required select). Values are stored verbatim
// on iam_person.gender (free-text column); 'F'/'M' stay compatible with
// data captured by earlier surfaces.
const GENDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'F', label: 'Female' },
  { value: 'M', label: 'Male' },
  { value: 'NONBINARY', label: 'Non-binary' },
  { value: 'OTHER', label: 'Other / self-describe' },
  { value: 'UNDISCLOSED', label: 'Prefer not to say' },
];

// The STUDENT-default age threshold from the spec (≤18). Independent of
// the COPPA/managed-minor (<13) email rule below.
const STUDENT_AGE_MAX = 18;

export default function AddChildPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { refreshUser } = useAuthActions();
  const user = useAuthStore((s) => s.user);
  const createChild = useCreateFamilyChild();
  const acceptLink = useAcceptFamilyLink();
  const checkDuplicate = useCheckDuplicate();

  const [step, setStep] = useState<1 | 2>(1);
  // Default the last name to the parent's surname — most kids share it.
  const [basic, setBasic] = useState({
    firstName: '',
    middleName: '',
    lastName: user?.lastName ?? '',
    preferredName: '',
    email: '',
    dateOfBirth: '',
    gender: '',
  });
  const [basicErrors, setBasicErrors] = useState<{
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
    gender?: string;
  }>({});

  // Step 4 — adult "also a student" opt-in (pre-unchecked, shown only >18).
  const [alsoStudent, setAlsoStudent] = useState(false);
  // Step 3 — duplicate prompt state. `dismissed` records "this is someone
  // else" so we stop re-prompting for the same identity.
  const [dupe, setDupe] = useState<CheckDuplicateResult | null>(null);
  const [dupeDismissed, setDupeDismissed] = useState(false);

  const age = ageInYears(basic.dateOfBirth);
  const isAdult = age !== null && age > STUDENT_AGE_MAX;
  // The "also a student" opt-in only applies to adults; reset it if the
  // DOB changes back into the minor range so a stale tick can't linger.
  useEffect(() => {
    if (!isAdult && alsoStudent) setAlsoStudent(false);
  }, [isAdult, alsoStudent]);

  function validateBasic() {
    const errs: typeof basicErrors = {};
    if (!basic.firstName.trim()) errs.firstName = 'First name is required';
    if (!basic.lastName.trim()) errs.lastName = 'Last name is required';
    // DOB + gender are required to create an account (spec Step 2). The
    // server enforces the same; this is the UX mirror.
    if (!basic.dateOfBirth) {
      errs.dateOfBirth = 'Date of birth is required';
    } else {
      const d = new Date(basic.dateOfBirth);
      if (Number.isNaN(d.getTime())) errs.dateOfBirth = 'Invalid date';
      else if (d > new Date()) errs.dateOfBirth = 'Date of birth cannot be in the future';
    }
    if (!basic.gender) errs.gender = 'Gender is required';
    setBasicErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function onNext(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (validateBasic()) setStep(2);
  }

  // ─── Duplicate detection ────────────────────────────────────

  // Reset the prompt whenever the identity inputs change — a stale match
  // for a previous name/email must not linger.
  useEffect(() => {
    setDupe(null);
    setDupeDismissed(false);
  }, [basic.email, basic.firstName, basic.lastName, basic.dateOfBirth]);

  async function runDuplicateCheck() {
    if (dupeDismissed) return;
    const email = basic.email.trim();
    const hasTriple =
      !!basic.firstName.trim() && !!basic.lastName.trim() && !!basic.dateOfBirth;
    // Strong-match inputs only — email, or the full name+DOB triple.
    if (!email && !hasTriple) return;
    try {
      const result = await checkDuplicate.mutateAsync({
        email: email || undefined,
        firstName: basic.firstName.trim() || undefined,
        lastName: basic.lastName.trim() || undefined,
        dateOfBirth: basic.dateOfBirth || undefined,
      });
      setDupe(result.exists ? result : null);
    } catch {
      // A failed/rate-limited check must never block creation — just skip
      // the hint. (429s are expected under rapid editing.)
      setDupe(null);
    }
  }

  async function onLinkExisting() {
    // Direct link is only offered for accounts the caller already manages
    // (see the prompt's conditional). The cross-owner claim-request flow
    // is a separate, later surface; here we route the parent to /family
    // where their managed people live.
    toast('This person is already in your family.', 'success');
    router.replace('/family');
  }

  // Used by all Step-2 choices. Returns the new child id.
  async function persistPlaceholder(): Promise<string> {
    const child = await createChild.mutateAsync({
      firstName: basic.firstName.trim(),
      middleName: basic.middleName.trim() || undefined,
      lastName: basic.lastName.trim(),
      preferredName: basic.preferredName.trim() || undefined,
      dateOfBirth: basic.dateOfBirth || undefined,
      gender: basic.gender || undefined,
    });
    return child.id;
  }

  // Variant-appropriate landing after a real account is created. The
  // child detail page renders the student-variant tabs for a LINKED
  // person; both variants live there, picked by age/person_type.
  function landingFor(childId: string): string {
    return `/family/children/${childId}`;
  }

  async function chooseNoAccount() {
    try {
      await persistPlaceholder();
      toast(`${basic.firstName} added to your family`, 'success');
      router.replace('/family');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title="Add a person"
        description={
          step === 1
            ? "Start with their details — you'll choose how to connect their account next."
            : 'Now choose how to connect them to CampusOS.'
        }
        actions={
          <Link href="/family" className="text-sm font-medium text-gray-500 hover:text-gray-700">
            Cancel
          </Link>
        }
      />

      <ol className="mb-6 flex items-center gap-2 text-xs font-medium text-gray-500">
        <li className={step >= 1 ? 'text-campus-700' : ''}>1. Details</li>
        <li aria-hidden>·</li>
        <li className={step >= 2 ? 'text-campus-700' : ''}>2. Account</li>
      </ol>

      {step === 1 ? (
        <form
          onSubmit={onNext}
          noValidate
          className="rounded-card border border-gray-200 bg-white p-5 shadow-sm"
        >
          {/* Row 1: First | Middle | Last */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              id="firstName"
              label="First name"
              value={basic.firstName}
              onChange={(v) => setBasic((b) => ({ ...b, firstName: v }))}
              error={basicErrors.firstName}
              required
            />
            <Field
              id="middleName"
              label="Middle name"
              value={basic.middleName}
              onChange={(v) => setBasic((b) => ({ ...b, middleName: v }))}
            />
            <Field
              id="lastName"
              label="Last name"
              value={basic.lastName}
              onChange={(v) => setBasic((b) => ({ ...b, lastName: v }))}
              onBlur={runDuplicateCheck}
              error={basicErrors.lastName}
              required
            />
          </div>

          {/* Preferred name */}
          <div className="mt-3">
            <Field
              id="preferredName"
              label="Preferred name"
              value={basic.preferredName}
              onChange={(v) => setBasic((b) => ({ ...b, preferredName: v }))}
              hint="If left blank, we'll use their first name."
            />
          </div>

          {/* Email */}
          <div className="mt-3">
            <Field
              id="email"
              label="Email"
              type="email"
              value={basic.email}
              onChange={(v) => setBasic((b) => ({ ...b, email: v }))}
              onBlur={runDuplicateCheck}
              hint="Optional here — required only when you create their sign-in account."
            />
          </div>

          {/* Row: DOB* | Gender* */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field
              id="dateOfBirth"
              label="Date of birth"
              type="date"
              value={basic.dateOfBirth}
              onChange={(v) => setBasic((b) => ({ ...b, dateOfBirth: v }))}
              onBlur={runDuplicateCheck}
              error={basicErrors.dateOfBirth}
              required
            />
            <div>
              <label htmlFor="gender" className="block text-xs font-medium text-gray-700">
                Gender <span className="text-red-500">*</span>
              </label>
              <select
                id="gender"
                name="gender"
                value={basic.gender}
                onChange={(e) => {
                  const gender = e.target.value;
                  setBasic((b) => ({ ...b, gender }));
                  if (basicErrors.gender) setBasicErrors((x) => ({ ...x, gender: undefined }));
                }}
                aria-invalid={!!basicErrors.gender}
                className={
                  'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
                  (basicErrors.gender ? 'border-red-300' : 'border-gray-300')
                }
              >
                <option value="">Select…</option>
                {GENDER_OPTIONS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
              {basicErrors.gender && (
                <p className="mt-1 text-xs text-red-600">{basicErrors.gender}</p>
              )}
            </div>
          </div>

          {/* Step 4 — adult "also a student" opt-in. */}
          {isAdult && (
            <label className="mt-3 flex items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                checked={alsoStudent}
                onChange={(e) => setAlsoStudent(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-campus-700 focus:ring-campus-500"
              />
              This person is also a student
            </label>
          )}

          {/* Step 3 — duplicate prompt. */}
          {dupe?.exists && !dupeDismissed && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
              <p className="text-amber-900">
                A CampusOS account may already exist for this person
                {dupe.displayName ? (
                  <>
                    {' '}
                    (<span className="font-medium">{dupe.displayName}</span>
                    {dupe.context ? <span> · {dupe.context}</span> : null})
                  </>
                ) : null}
                . To avoid duplicates,{' '}
                {dupe.alreadyManagedByCurrentUser
                  ? 'link the existing account instead of creating a new one.'
                  : 'this account is managed by someone else — they’ll need to approve a link request before it can be connected.'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {dupe.alreadyManagedByCurrentUser && (
                  <button
                    type="button"
                    onClick={() => void onLinkExisting()}
                    className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-campus-600"
                  >
                    Link existing account
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDupeDismissed(true)}
                  className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  This is someone else
                </button>
              </div>
            </div>
          )}

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
            onSuccess={async () => {
              await refreshUser();
              toast(`${basic.firstName} is now linked`, 'success');
              router.replace('/family');
            }}
          />
          <OptionC
            persistPlaceholder={persistPlaceholder}
            childAge={age}
            dateOfBirth={basic.dateOfBirth}
            gender={basic.gender}
            emailDefault={basic.email}
            onSuccess={async (childId) => {
              await refreshUser();
              toast(`${basic.firstName} now has a CampusOS account`, 'success');
              router.replace(landingFor(childId));
            }}
          />
          <OptionD persistPlaceholder={persistPlaceholder} childName={basic.firstName} />
          <div className="mt-2 flex justify-start">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              ← Back to details
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
      description="Save the details now. You can create their account or send a link invitation later."
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
      description="Enter the 8-character code from their existing CampusOS account."
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
  dateOfBirth,
  gender,
  emailDefault,
  onSuccess,
}: {
  persistPlaceholder: () => Promise<string>;
  childAge: number | null;
  dateOfBirth: string;
  gender: string;
  emailDefault: string;
  onSuccess: (childId: string) => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState(emailDefault);
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
      // Chained POST — the child id only exists after the first call.
      // DOB + gender are required server-side, so always send them.
      const { apiFetch } = await import('@/lib/api-client');
      await apiFetch(`/api/v1/family/children/${childId}/create-account`, {
        method: 'POST',
        body: JSON.stringify({
          ...(trimmed ? { email: trimmed } : {}),
          dateOfBirth: dateOfBirth || undefined,
          gender: gender || undefined,
        }),
      });
      onSuccess(childId);
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
                placeholder="person@example.com (optional)"
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
          <PrimaryButton type="submit" disabled={busy} className={isUnder13 ? 'w-full sm:w-auto' : ''}>
            {busy && <LoadingSpinner size="sm" />}
            <span>{busy ? 'Creating…' : 'Create & finish'}</span>
          </PrimaryButton>
        </form>
      }
    />
  );
}

/**
 * Option D — parent generates a FAMILY_INVITE code, the person accepts
 * it on their own CampusOS account.
 */
function OptionD({
  persistPlaceholder,
  childName,
}: {
  persistPlaceholder: () => Promise<string>;
  childName: string;
}) {
  const { toast } = useToast();
  const generate = useGenerateFamilyCode();
  const [code, setCode] = useState<GenerateLinkCodeDto | null>(null);
  const [busy, setBusy] = useState(false);

  async function onGenerate() {
    if (code) return;
    setBusy(true);
    try {
      await persistPlaceholder();
      const r = await generate.mutateAsync({});
      setCode(r);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not generate a code.';
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      toast('Code copied', 'success');
    } catch {
      toast("Couldn't copy. Select the code and copy manually.", 'error');
    }
  }

  return (
    <Card
      title="Generate a code for them to enter"
      description="Share an 8-character family code. They sign up on CampusOS and enter it to join your family — no email setup required from you."
      accent="amber"
      footer={
        !code ? (
          <PrimaryButton onClick={() => void onGenerate()} disabled={busy}>
            {busy && <LoadingSpinner size="sm" />}
            <span>{busy ? 'Generating…' : 'Generate code'}</span>
          </PrimaryButton>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
              <code className="font-mono text-base font-semibold tracking-[0.2em] text-gray-900">
                {code.code}
              </code>
              <button
                type="button"
                onClick={() => void copy()}
                className="inline-flex items-center rounded-md bg-campus-700 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-campus-600"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Share with {childName || 'them'}. Expires{' '}
              {new Date(code.expiresAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              .
            </p>
          </div>
        )
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
  onBlur,
  error,
  type = 'text',
  required,
  className,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  type?: string;
  required?: boolean;
  className?: string;
  hint?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        required={required}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={
          'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
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
