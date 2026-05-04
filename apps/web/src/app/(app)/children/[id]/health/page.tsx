'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useStudent } from '@/hooks/use-children';
import {
  useConditions,
  useDietaryProfile,
  useHealthRecord,
  useImmunisations,
  useStudentMedications,
  useStudentVisits,
} from '@/hooks/use-health';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  IMMUNISATION_STATUS_LABELS,
  IMMUNISATION_STATUS_PILL,
  MEDICATION_ROUTE_LABELS,
  SEVERITY_LABELS,
  SEVERITY_PILL,
  formatDate,
  formatTime,
} from '@/lib/health-format';
import type { ImmunisationDto } from '@/lib/types';

/* /children/[id]/health — parent read-only health summary.
 * Per the Cycle 10 plan: allergies + active conditions (name + severity
 * only, no management plan) + immunisation status + medication schedule
 * + recent nurse visits. NO IEP / screening / admin notes / med-admin
 * log on this surface — those stay staff-side. The backend endpoints
 * already strip management_plan and emergency_medical_notes for the
 * GUARDIAN persona via the Step 5 visibility model.
 */

export default function ChildHealthPage() {
  const params = useParams<{ id: string }>();
  const studentId = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['hlt-001:read']);

  const student = useStudent(studentId);
  const record = useHealthRecord(studentId, canRead);
  const conditions = useConditions(studentId, canRead);
  const immunisations = useImmunisations(studentId, canRead);
  const medications = useStudentMedications(studentId, canRead);
  const visits = useStudentVisits(studentId, canRead);
  const dietary = useDietaryProfile(studentId, canRead);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <PageHeader title="Health summary" />
        <EmptyState
          title="Health is not available for your account"
          description="Your role does not include health-record read access."
        />
      </div>
    );
  }

  if (student.isLoading) return <LoadingSpinner />;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader
        title={student.data?.fullName ?? 'Health summary'}
        description={
          student.data?.gradeLevel
            ? `Grade ${student.data.gradeLevel} · Health summary`
            : 'Health summary'
        }
        actions={
          <Link
            href="/children"
            className="text-sm font-medium text-campus-600 hover:text-campus-700"
          >
            ← My children
          </Link>
        }
      />

      {/* No record on file — fall back to a single empty state so the page
          isn't a tower of stat-empty cards. */}
      {!record.isLoading && !record.data ? (
        <EmptyState
          title="No health record on file"
          description="The school nurse has not yet started a health record. Reach out to the front office if your child has medical conditions, allergies, or medications they need recorded."
        />
      ) : (
        <>
          <AllergiesCard loading={record.isLoading} data={record.data?.allergies ?? null} />
          <ConditionsCard loading={conditions.isLoading} data={conditions.data ?? null} />
          <ImmunisationsCard loading={immunisations.isLoading} data={immunisations.data ?? null} />
          <MedicationsCard loading={medications.isLoading} data={medications.data ?? null} />
          <DietaryCard loading={dietary.isLoading} data={dietary.data ?? null} />
          <VisitsCard loading={visits.isLoading} data={visits.data ?? null} />
        </>
      )}
    </div>
  );
}

// ─── Sections ──────────────────────────────────────────────

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="border-b border-gray-200 p-4">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {description ? <p className="text-sm text-gray-500">{description}</p> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function AllergiesCard({
  loading,
  data,
}: {
  loading: boolean;
  data: NonNullable<ReturnType<typeof useHealthRecord>['data']>['allergies'] | null;
}) {
  return (
    <Card title="Allergies">
      {loading ? (
        <LoadingSpinner />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-gray-500">None on file.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((a, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span
                className={
                  'rounded-full px-2 py-0.5 text-xs font-medium ' + SEVERITY_PILL[a.severity]
                }
              >
                {SEVERITY_LABELS[a.severity]}
              </span>
              <div className="flex-1">
                <p className="font-medium text-gray-900">{a.allergen}</p>
                {a.reaction ? (
                  <p className="text-xs text-gray-600">Reaction: {a.reaction}</p>
                ) : null}
                {a.notes ? <p className="text-xs text-gray-500">{a.notes}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ConditionsCard({
  loading,
  data,
}: {
  loading: boolean;
  data: NonNullable<ReturnType<typeof useConditions>['data']> | null;
}) {
  return (
    <Card title="Active conditions">
      {loading ? (
        <LoadingSpinner />
      ) : !data || data.filter((c) => c.isActive).length === 0 ? (
        <p className="text-sm text-gray-500">None on file.</p>
      ) : (
        <ul className="space-y-2">
          {data
            .filter((c) => c.isActive)
            .map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-gray-900">{c.conditionName}</span>
                <span
                  className={
                    'rounded-full px-2 py-0.5 text-xs font-medium ' + SEVERITY_PILL[c.severity]
                  }
                >
                  {SEVERITY_LABELS[c.severity]}
                </span>
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

function ImmunisationsCard({
  loading,
  data,
}: {
  loading: boolean;
  data: ImmunisationDto[] | null;
}) {
  return (
    <Card title="Immunisations">
      {loading ? (
        <LoadingSpinner />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-gray-500">No immunisation records on file.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-gray-900">{i.vaccineName}</span>
              <span
                className={
                  'rounded-full px-2 py-0.5 text-xs font-medium ' +
                  IMMUNISATION_STATUS_PILL[i.status]
                }
              >
                {IMMUNISATION_STATUS_LABELS[i.status]}
              </span>
              {i.administeredDate ? (
                <span className="text-xs text-gray-500">
                  Last dose {formatDate(i.administeredDate)}
                </span>
              ) : null}
              {i.dueDate ? (
                <span className="text-xs text-gray-500">Due {formatDate(i.dueDate)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MedicationsCard({
  loading,
  data,
}: {
  loading: boolean;
  data: NonNullable<ReturnType<typeof useStudentMedications>['data']> | null;
}) {
  const active = (data ?? []).filter((m) => m.isActive);
  return (
    <Card title="Medication schedule">
      {loading ? (
        <LoadingSpinner />
      ) : active.length === 0 ? (
        <p className="text-sm text-gray-500">No active medications on file.</p>
      ) : (
        <ul className="space-y-3">
          {active.map((m) => (
            <li key={m.id} className="rounded-md border border-gray-100 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{m.medicationName}</span>
                <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                  {MEDICATION_ROUTE_LABELS[m.route]}
                </span>
                {m.isSelfAdministered ? (
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200">
                    Self-administered
                  </span>
                ) : null}
              </div>
              {m.dosage ? <p className="mt-1 text-xs text-gray-600">Dose: {m.dosage}</p> : null}
              {m.frequency ? (
                <p className="text-xs text-gray-600">Frequency: {m.frequency}</p>
              ) : null}
              {(m.schedule ?? []).length > 0 ? (
                <p className="mt-1 text-xs text-gray-500">
                  Times: {(m.schedule ?? []).map((s) => formatTime(s.scheduledTime)).join(' · ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DietaryCard({
  loading,
  data,
}: {
  loading: boolean;
  data: ReturnType<typeof useDietaryProfile>['data'] | null;
}) {
  return (
    <Card title="Dietary">
      {loading ? (
        <LoadingSpinner />
      ) : !data ? (
        <p className="text-sm text-gray-500">No dietary profile on file.</p>
      ) : (
        <div className="space-y-2 text-sm">
          {data.dietaryRestrictions.length > 0 ? (
            <p>
              <span className="font-medium text-gray-900">Restrictions:</span>{' '}
              {data.dietaryRestrictions.join(', ')}
            </p>
          ) : null}
          {data.allergens.length > 0 ? (
            <div>
              <p className="font-medium text-gray-900">Cafeteria allergens:</p>
              <ul className="mt-1 space-y-1">
                {data.allergens.map((a, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-xs font-medium ' + SEVERITY_PILL[a.severity]
                      }
                    >
                      {SEVERITY_LABELS[a.severity]}
                    </span>
                    <span>{a.allergen}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {data.posAllergenAlert ? (
            <p className="rounded-md bg-rose-50 px-3 py-2 text-rose-800 ring-1 ring-rose-200">
              Cafeteria POS shows an allergen alert at checkout.
            </p>
          ) : null}
          {data.specialMealInstructions ? (
            <p className="text-gray-700">{data.specialMealInstructions}</p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function VisitsCard({
  loading,
  data,
}: {
  loading: boolean;
  data: NonNullable<ReturnType<typeof useStudentVisits>['data']> | null;
}) {
  const recent = (data ?? []).slice(0, 5);
  return (
    <Card title="Recent nurse visits" description="The most recent five visits.">
      {loading ? (
        <LoadingSpinner />
      ) : recent.length === 0 ? (
        <p className="text-sm text-gray-500">No nurse visits on file.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {recent.map((v) => (
            <li key={v.id} className="rounded-md border border-gray-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-gray-900">{formatDate(v.visitDate)}</span>
                {v.sentHome ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                    Sent home
                  </span>
                ) : null}
                {v.parentNotified ? (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                    Parent notified
                  </span>
                ) : null}
              </div>
              {v.reason ? <p className="mt-1 text-gray-700">{v.reason}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
