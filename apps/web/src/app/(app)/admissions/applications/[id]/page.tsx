'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useAddApplicationNote,
  useApplication,
  useIssueOffer,
  useOffers,
  useRespondToOffer,
  useSetOfferConditionsMet,
  useUpdateApplicationStatus,
} from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_PILL,
  NOTE_TYPE_LABELS,
  OFFER_STATUS_LABELS,
  OFFER_STATUS_PILL,
  addDaysIso,
  formatDateOnly,
  formatDateTime,
  formatRelativeDeadline,
  formatStudentName,
  todayIso,
} from '@/lib/admissions-format';
import type {
  AdminTransitionTarget,
  ApplicationDto,
  ApplicationNoteType,
  OfferDto,
} from '@/lib/types';

type ReviewMode = 'UNDER_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'WAITLISTED' | 'WITHDRAWN';

export default function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['stu-003:admin']);
  const app = useApplication(id, !!user);
  const offers = useOffers(!!user);
  const [reviewMode, setReviewMode] = useState<ReviewMode | null>(null);
  const [showOffer, setShowOffer] = useState(false);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Application" description="Admissions admin only." />
        <EmptyState title="Admin access required" />
      </div>
    );
  }

  if (app.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (app.isError || !app.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Application not found" />
        <EmptyState
          title="Couldn’t load application"
          action={
            <Link
              href="/admissions/applications"
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              Back to pipeline
            </Link>
          }
        />
      </div>
    );
  }

  const a = app.data;
  const offer = (offers.data ?? []).find((o) => o.applicationId === a.id) ?? null;

  const isTerminal = a.status === 'ENROLLED' || a.status === 'WITHDRAWN';
  const canReview = !isTerminal && a.status !== 'DRAFT';
  const canIssueOffer = a.status === 'ACCEPTED' && !offer;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/admissions/applications"
        className="mb-3 inline-block text-sm text-gray-500 hover:text-campus-700"
      >
        ← Back to pipeline
      </Link>

      <header className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Avatar name={formatStudentName(a.studentFirstName, a.studentLastName)} size="lg" />
            <div>
              <h1 className="font-display text-2xl text-campus-700">
                {formatStudentName(a.studentFirstName, a.studentLastName)}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                Grade {a.applyingForGrade} · DOB {formatDateOnly(a.studentDateOfBirth)} ·{' '}
                {a.admissionType.replace(/_/g, ' ').toLowerCase()}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {a.enrollmentPeriodName}
                {a.streamName ? ` · ${a.streamName}` : ''} · Submitted{' '}
                {a.submittedAt ? formatDateOnly(a.submittedAt) : 'pending'}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex flex-shrink-0 items-center rounded-full px-3 py-1 text-xs font-medium ${
              APPLICATION_STATUS_PILL[a.status]
            }`}
          >
            {APPLICATION_STATUS_LABELS[a.status]}
          </span>
        </div>

        {canReview && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
            {a.status === 'SUBMITTED' && (
              <button
                type="button"
                onClick={() => setReviewMode('UNDER_REVIEW')}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
              >
                Move to review
              </button>
            )}
            {a.status !== 'ACCEPTED' && (
              <button
                type="button"
                onClick={() => setReviewMode('ACCEPTED')}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
              >
                Accept
              </button>
            )}
            {a.status !== 'WAITLISTED' && (
              <button
                type="button"
                onClick={() => setReviewMode('WAITLISTED')}
                className="rounded-lg border border-violet-300 px-3 py-1.5 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-50"
              >
                Waitlist
              </button>
            )}
            {a.status !== 'REJECTED' && (
              <button
                type="button"
                onClick={() => setReviewMode('REJECTED')}
                className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50"
              >
                Reject
              </button>
            )}
            {canIssueOffer && (
              <button
                type="button"
                onClick={() => setShowOffer(true)}
                className="ml-auto rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
              >
                Issue offer →
              </button>
            )}
          </div>
        )}
      </header>

      {offer && <OfferPanel offer={offer} application={a} />}

      <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Guardian">
          <Field label="Email" value={a.guardianEmail} />
          <Field label="Phone" value={a.guardianPhone ?? '—'} />
          <Field
            label="Linked person"
            value={a.guardianPersonId ? a.guardianPersonId.slice(0, 8) + '…' : 'Not yet linked'}
          />
        </Card>
        <Card title="Timeline">
          <Field label="Created" value={formatDateTime(a.createdAt)} />
          <Field label="Submitted" value={a.submittedAt ? formatDateTime(a.submittedAt) : '—'} />
          <Field
            label="Last review"
            value={a.reviewedAt ? formatDateTime(a.reviewedAt) : 'Not reviewed yet'}
          />
        </Card>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-gray-900">Screening responses</h2>
        {a.screening.length === 0 ? (
          <p className="text-sm text-gray-500">No screening questions answered.</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            {a.screening.map((s) => (
              <li
                key={s.questionKey}
                className="grid grid-cols-1 gap-2 border-b border-gray-100 px-4 py-3 last:border-b-0 sm:grid-cols-3"
              >
                <span className="text-sm font-medium text-gray-700">{s.questionKey}</span>
                <span className="text-sm text-gray-900 sm:col-span-2">
                  {formatScreeningValue(s.responseValue)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-gray-900">Documents</h2>
        {a.documents.length === 0 ? (
          <p className="text-sm text-gray-500">No documents uploaded.</p>
        ) : (
          <ul className="space-y-2">
            {a.documents.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-gray-900">{d.fileName ?? d.documentType}</p>
                  <p className="text-xs text-gray-500">
                    {d.documentType} · uploaded {formatDateOnly(d.uploadedAt)}
                  </p>
                </div>
                <span className="text-xs text-gray-400">
                  {d.fileSizeBytes ? `${Math.round(d.fileSizeBytes / 1024)} KB` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-gray-900">Notes timeline</h2>
        <NoteComposer applicationId={a.id} />
        {a.notes.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No notes yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {a.notes.map((n) => (
              <li key={n.id} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {NOTE_TYPE_LABELS[n.noteType] ?? n.noteType}
                  </span>
                  <div className="flex items-center gap-2">
                    {n.isConfidential && (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                        Confidential
                      </span>
                    )}
                    <span className="text-xs text-gray-400">{formatDateTime(n.createdAt)}</span>
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-gray-800">{n.noteText}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {reviewMode && (
        <ReviewModal application={a} mode={reviewMode} onClose={() => setReviewMode(null)} />
      )}
      {showOffer && <IssueOfferModal application={a} onClose={() => setShowOffer(false)} />}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">{title}</h3>
      <dl className="space-y-1.5">{children}</dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900">{value}</dd>
    </div>
  );
}

function formatScreeningValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ReviewModal({
  application,
  mode,
  onClose,
}: {
  application: ApplicationDto;
  mode: ReviewMode;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const transition = useUpdateApplicationStatus(application.id);
  const [note, setNote] = useState('');
  const targetLabel = APPLICATION_STATUS_LABELS[mode];

  async function onConfirm() {
    try {
      await transition.mutateAsync({
        status: mode as AdminTransitionTarget,
        reviewNote: note.trim() || undefined,
      });
      toast(`Application ${targetLabel.toLowerCase()}.`, 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not update status', 'error');
    }
  }

  const tone =
    mode === 'ACCEPTED'
      ? 'bg-emerald-600 hover:bg-emerald-500'
      : mode === 'REJECTED'
        ? 'bg-rose-600 hover:bg-rose-500'
        : 'bg-campus-700 hover:bg-campus-600';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${targetLabel}: ${formatStudentName(application.studentFirstName, application.studentLastName)}`}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={transition.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={transition.isPending}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${tone}`}
          >
            {transition.isPending ? 'Saving…' : `Confirm ${targetLabel.toLowerCase()}`}
          </button>
        </div>
      }
    >
      <p className="text-sm text-gray-700">
        {mode === 'ACCEPTED' &&
          'Accepting locks the row inside the transaction and recomputes capacity. You can issue an offer immediately afterwards.'}
        {mode === 'REJECTED' && 'Rejection is irreversible from this surface.'}
        {mode === 'WAITLISTED' &&
          'A waitlist entry will be created at the next available position.'}
        {mode === 'UNDER_REVIEW' && 'Move the application into the active review queue.'}
        {mode === 'WITHDRAWN' && 'Withdrawn applications no longer count against capacity.'}
      </p>
      <label className="mt-4 block text-sm">
        <span className="text-gray-700">Review note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </label>
    </Modal>
  );
}

function IssueOfferModal({
  application,
  onClose,
}: {
  application: ApplicationDto;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const issue = useIssueOffer(application.id);
  const [offerType, setOfferType] = useState<'UNCONDITIONAL' | 'CONDITIONAL'>('UNCONDITIONAL');
  const [conditions, setConditions] = useState('');
  const [deadline, setDeadline] = useState(addDaysIso(todayIso(), 14));

  async function onSubmit() {
    try {
      const payload: any = {
        offerType,
        responseDeadline: new Date(deadline + 'T23:59:59Z').toISOString(),
      };
      if (offerType === 'CONDITIONAL') {
        const items = conditions
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length === 0) {
          toast('Add at least one condition for a conditional offer', 'error');
          return;
        }
        payload.offerConditions = items;
      }
      await issue.mutateAsync(payload);
      toast('Offer issued.', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not issue offer', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Issue offer to ${formatStudentName(application.studentFirstName, application.studentLastName)}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={issue.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={issue.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {issue.isPending ? 'Issuing…' : 'Issue offer'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          {(['UNCONDITIONAL', 'CONDITIONAL'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setOfferType(t)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                offerType === t
                  ? 'border-campus-500 bg-campus-50 text-campus-700'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t === 'UNCONDITIONAL' ? 'Unconditional' : 'Conditional'}
            </button>
          ))}
        </div>
        {offerType === 'CONDITIONAL' && (
          <label className="block text-sm">
            <span className="text-gray-700">Conditions (one per line)</span>
            <textarea
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              rows={4}
              placeholder={'Pass end-of-year exam with at least 60%\nProvide health records'}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
        )}
        <label className="block text-sm">
          <span className="text-gray-700">Response deadline</span>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            min={todayIso()}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
      </div>
    </Modal>
  );
}

function OfferPanel({ offer, application }: { offer: OfferDto; application: ApplicationDto }) {
  const { toast } = useToast();
  const setMet = useSetOfferConditionsMet(offer.id);
  const respond = useRespondToOffer(offer.id);

  const isOpen = offer.status === 'ISSUED';
  const isConditional = offer.offerType === 'CONDITIONAL';
  const conditionsResolved = !isConditional || offer.conditionsMet === true;

  async function onVerify(met: boolean) {
    try {
      await setMet.mutateAsync({ conditionsMet: met });
      toast(met ? 'Conditions verified.' : 'Conditions marked failed.', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not update conditions', 'error');
    }
  }

  async function onRespond(familyResponse: 'ACCEPTED' | 'DECLINED') {
    if (familyResponse === 'ACCEPTED' && !conditionsResolved) {
      toast('Verify conditions before accepting on the family’s behalf.', 'error');
      return;
    }
    try {
      await respond.mutateAsync({ familyResponse });
      toast(
        familyResponse === 'ACCEPTED'
          ? 'Offer accepted — application moves to ENROLLED.'
          : 'Offer declined.',
        'success',
      );
    } catch (e: any) {
      toast(e?.message || 'Could not record response', 'error');
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Offer</h2>
          <p className="mt-1 text-sm text-gray-600">
            {offer.offerType.toLowerCase()} · issued {formatDateOnly(offer.issuedAt)} · response{' '}
            {formatRelativeDeadline(offer.responseDeadline)}
          </p>
        </div>
        <span
          className={`inline-flex flex-shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            OFFER_STATUS_PILL[offer.status]
          }`}
        >
          {OFFER_STATUS_LABELS[offer.status]}
        </span>
      </header>

      {isConditional && (
        <div className="mt-3 rounded-lg bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">Conditions</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-amber-900">
            {(offer.offerConditions ?? []).map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {isOpen && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-amber-900">
                Status:{' '}
                {offer.conditionsMet === true
                  ? 'Met'
                  : offer.conditionsMet === false
                    ? 'Failed'
                    : 'Pending'}
              </span>
              <button
                type="button"
                onClick={() => onVerify(true)}
                disabled={setMet.isPending}
                className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                Mark met
              </button>
              <button
                type="button"
                onClick={() => onVerify(false)}
                disabled={setMet.isPending}
                className="rounded-lg border border-amber-300 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                Mark failed
              </button>
            </div>
          )}
        </div>
      )}

      {isOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          <p className="text-xs text-gray-500">
            Parents respond from their portal; admins can also act on their behalf.
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => onRespond('DECLINED')}
              disabled={respond.isPending}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
            >
              Decline (proxy)
            </button>
            <button
              type="button"
              onClick={() => onRespond('ACCEPTED')}
              disabled={respond.isPending || !conditionsResolved}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              title={!conditionsResolved ? 'Verify conditions first' : ''}
            >
              Accept (proxy)
            </button>
          </div>
        </div>
      )}

      {!isOpen && offer.familyResponse && (
        <p className="mt-3 text-xs text-gray-500">
          Family responded {offer.familyResponse.toLowerCase()} on{' '}
          {formatDateTime(offer.familyRespondedAt)}.
        </p>
      )}

      {application.status === 'ENROLLED' && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          Student is now enrolled.{' '}
          <code className="rounded bg-white/50 px-1">enr.student.enrolled</code> fired — the
          PaymentAccountWorker will create the family account.
        </p>
      )}
    </section>
  );
}

function NoteComposer({ applicationId }: { applicationId: string }) {
  const { toast } = useToast();
  const add = useAddApplicationNote(applicationId);
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState<ApplicationNoteType>('GENERAL');
  const [isConfidential, setIsConfidential] = useState(false);

  async function onSubmit() {
    if (!noteText.trim()) return;
    try {
      await add.mutateAsync({
        noteType,
        noteText: noteText.trim(),
        isConfidential,
      });
      toast('Note added.', 'success');
      setNoteText('');
      setIsConfidential(false);
    } catch (e: any) {
      toast(e?.message || 'Could not add note', 'error');
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      <textarea
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="Add a note for the admissions team…"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <select
          value={noteType}
          onChange={(e) => setNoteType(e.target.value as ApplicationNoteType)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          {Object.entries(NOTE_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={isConfidential}
            onChange={(e) => setIsConfidential(e.target.checked)}
            className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
          />
          Confidential (hidden from parents)
        </label>
        <button
          type="button"
          onClick={onSubmit}
          disabled={add.isPending || !noteText.trim()}
          className="ml-auto rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
        >
          {add.isPending ? 'Adding…' : 'Add note'}
        </button>
      </div>
    </div>
  );
}
