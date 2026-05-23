'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-client';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

/**
 * /substitute/register — self-service onboarding for the SUBSTITUTE
 * persona. Reached from the Getting Started "I want to substitute
 * teach" card.
 *
 * On submit POSTs to /api/v1/substitutes/register (authenticated, no
 * permission required), which creates the platform_substitute_profiles
 * row + refreshes the persona cache so SUBSTITUTE surfaces on the
 * next /auth/me. We then invalidate every React Query cache so the
 * launchpad reflects the new persona and route to /dashboard.
 */

const GRADE_BANDS: Array<{ value: string; label: string }> = [
  { value: 'K-2', label: 'K – 2' },
  { value: '3-5', label: '3 – 5' },
  { value: '6-8', label: '6 – 8' },
  { value: '9-12', label: '9 – 12' },
];

// Loose canonical list — refined when the curriculum-subjects catalogue
// lands. The substitute matching engine accepts any string in
// subject_areas[].
const SUBJECT_OPTIONS = [
  'English',
  'Math',
  'Science',
  'Social Studies',
  'World Languages',
  'Music',
  'Art',
  'PE',
  'Computer Science',
  'Special Education',
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

interface SubmitResponse {
  id: string;
  personId: string;
}

export default function SubstituteRegisterPage() {
  const router = useRouter();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [qualifications, setQualifications] = useState('');
  const [gradeLevels, setGradeLevels] = useState<string[]>([]);
  const [subjectAreas, setSubjectAreas] = useState<string[]>([]);
  const [availability, setAvailability] = useState<string[]>([]);
  const [preferredSchools, setPreferredSchools] = useState('');
  const [yearsExperience, setYearsExperience] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(list: string[], value: string, setter: (next: string[]) => void) {
    if (list.includes(value)) {
      setter(list.filter((v) => v !== value));
    } else {
      setter([...list, value]);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (gradeLevels.length === 0) {
      setError('Pick at least one grade band you can cover.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // The current API surface accepts gradeLevels + subjectAreas +
      // bio + yearsExperience. We pack qualifications + availability +
      // preferredSchools + notes into the bio field for now; richer
      // structured columns land when the substitute marketplace grows
      // first-class fields for them.
      const bioBlocks: string[] = [];
      if (qualifications.trim()) bioBlocks.push('Qualifications:\n' + qualifications.trim());
      if (availability.length > 0) bioBlocks.push('Available: ' + availability.join(', '));
      if (preferredSchools.trim()) bioBlocks.push('Preferred schools: ' + preferredSchools.trim());
      if (notes.trim()) bioBlocks.push(notes.trim());
      const bio = bioBlocks.join('\n\n') || undefined;

      const years = yearsExperience.trim() ? Number(yearsExperience) : undefined;

      await apiFetch<SubmitResponse>('/api/v1/substitutes/register', {
        method: 'POST',
        body: JSON.stringify({
          gradeLevels,
          subjectAreas: subjectAreas.length > 0 ? subjectAreas : undefined,
          yearsExperience: Number.isFinite(years) ? years : undefined,
          bio,
        }),
      });
      // Drop every cached query so the launchpad rebuilds under the new
      // SUBSTITUTE persona's permission set and the persona switcher
      // picks up the freshly-activated row.
      await queryClient.invalidateQueries();
      toast('You’re registered as a substitute', 'success');
      router.replace('/dashboard');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Could not register your substitute profile. Please try again.';
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title="Register as a substitute teacher"
        description="Tell us where and what you can teach. You can refine the details later from your profile."
        actions={
          <Link
            href="/getting-started"
            className="text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            Cancel
          </Link>
        }
      />

      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-5 rounded-card border border-gray-200 bg-white p-5 shadow-sm"
      >
        <Field
          label="Qualifications / certifications"
          htmlFor="qualifications"
          help="State licence numbers, ESL endorsements, special-ed credentials — anything an administrator would want to see."
        >
          <textarea
            id="qualifications"
            value={qualifications}
            onChange={(e) => setQualifications(e.target.value)}
            rows={3}
            className={inputCls(false)}
          />
        </Field>

        <Field
          label="Grade levels you can cover"
          htmlFor="grade-levels"
          required
          help="Pick every band you'd be comfortable substituting for."
        >
          <div id="grade-levels" className="flex flex-wrap gap-2">
            {GRADE_BANDS.map((g) => {
              const on = gradeLevels.includes(g.value);
              return (
                <button
                  type="button"
                  key={g.value}
                  onClick={() => toggle(gradeLevels, g.value, setGradeLevels)}
                  className={chipCls(on)}
                >
                  {g.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field
          label="Subjects you can teach"
          htmlFor="subjects"
          help="Optional — leave blank for generalists."
        >
          <div id="subjects" className="flex flex-wrap gap-2">
            {SUBJECT_OPTIONS.map((s) => {
              const on = subjectAreas.includes(s);
              return (
                <button
                  type="button"
                  key={s}
                  onClick={() => toggle(subjectAreas, s, setSubjectAreas)}
                  className={chipCls(on)}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </Field>

        <Field
          label="Availability"
          htmlFor="availability"
          help="Pick the weekdays you're typically free."
        >
          <div id="availability" className="flex flex-wrap gap-2">
            {DAYS.map((d) => {
              const on = availability.includes(d);
              return (
                <button
                  type="button"
                  key={d}
                  onClick={() => toggle(availability, d, setAvailability)}
                  className={chipCls(on)}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Years of experience" htmlFor="years-experience">
            <input
              id="years-experience"
              type="number"
              min={0}
              value={yearsExperience}
              onChange={(e) => setYearsExperience(e.target.value)}
              className={inputCls(false)}
            />
          </Field>
          <Field
            label="Preferred schools"
            htmlFor="preferred-schools"
            help="Optional — comma-separated, names or subdomains."
          >
            <input
              id="preferred-schools"
              type="text"
              value={preferredSchools}
              onChange={(e) => setPreferredSchools(e.target.value)}
              placeholder="Demo, Lincoln Elementary"
              className={inputCls(false)}
            />
          </Field>
        </div>

        <Field
          label="Notes for administrators"
          htmlFor="notes"
          help="Anything else you'd like a hiring admin to see — recent reviews, distance preferences, etc."
        >
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className={inputCls(false)}
          />
        </Field>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <Link
            href="/getting-started"
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
          >
            {submitting && <LoadingSpinner size="sm" />}
            <span>{submitting ? 'Registering…' : 'Register'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── primitives ─────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  help,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <div className="mt-1">{children}</div>
      {help && <p className="mt-1 text-xs text-gray-500">{help}</p>}
    </div>
  );
}

function inputCls(error: boolean): string {
  return (
    'block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ' +
    'placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 ' +
    (error ? 'border-red-300' : 'border-gray-300')
  );
}

function chipCls(on: boolean): string {
  return (
    'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
    (on
      ? 'border-campus-500 bg-campus-50 text-campus-700'
      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
  );
}
