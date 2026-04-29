'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useApplications, useEnrollmentPeriods, useOffers } from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_PILL,
  formatDateOnly,
  formatRelativeDeadline,
  formatStudentName,
} from '@/lib/admissions-format';
import type { ApplicationDto, OfferDto } from '@/lib/types';

export default function ApplyLandingPage() {
  const user = useAuthStore((s) => s.user);
  const isGuardian = !!user && user.personType === 'GUARDIAN';
  const canApply = !!user && hasAnyPermission(user, ['stu-003:write']);
  const periods = useEnrollmentPeriods(canApply);
  const apps = useApplications({}, canApply);
  const offers = useOffers(canApply);

  if (!user) return null;
  if (!isGuardian || !canApply) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Apply" />
        <EmptyState
          title="Not available"
          description="The Apply app is only available for guardian accounts."
        />
      </div>
    );
  }

  const openPeriods = (periods.data ?? []).filter((p) => p.status === 'OPEN');
  const myApps = apps.data ?? [];
  const offerByApplicationId = new Map<string, OfferDto>();
  for (const o of offers.data ?? []) offerByApplicationId.set(o.applicationId, o);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Admissions"
        description="Submit a new application or check the status of one you’ve already sent."
        actions={
          openPeriods.length > 0 ? (
            <Link
              href="/apply/new"
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              Start new application
            </Link>
          ) : null
        }
      />

      {periods.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : openPeriods.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No enrollment periods are open right now. Check back soon, or contact the school if
          you’re applying outside the standard window.
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p className="font-semibold">
            {openPeriods.length === 1
              ? '1 admissions window is open right now.'
              : `${openPeriods.length} admissions windows are open right now.`}
          </p>
          <ul className="mt-1 list-inside list-disc">
            {openPeriods.map((p) => (
              <li key={p.id}>
                {p.name} · {formatDateOnly(p.opensAt)} → {formatDateOnly(p.closesAt)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Your applications</h2>
        {apps.isLoading ? (
          <div className="py-12 text-center">
            <LoadingSpinner />
          </div>
        ) : myApps.length === 0 ? (
          <EmptyState
            title="No applications yet"
            description={
              openPeriods.length > 0
                ? 'Click “Start new application” to begin.'
                : 'Once an admissions window opens, you can submit an application here.'
            }
          />
        ) : (
          <ul className="space-y-3">
            {myApps.map((app) => (
              <ApplicationRow
                key={app.id}
                application={app}
                offer={offerByApplicationId.get(app.id) ?? null}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ApplicationRow({
  application,
  offer,
}: {
  application: ApplicationDto;
  offer: OfferDto | null;
}) {
  const studentName = formatStudentName(application.studentFirstName, application.studentLastName);
  return (
    <li className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-semibold text-gray-900">{studentName}</p>
          <p className="mt-0.5 text-xs text-gray-500">
            Grade {application.applyingForGrade} · {application.enrollmentPeriodName}
            {application.streamName ? ` · ${application.streamName}` : ''}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            Submitted {application.submittedAt ? formatDateOnly(application.submittedAt) : '—'}
          </p>
        </div>
        <span
          className={`inline-flex flex-shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            APPLICATION_STATUS_PILL[application.status]
          }`}
        >
          {APPLICATION_STATUS_LABELS[application.status]}
        </span>
      </div>

      {application.notes.length > 0 && (
        <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2">
          <p className="text-xs font-semibold text-gray-700">Notes from the admissions team</p>
          <ul className="mt-1 space-y-1 text-xs text-gray-600">
            {application.notes.slice(0, 3).map((n) => (
              <li key={n.id}>
                <span className="font-medium">{formatDateOnly(n.createdAt)}:</span> {n.noteText}
              </li>
            ))}
          </ul>
        </div>
      )}

      {offer && offer.status === 'ISSUED' && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg bg-sky-50 px-3 py-3 text-sm text-sky-900 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Offer issued — respond {formatRelativeDeadline(offer.responseDeadline)}.</p>
            <p className="text-xs">
              {offer.offerType === 'CONDITIONAL' ? 'Conditional offer' : 'Unconditional offer'}
            </p>
          </div>
          <Link
            href={`/offers/${offer.id}`}
            className="self-start rounded-lg bg-campus-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-campus-600 sm:self-center"
          >
            Respond →
          </Link>
        </div>
      )}

      {offer && offer.status === 'ACCEPTED' && (
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          You accepted the offer on {formatDateOnly(offer.familyRespondedAt)}. Welcome to the
          school — a tuition invoice will be generated shortly.
        </div>
      )}

      {offer && (offer.status === 'DECLINED' || offer.status === 'EXPIRED') && (
        <div className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-700">
          Offer {offer.status.toLowerCase()}.
        </div>
      )}
    </li>
  );
}
