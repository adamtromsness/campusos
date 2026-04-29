'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateApplication, useEnrollmentPeriods } from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type {
  AdmissionStreamDto,
  AdmissionType,
  EnrollmentPeriodDto,
} from '@/lib/types';

interface ScreeningRow {
  questionKey: string;
  responseValue: string;
}

const ADMISSION_TYPE_LABELS: Record<AdmissionType, string> = {
  NEW_STUDENT: 'New student',
  TRANSFER: 'Transfer from another school',
  MID_YEAR_ADMISSION: 'Mid-year admission',
};

export default function NewApplicationPage() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const { toast } = useToast();
  const isGuardian = !!user && user.personType === 'GUARDIAN';
  const canApply = !!user && hasAnyPermission(user, ['stu-003:write']);
  const periods = useEnrollmentPeriods(canApply);
  const create = useCreateApplication();

  const [periodId, setPeriodId] = useState('');
  const [streamId, setStreamId] = useState('');
  const [studentFirstName, setStudentFirstName] = useState('');
  const [studentLastName, setStudentLastName] = useState('');
  const [studentDateOfBirth, setStudentDateOfBirth] = useState('');
  const [applyingForGrade, setApplyingForGrade] = useState('');
  const [admissionType, setAdmissionType] = useState<AdmissionType>('NEW_STUDENT');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [screening, setScreening] = useState<ScreeningRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Auto-populate guardian email + auto-pick the only OPEN period
  useEffect(() => {
    if (user && !guardianEmail) setGuardianEmail(user.email);
  }, [user, guardianEmail]);

  const openPeriods = (periods.data ?? []).filter((p) => p.status === 'OPEN');
  useEffect(() => {
    if (!periodId && openPeriods.length === 1) {
      const sole = openPeriods[0];
      if (sole) setPeriodId(sole.id);
    }
  }, [openPeriods, periodId]);

  if (!user) return null;
  if (!isGuardian || !canApply) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Start a new application" />
        <EmptyState
          title="Not available"
          description="Submitting applications is only available for guardian accounts."
        />
      </div>
    );
  }

  if (periods.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (openPeriods.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Start a new application" />
        <EmptyState
          title="No open admissions windows"
          description="There’s nothing open right now. Please check back later."
          action={
            <Link
              href="/apply"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
            >
              Back
            </Link>
          }
        />
      </div>
    );
  }

  const selectedPeriod: EnrollmentPeriodDto | null =
    openPeriods.find((p) => p.id === periodId) ?? null;
  const availableStreams: AdmissionStreamDto[] = (selectedPeriod?.streams ?? []).filter(
    (s) => s.isActive,
  );
  const gradeOptions = Array.from(
    new Set((selectedPeriod?.capacities ?? []).map((c) => c.gradeLevel)),
  ).sort();

  function addScreeningRow() {
    setScreening((rows) => [...rows, { questionKey: '', responseValue: '' }]);
  }
  function updateScreening(idx: number, patch: Partial<ScreeningRow>) {
    setScreening((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeScreening(idx: number) {
    setScreening((rows) => rows.filter((_, i) => i !== idx));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!periodId) return setError('Pick the enrollment period.');
    if (!studentFirstName.trim() || !studentLastName.trim())
      return setError('Student first and last name are required.');
    if (!studentDateOfBirth) return setError('Date of birth is required.');
    if (!applyingForGrade.trim()) return setError('Pick a grade.');
    if (!guardianEmail.trim()) return setError('Guardian email is required.');

    const screeningPayload = screening
      .filter((r) => r.questionKey.trim().length > 0)
      .map((r) => ({
        questionKey: r.questionKey.trim(),
        responseValue: r.responseValue,
      }));

    try {
      const created = await create.mutateAsync({
        enrollmentPeriodId: periodId,
        streamId: streamId || null,
        studentFirstName: studentFirstName.trim(),
        studentLastName: studentLastName.trim(),
        studentDateOfBirth,
        applyingForGrade: applyingForGrade.trim(),
        guardianEmail: guardianEmail.trim(),
        guardianPhone: guardianPhone.trim() || undefined,
        admissionType,
        screening: screeningPayload.length > 0 ? screeningPayload : undefined,
      });
      toast('Application submitted.', 'success');
      router.replace('/apply');
      void created;
    } catch (err: any) {
      setError(err?.message ?? 'Failed to submit the application.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/apply" className="mb-3 inline-block text-sm text-gray-500 hover:text-campus-700">
        ← Back to applications
      </Link>

      <PageHeader
        title="Start a new application"
        description="Tell us about your child. You can submit one application per child per period."
      />

      <form onSubmit={onSubmit} className="space-y-6">
        <Section title="Admission window">
          <Field label="Enrollment period" required>
            <select
              value={periodId}
              onChange={(e) => {
                setPeriodId(e.target.value);
                setStreamId('');
                setApplyingForGrade('');
              }}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              <option value="">Select a period…</option>
              {openPeriods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {availableStreams.length > 0 && (
            <Field label="Admission stream">
              <select
                value={streamId}
                onChange={(e) => setStreamId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              >
                <option value="">General intake</option>
                {availableStreams.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.gradeLevel ? ` (Grade ${s.gradeLevel})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </Section>

        <Section title="Student details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First name" required>
              <input
                value={studentFirstName}
                onChange={(e) => setStudentFirstName(e.target.value)}
                maxLength={80}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </Field>
            <Field label="Last name" required>
              <input
                value={studentLastName}
                onChange={(e) => setStudentLastName(e.target.value)}
                maxLength={80}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </Field>
            <Field label="Date of birth" required>
              <input
                type="date"
                value={studentDateOfBirth}
                onChange={(e) => setStudentDateOfBirth(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </Field>
            <Field label="Applying for grade" required>
              {gradeOptions.length > 0 ? (
                <select
                  value={applyingForGrade}
                  onChange={(e) => setApplyingForGrade(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
                >
                  <option value="">Select grade…</option>
                  {gradeOptions.map((g) => (
                    <option key={g} value={g}>
                      Grade {g}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={applyingForGrade}
                  onChange={(e) => setApplyingForGrade(e.target.value)}
                  maxLength={8}
                  placeholder="e.g. 9"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
                />
              )}
            </Field>
          </div>
          <Field label="Admission type">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(ADMISSION_TYPE_LABELS) as AdmissionType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAdmissionType(t)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                    admissionType === t
                      ? 'border-campus-500 bg-campus-50 text-campus-700'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {ADMISSION_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </Field>
        </Section>

        <Section title="Guardian contact">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Email" required>
              <input
                type="email"
                value={guardianEmail}
                onChange={(e) => setGuardianEmail(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </Field>
            <Field label="Phone (optional)">
              <input
                type="tel"
                value={guardianPhone}
                onChange={(e) => setGuardianPhone(e.target.value)}
                maxLength={32}
                placeholder="+1 555 0123"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Screening responses"
          subtitle="Answer any of the school’s admission questions. Add a row per question."
        >
          {screening.length === 0 ? (
            <p className="text-sm text-gray-500">
              No screening questions added — that’s fine, the school may follow up by email.
            </p>
          ) : (
            <ul className="space-y-2">
              {screening.map((row, idx) => (
                <li
                  key={idx}
                  className="grid grid-cols-1 gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 sm:grid-cols-12 sm:items-center"
                >
                  <input
                    value={row.questionKey}
                    onChange={(e) => updateScreening(idx, { questionKey: e.target.value })}
                    placeholder="Question key (e.g. why_us)"
                    maxLength={80}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 sm:col-span-4"
                  />
                  <input
                    value={row.responseValue}
                    onChange={(e) => updateScreening(idx, { responseValue: e.target.value })}
                    placeholder="Your answer"
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500 sm:col-span-7"
                  />
                  <button
                    type="button"
                    onClick={() => removeScreening(idx)}
                    className="text-xs text-rose-600 hover:underline sm:col-span-1"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={addScreeningRow}
            className="mt-2 text-sm font-medium text-campus-700 hover:text-campus-600"
          >
            + Add a question
          </button>
        </Section>

        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Link
            href="/apply"
            className="rounded-lg border border-gray-300 px-4 py-2 text-center text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {create.isPending ? 'Submitting…' : 'Submit application'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
      <header className="mb-3">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
