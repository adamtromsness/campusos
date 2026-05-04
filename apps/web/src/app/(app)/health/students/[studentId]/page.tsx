'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useConditions,
  useDietaryProfile,
  useHealthRecord,
  useIepPlan,
  useImmunisations,
  useNurseVisits,
  useStudentMedications,
} from '@/hooks/use-health';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  IMMUNISATION_STATUS_LABELS,
  IMMUNISATION_STATUS_PILL,
  MEDICATION_ROUTE_LABELS,
  NURSE_VISIT_STATUS_LABELS,
  NURSE_VISIT_STATUS_PILL,
  SEVERITY_LABELS,
  SEVERITY_PILL,
  formatDate,
  formatDateTime,
  formatTime,
  studentDisplayName,
} from '@/lib/health-format';
import type { ImmunisationDto } from '@/lib/types';

type Tab = 'overview' | 'conditions' | 'immunisations' | 'medications' | 'visits' | 'dietary';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'conditions', label: 'Conditions' },
  { value: 'immunisations', label: 'Immunisations' },
  { value: 'medications', label: 'Medications' },
  { value: 'visits', label: 'Visits' },
  { value: 'dietary', label: 'Dietary' },
];

export default function StudentHealthPage() {
  const params = useParams<{ studentId: string }>();
  const studentId = params.studentId;
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['hlt-001:read']);
  const [tab, setTab] = useState<Tab>('overview');

  const record = useHealthRecord(studentId, canRead);

  if (!canRead) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <PageHeader title="Student health record" />
        <EmptyState
          title="Not available"
          description="Your role does not include health-record read access."
        />
      </div>
    );
  }

  if (record.isLoading)
    return (
      <div className="p-6">
        <LoadingSpinner />
      </div>
    );
  if (!record.data) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <PageHeader title="Student health record" />
        <EmptyState
          title="No health record on file"
          description="A nurse or admin can create a health record for this student via POST /health/students/:studentId."
        />
      </div>
    );
  }

  const r = record.data;
  const fullName = studentDisplayName(r.studentFirstName, r.studentLastName, r.studentId);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title={fullName}
        description="Health record"
        actions={
          <Link
            href="/health"
            className="text-sm font-medium text-campus-600 hover:text-campus-700"
          >
            ← Back to dashboard
          </Link>
        }
      />

      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="flex flex-wrap gap-1 border-b border-gray-200 p-2">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={
                'rounded-md px-3 py-1.5 text-sm font-medium ' +
                (tab === t.value
                  ? 'bg-campus-100 text-campus-800'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-4">
          {tab === 'overview' ? <OverviewTab record={r} /> : null}
          {tab === 'conditions' ? <ConditionsTab studentId={studentId} /> : null}
          {tab === 'immunisations' ? <ImmunisationsTab studentId={studentId} /> : null}
          {tab === 'medications' ? <MedicationsTab studentId={studentId} /> : null}
          {tab === 'visits' ? <VisitsTab studentId={studentId} /> : null}
          {tab === 'dietary' ? <DietaryTab studentId={studentId} /> : null}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ record }: { record: ReturnType<typeof useHealthRecord>['data'] & {} }) {
  const iep = useIepPlan(record.studentId);
  const plan = iep.data;
  return (
    <div className="space-y-4">
      {plan && plan.status !== 'EXPIRED' ? (
        <Link
          href={`/health/iep-plans/${plan.id}?studentId=${record.studentId}`}
          className="block rounded-md border border-violet-200 bg-violet-50 p-3 text-sm hover:bg-violet-100"
        >
          <p className="font-semibold text-violet-900">
            {plan.planType === 'IEP' ? 'IEP' : '504 Plan'} on file · {plan.status.toLowerCase()}
          </p>
          <p className="mt-1 text-xs text-violet-800">
            {plan.goals.length} goal{plan.goals.length === 1 ? '' : 's'} ·{' '}
            {plan.accommodations.length} accommodation
            {plan.accommodations.length === 1 ? '' : 's'} · open editor →
          </p>
        </Link>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Blood type" value={record.bloodType ?? '—'} />
        <Field
          label="Physician"
          value={
            record.physicianName
              ? record.physicianName + (record.physicianPhone ? ' · ' + record.physicianPhone : '')
              : '—'
          }
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900">Allergies</h3>
        {record.allergies.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">None on file.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {record.allergies.map((a, i) => (
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
      </div>

      {record.emergencyMedicalNotes ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-semibold text-amber-900">Emergency medical notes</p>
          <p className="mt-1 whitespace-pre-wrap text-amber-800">{record.emergencyMedicalNotes}</p>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-sm text-gray-900">{value}</p>
    </div>
  );
}

function ConditionsTab({ studentId }: { studentId: string }) {
  const conditions = useConditions(studentId);
  if (conditions.isLoading) return <LoadingSpinner />;
  const list = conditions.data ?? [];
  if (list.length === 0) return <EmptyState title="No conditions on file" />;

  return (
    <ul className="space-y-3">
      {list.map((c) => (
        <li key={c.id} className="rounded-md border border-gray-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-gray-900">{c.conditionName}</h4>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' + SEVERITY_PILL[c.severity]
              }
            >
              {SEVERITY_LABELS[c.severity]}
            </span>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' +
                (c.isActive
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                  : 'bg-gray-100 text-gray-500 ring-1 ring-gray-200')
              }
            >
              {c.isActive ? 'Active' : 'Resolved'}
            </span>
          </div>
          {c.diagnosisDate ? (
            <p className="mt-1 text-xs text-gray-500">Diagnosed {formatDate(c.diagnosisDate)}</p>
          ) : null}
          {c.managementPlan ? (
            <div className="mt-2 rounded bg-gray-50 p-2 text-sm text-gray-700">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Management plan
              </p>
              <p className="mt-1 whitespace-pre-wrap">{c.managementPlan}</p>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ImmunisationsTab({ studentId }: { studentId: string }) {
  const imms = useImmunisations(studentId);
  if (imms.isLoading) return <LoadingSpinner />;
  const list = imms.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title="No immunisations on file"
        description="Teachers do not have access to this tab; nurse / admin / parent only."
      />
    );
  }

  const total = list.length;
  const current = list.filter((i) => i.status === 'CURRENT').length;
  const overdue = list.filter((i) => i.status === 'OVERDUE').length;
  const waived = list.filter((i) => i.status === 'WAIVED').length;
  const pct = total > 0 ? Math.round(((current + waived) / total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2 text-sm">
        <Stat label="Total" value={total} tone="gray" />
        <Stat label="Current" value={current} tone="emerald" />
        <Stat label="Overdue" value={overdue} tone={overdue > 0 ? 'rose' : 'gray'} />
        <Stat
          label="Compliance"
          value={pct + '%'}
          tone={pct >= 80 ? 'emerald' : pct >= 50 ? 'amber' : 'rose'}
        />
      </div>
      <ul className="divide-y divide-gray-100">
        {list.map((i: ImmunisationDto) => (
          <li key={i.id} className="flex items-start justify-between py-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">{i.vaccineName}</p>
              <p className="text-xs text-gray-500">
                {i.administeredDate ? `Given ${formatDate(i.administeredDate)}` : null}
                {i.dueDate ? ` · Due ${formatDate(i.dueDate)}` : null}
                {i.administeredBy ? ` · ${i.administeredBy}` : null}
              </p>
            </div>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' + IMMUNISATION_STATUS_PILL[i.status]
              }
            >
              {IMMUNISATION_STATUS_LABELS[i.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MedicationsTab({ studentId }: { studentId: string }) {
  const meds = useStudentMedications(studentId);
  if (meds.isLoading) return <LoadingSpinner />;
  const list = meds.data ?? [];
  if (list.length === 0) return <EmptyState title="No medications on file" />;

  return (
    <ul className="space-y-3">
      {list.map((m) => (
        <li key={m.id} className="rounded-md border border-gray-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-gray-900">{m.medicationName}</h4>
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
              {MEDICATION_ROUTE_LABELS[m.route]}
            </span>
            {m.isSelfAdministered ? (
              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200">
                Self-administered
              </span>
            ) : null}
            {!m.isActive ? (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                Inactive
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {m.dosage ? m.dosage : ''}
            {m.frequency ? (m.dosage ? ' · ' : '') + m.frequency : ''}
          </p>
          {m.prescribingPhysician ? (
            <p className="text-xs text-gray-500">Prescribed by {m.prescribingPhysician}</p>
          ) : null}
          {m.schedule.length > 0 ? (
            <div className="mt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Schedule
              </p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {m.schedule.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700"
                  >
                    {formatTime(s.scheduledTime)}
                    {s.dayOfWeek != null
                      ? ' · ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.dayOfWeek]
                      : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function VisitsTab({ studentId }: { studentId: string }) {
  // Step 8 list endpoint isn't filtered by student at the controller, so
  // we client-filter the recent list. Future polish: backend support for
  // ?visitedPersonId=... once a parent-facing parent visits view exists.
  const visits = useNurseVisits({ limit: 100 });
  if (visits.isLoading) return <LoadingSpinner />;
  const list = (visits.data ?? []).filter((v) => v.visitedPersonId === studentId);
  if (list.length === 0) {
    return (
      <EmptyState
        title="No nurse visits on file"
        description="When the nurse signs this student in, the visit appears here. Visible to nurses and admins only."
      />
    );
  }

  return (
    <ul className="divide-y divide-gray-100">
      {list.map((v) => (
        <li key={v.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-gray-900">
              {v.reason ?? 'No reason recorded'}
            </p>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' + NURSE_VISIT_STATUS_PILL[v.status]
              }
            >
              {NURSE_VISIT_STATUS_LABELS[v.status]}
            </span>
            {v.sentHome ? (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
                Sent home
              </span>
            ) : null}
            {v.parentNotified ? (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                Parent notified
              </span>
            ) : null}
            {v.followUpRequired ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                Follow-up
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {formatDateTime(v.signedInAt)}
            {v.signedOutAt ? ' → ' + formatDateTime(v.signedOutAt) : ''}
            {v.nurseName ? ' · ' + v.nurseName : ''}
          </p>
          {v.treatmentGiven ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{v.treatmentGiven}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DietaryTab({ studentId }: { studentId: string }) {
  const dietary = useDietaryProfile(studentId);
  if (dietary.isLoading) return <LoadingSpinner />;
  if (!dietary.data) {
    return <EmptyState title="No dietary profile on file" />;
  }
  const d = dietary.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {d.posAllergenAlert ? (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
            POS allergen alert
          </span>
        ) : null}
        {d.dietaryRestrictions.map((r) => (
          <span
            key={r}
            className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"
          >
            {r}
          </span>
        ))}
        {d.dietaryRestrictions.length === 0 && !d.posAllergenAlert ? (
          <span className="text-sm text-gray-500">No dietary restrictions on file.</span>
        ) : null}
      </div>
      {d.allergens.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold text-gray-900">Allergens</h4>
          <ul className="mt-2 space-y-1.5">
            {d.allergens.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span
                  className={
                    'rounded-full px-2 py-0.5 text-xs font-medium ' + SEVERITY_PILL[a.severity]
                  }
                >
                  {SEVERITY_LABELS[a.severity]}
                </span>
                <div>
                  <p className="font-medium text-gray-900">{a.allergen}</p>
                  {a.reaction ? <p className="text-xs text-gray-600">{a.reaction}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.specialMealInstructions ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Special meal instructions
          </p>
          <p className="mt-1 whitespace-pre-wrap text-amber-900">{d.specialMealInstructions}</p>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'emerald' | 'rose' | 'amber' | 'gray';
}) {
  const toneClasses: Record<string, string> = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    gray: 'border-gray-200 bg-gray-50 text-gray-700',
  };
  return (
    <div className={'rounded-lg border p-2 text-center ' + (toneClasses[tone] ?? toneClasses.gray)}>
      <p className="text-[10px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
