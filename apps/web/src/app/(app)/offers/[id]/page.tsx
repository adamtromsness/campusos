'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useAcademicYears,
  useApplication,
  useOffer,
  useRespondToOffer,
} from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  OFFER_STATUS_LABELS,
  OFFER_STATUS_PILL,
  formatDateOnly,
  formatDateTime,
  formatRelativeDeadline,
  formatStudentName,
} from '@/lib/admissions-format';
import type { FamilyResponse } from '@/lib/types';

type Mode = 'ACCEPTED' | 'DECLINED' | 'DEFERRED' | null;

export default function OfferResponsePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useAuthStore((s) => s.user);
  const isGuardian = !!user && user.personType === 'GUARDIAN';
  const isAdmin = !!user && hasAnyPermission(user, ['stu-003:admin']);
  const offer = useOffer(id, !!user);
  const application = useApplication(offer.data?.applicationId ?? null, !!offer.data);
  const years = useAcademicYears(!!user);
  const respond = useRespondToOffer(id);
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>(null);
  const [deferTargetYearId, setDeferTargetYearId] = useState('');

  if (!user) return null;
  if (!isGuardian && !isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Offer" />
        <EmptyState
          title="Not available"
          description="Offer responses are only available for guardians and admins."
        />
      </div>
    );
  }

  if (offer.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (offer.isError || !offer.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Offer not found" />
        <EmptyState
          title="Couldn’t load offer"
          description="The offer either doesn’t exist or isn’t linked to your account."
          action={
            <Link
              href={isGuardian ? '/apply' : '/admissions/applications'}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              Back
            </Link>
          }
        />
      </div>
    );
  }

  const o = offer.data;
  const studentName = formatStudentName(o.studentFirstName, o.studentLastName);
  const isOpen = o.status === 'ISSUED';
  const isAccepted = o.status === 'ACCEPTED' || application.data?.status === 'ENROLLED';
  const isConditional = o.offerType === 'CONDITIONAL';
  const conditionsResolved = !isConditional || o.conditionsMet === true;

  async function onConfirm() {
    if (!mode) return;
    try {
      await respond.mutateAsync({
        familyResponse: mode as FamilyResponse,
        deferralTargetYearId: mode === 'DEFERRED' ? deferTargetYearId || undefined : undefined,
      });
      const verb =
        mode === 'ACCEPTED' ? 'accepted' : mode === 'DECLINED' ? 'declined' : 'deferred';
      toast(`Offer ${verb}.`, 'success');
      setMode(null);
      setDeferTargetYearId('');
    } catch (e: any) {
      toast(e?.message || 'Could not record your response', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={isGuardian ? '/apply' : `/admissions/applications/${o.applicationId}`}
        className="mb-3 inline-block text-sm text-gray-500 hover:text-campus-700"
      >
        ← Back
      </Link>

      <PageHeader
        title={`Offer for ${studentName}`}
        description={`Grade ${o.applyingForGrade} · issued ${formatDateOnly(o.issuedAt)}`}
        actions={
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              OFFER_STATUS_PILL[o.status]
            }`}
          >
            {OFFER_STATUS_LABELS[o.status]}
          </span>
        }
      />

      {isAccepted ? (
        <ConfirmationBanner studentName={studentName} grade={o.applyingForGrade} />
      ) : isOpen ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">Respond {formatRelativeDeadline(o.responseDeadline)}.</p>
          <p className="mt-0.5 text-xs">
            Deadline: {formatDateTime(o.responseDeadline)}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
          This offer is no longer accepting responses (status: {OFFER_STATUS_LABELS[o.status]}).
        </div>
      )}

      <section className="mt-6 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">Offer details</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <Row label="Offer type" value={isConditional ? 'Conditional' : 'Unconditional'} />
          <Row label="Issued" value={formatDateTime(o.issuedAt)} />
          <Row label="Response deadline" value={formatDateTime(o.responseDeadline)} />
          {o.familyResponse && (
            <Row
              label="Your response"
              value={`${o.familyResponse.toLowerCase()} · ${formatDateTime(o.familyRespondedAt)}`}
            />
          )}
        </dl>
      </section>

      {isConditional && (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <h3 className="text-sm font-semibold text-amber-900">Conditions</h3>
          {(o.offerConditions ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-amber-900">No conditions listed.</p>
          ) : (
            <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm text-amber-900">
              {(o.offerConditions ?? []).map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-amber-900">
            {o.conditionsMet === true && 'The school has verified the conditions are met. You can accept the offer.'}
            {o.conditionsMet === false && 'The school has not verified the conditions yet — please contact admissions.'}
            {o.conditionsMet === null &&
              'The school is reviewing the conditions. You can still decline or defer; accepting becomes available once conditions are verified.'}
          </p>
        </section>
      )}

      {isOpen && !mode && (
        <section className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => setMode('DEFERRED')}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Defer to next year
          </button>
          <button
            type="button"
            onClick={() => setMode('DECLINED')}
            className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => setMode('ACCEPTED')}
            disabled={!conditionsResolved}
            title={!conditionsResolved ? 'Conditions must be verified by the school first' : ''}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            Accept
          </button>
        </section>
      )}

      {mode && (
        <section className="mt-6 rounded-xl border border-campus-200 bg-campus-50 px-5 py-4">
          <h3 className="text-sm font-semibold text-campus-900">
            {mode === 'ACCEPTED' && `Accept the offer for ${studentName}?`}
            {mode === 'DECLINED' && `Decline the offer for ${studentName}?`}
            {mode === 'DEFERRED' && `Defer ${studentName}’s enrollment to a future year?`}
          </h3>
          <p className="mt-1 text-xs text-campus-900">
            {mode === 'ACCEPTED' &&
              'On accept, your child will be enrolled and a tuition invoice will be generated shortly.'}
            {mode === 'DECLINED' && 'This action cannot be undone.'}
            {mode === 'DEFERRED' &&
              'Pick the academic year you’d like to defer to. The school will follow up about next steps.'}
          </p>

          {mode === 'DEFERRED' && (
            <label className="mt-3 block text-sm">
              <span className="text-campus-900">Target academic year</span>
              <select
                value={deferTargetYearId}
                onChange={(e) => setDeferTargetYearId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              >
                <option value="">Select a year…</option>
                {(years.data ?? [])
                  .filter((y) => !y.isCurrent)
                  .map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name}
                    </option>
                  ))}
              </select>
            </label>
          )}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => {
                setMode(null);
                setDeferTargetYearId('');
              }}
              disabled={respond.isPending}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={respond.isPending || (mode === 'DEFERRED' && !deferTargetYearId)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                mode === 'ACCEPTED'
                  ? 'bg-emerald-600 hover:bg-emerald-500'
                  : mode === 'DECLINED'
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-campus-700 hover:bg-campus-600'
              }`}
            >
              {respond.isPending
                ? 'Saving…'
                : mode === 'ACCEPTED'
                  ? 'Confirm accept'
                  : mode === 'DECLINED'
                    ? 'Confirm decline'
                    : 'Confirm defer'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900">{value}</dd>
    </div>
  );
}

function ConfirmationBanner({
  studentName,
  grade,
}: {
  studentName: string;
  grade: string;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-900">
      <p className="text-base font-semibold">🎉 Welcome!</p>
      <p className="mt-1">
        {studentName} has been enrolled in Grade {grade}. A tuition invoice will be generated
        shortly — check the Billing section once it arrives.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href="/apply"
          className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
        >
          Back to applications
        </Link>
        <Link
          href="/children"
          className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-100"
        >
          View my children
        </Link>
      </div>
    </div>
  );
}
