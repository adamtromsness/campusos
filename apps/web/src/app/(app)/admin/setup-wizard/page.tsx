'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/lib/api-client';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  usePatchWizardProgress,
  useWizardProgress,
  type SetupWizardProgressResponseDto,
} from '@/hooks/use-configuration';

/**
 * Step 6 — Setup Wizard.
 *
 * Resumable 8-step onboarding flow. Each step links to the
 * structure-specific page (Facility / Academic / Position) with the
 * matching action. Progress is saved per-tenant on school_config so
 * the admin can leave and come back; the live setup-status checklist
 * fed in by the same endpoint provides real-time DONE/PARTIAL chips.
 *
 * The 8 steps mirror docs/campusos-school-configuration-admin.html
 * step 06: school identity, academic calendar, buildings & rooms,
 * departments & positions, staff import, students & guardians,
 * classes, schedules.
 *
 * Gated on sys-001:admin.
 */

interface WizardStep {
  num: number;
  title: string;
  description: string;
  cta: { label: string; href: string };
  // Status keys from setup-status this step is "considered done" against.
  doneKey?:
    | 'buildings'
    | 'rooms'
    | 'academic_year'
    | 'classes'
    | 'positions'
    | 'staff_assigned'
    | 'classes_in_rooms';
}

const WIZARD_STEPS: WizardStep[] = [
  {
    num: 1,
    title: 'School identity',
    description:
      'Confirm school name, address, and timezone. The school is already provisioned — verify its config is current.',
    cta: { label: 'Open settings', href: '/admin' },
  },
  {
    num: 2,
    title: 'Academic calendar',
    description: 'Pick the academic year, set terms, and define your grade bands.',
    cta: { label: 'Configure academic year', href: '/admin/configuration/academic' },
    doneKey: 'academic_year',
  },
  {
    num: 3,
    title: 'Buildings & rooms',
    description: 'Create buildings, add rooms (or import via CSV). Rooms auto-link to scheduling.',
    cta: { label: 'Open Facilities', href: '/admin/configuration/facilities' },
    doneKey: 'rooms',
  },
  {
    num: 4,
    title: 'Departments & positions',
    description:
      'Define departments and positions with reports-to chains. Positions later get filled by staff.',
    cta: { label: 'Open Positions', href: '/admin/configuration/positions' },
    doneKey: 'positions',
  },
  {
    num: 5,
    title: 'Staff import',
    description:
      'Upload a CSV of staff (first/last name, email, position title). Creates IAM accounts and HR records.',
    cta: { label: 'Open Staff import', href: '/staff' },
    doneKey: 'staff_assigned',
  },
  {
    num: 6,
    title: 'Students & guardians',
    description:
      'Upload a CSV of students with optional guardian rows. Creates portal access for both.',
    cta: { label: 'Open Students', href: '/students' },
  },
  {
    num: 7,
    title: 'Classes',
    description:
      'Create classes for each course + section + term. Assign teachers and a max enrollment.',
    cta: { label: 'Open Classes', href: '/admin/configuration/academic' },
    doneKey: 'classes',
  },
  {
    num: 8,
    title: 'Schedules',
    description: 'Build the timetable: assign classes to rooms and time slots.',
    cta: { label: 'Open Scheduling', href: '/admin/configuration/connections' },
    doneKey: 'classes_in_rooms',
  },
];

export default function SetupWizardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const wizard = useWizardProgress(isAdmin);
  const patch = usePatchWizardProgress();
  const { toast } = useToast();
  const [pendingStep, setPendingStep] = useState<number | null>(null);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Setup wizard" />
        <EmptyState
          title="Admin access required"
          description="The setup wizard is gated on the SYS-001:admin permission."
        />
      </div>
    );
  }

  const data = wizard.data;
  const completedRatio = data ? data.completedSteps.length / WIZARD_STEPS.length : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <PageHeader title="Setup wizard" />
        <p className="-mt-1 text-sm text-gray-600">
          <Link href="/admin/configuration" className="text-campus-700 hover:underline">
            ← Configuration
          </Link>
          {' · '}Resumable first-time school setup. Your progress is saved automatically.
        </p>
      </div>

      {wizard.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading progress…
        </div>
      )}

      {wizard.isError && <p className="text-sm text-rose-600">Failed to load wizard progress.</p>}

      {data && (
        <>
          <ProgressHeader data={data} ratio={completedRatio} />

          <ol className="space-y-3">
            {WIZARD_STEPS.map((step) => {
              const isCompleted = data.completedSteps.includes(step.num);
              const isCurrent = data.currentStep === step.num;
              const checklistItem = step.doneKey
                ? data.setupStatus.items.find((it) => it.key === step.doneKey)
                : null;
              return (
                <WizardRow
                  key={step.num}
                  step={step}
                  isCompleted={isCompleted}
                  isCurrent={isCurrent}
                  checklistStatus={checklistItem?.status ?? null}
                  busy={pendingStep === step.num && patch.isPending}
                  onMarkComplete={async () => {
                    setPendingStep(step.num);
                    try {
                      await patch.mutateAsync({ markStepComplete: step.num });
                      toast(`Step ${step.num} marked complete`, 'success');
                    } catch (e) {
                      const msg =
                        e instanceof ApiError
                          ? ((e.body as { message?: string })?.message ?? 'Update failed')
                          : 'Update failed';
                      toast(msg, 'error');
                    } finally {
                      setPendingStep(null);
                    }
                  }}
                  onSetCurrent={async () => {
                    setPendingStep(step.num);
                    try {
                      await patch.mutateAsync({ currentStep: step.num });
                    } catch {
                      toast('Failed to set current step', 'error');
                    } finally {
                      setPendingStep(null);
                    }
                  }}
                />
              );
            })}
          </ol>

          <p className="text-xs text-gray-500">
            Last updated{' '}
            {data.updatedAt && new Date(data.updatedAt).getTime() > 0
              ? new Date(data.updatedAt).toLocaleString()
              : 'never'}
            .
          </p>
        </>
      )}
    </div>
  );
}

function ProgressHeader({ data, ratio }: { data: SetupWizardProgressResponseDto; ratio: number }) {
  const pct = Math.round(ratio * 100);
  return (
    <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-gray-900">
          Step {data.currentStep} of {WIZARD_STEPS.length}
        </h2>
        <p className="text-sm text-gray-600">
          <span className="font-semibold text-emerald-700">{data.completedSteps.length}</span> of{' '}
          {WIZARD_STEPS.length} steps marked complete · setup status{' '}
          <span className="font-semibold text-campus-700">{data.setupStatus.completedCount}</span> /{' '}
          {data.setupStatus.totalCount}
        </p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gray-200">
        <div className="h-full bg-campus-700 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}

function WizardRow({
  step,
  isCompleted,
  isCurrent,
  checklistStatus,
  busy,
  onMarkComplete,
  onSetCurrent,
}: {
  step: WizardStep;
  isCompleted: boolean;
  isCurrent: boolean;
  checklistStatus: 'DONE' | 'PARTIAL' | 'NOT_STARTED' | null;
  busy: boolean;
  onMarkComplete: () => void | Promise<void>;
  onSetCurrent: () => void | Promise<void>;
}) {
  const ringClass = isCurrent ? 'ring-2 ring-campus-500' : '';
  return (
    <li
      className={`rounded-card border bg-white p-4 shadow-card ${ringClass} ${
        isCompleted ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200'
      }`}
    >
      <div className="flex items-start gap-3">
        <StepNumber n={step.num} done={isCompleted} current={isCurrent} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-base font-semibold text-gray-900">{step.title}</p>
            <div className="flex items-center gap-2">
              {checklistStatus && <ChecklistChip status={checklistStatus} />}
              {isCompleted && (
                <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                  Done
                </span>
              )}
            </div>
          </div>
          <p className="mt-1 text-sm text-gray-600">{step.description}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={step.cta.href}
              onClick={() => void onSetCurrent()}
              className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
            >
              {step.cta.label}
            </Link>
            {!isCompleted && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onMarkComplete()}
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Mark complete'}
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function StepNumber({ n, done, current }: { n: number; done: boolean; current: boolean }) {
  if (done) {
    return (
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2.5}
          stroke="currentColor"
          className="h-5 w-5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
        current ? 'bg-campus-700 text-white' : 'bg-gray-200 text-gray-700'
      }`}
    >
      {n}
    </span>
  );
}

function ChecklistChip({ status }: { status: 'DONE' | 'PARTIAL' | 'NOT_STARTED' }) {
  const map = {
    DONE: 'bg-emerald-100 text-emerald-700',
    PARTIAL: 'bg-amber-100 text-amber-700',
    NOT_STARTED: 'bg-gray-200 text-gray-600',
  } as const;
  const label =
    status === 'DONE' ? 'Data: ready' : status === 'PARTIAL' ? 'Data: partial' : 'Data: empty';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${map[status]}`}>{label}</span>
  );
}
