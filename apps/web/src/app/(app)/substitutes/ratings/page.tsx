'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAssignmentPay,
  useAssignmentRatings,
  useCancellationPolicy,
  useClosePayRate,
  useCreatePayRate,
  usePayRates,
  useSessionNote,
  useSubAssignment,
  useSubAssignments,
  useSubmitRating,
  useUpsertCancellationPolicy,
} from '@/hooks/use-substitutes';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_PILL,
  CANCEL_CONSEQUENCE_LABEL,
  RATER_TYPE_LABEL,
  RATE_TYPE_LABEL,
  formatDate,
  formatDateTime,
  formatRate,
  formatRating,
  isSchoolDefaultRate,
} from '@/lib/substitutes-format';
import type { SubCancelConsequence, SubJobType, SubRateType, SubRaterType } from '@/lib/types';

export default function RatingsPayPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <RatingsPayPageInner />
    </Suspense>
  );
}

function RatingsPayPageInner() {
  const user = useAuthStore((s) => s.user);
  const isAdmin =
    !!user && hasAnyPermission(user, ['sch-001:admin', 'sch-004:write', 'sch-004:admin']);
  const params = useSearchParams();
  const focusedAssignmentId = params.get('assignmentId');

  const [tab, setTab] = useState<'ratings' | 'pay-rates' | 'policy'>('ratings');

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-700">
        Pay rate + cancellation policy + rating administration is admin-only.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ratings + Pay"
        description="Submit ratings after assignments, configure school pay rates, and tune the cancellation policy."
      />

      <div className="flex items-center gap-2">
        <Tab label="Rate substitute" active={tab === 'ratings'} onClick={() => setTab('ratings')} />
        <Tab label="Pay rates" active={tab === 'pay-rates'} onClick={() => setTab('pay-rates')} />
        <Tab
          label="Cancellation policy"
          active={tab === 'policy'}
          onClick={() => setTab('policy')}
        />
      </div>

      {tab === 'ratings' && <RatingsTab focusedAssignmentId={focusedAssignmentId} />}
      {tab === 'pay-rates' && <PayRatesTab />}
      {tab === 'policy' && <PolicyTab />}
    </div>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium ring-1',
        active
          ? 'bg-campus-600 text-white ring-campus-600'
          : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50',
      )}
    >
      {label}
    </button>
  );
}

// ── Ratings tab ──────────────────────────────────────────────────────

function RatingsTab({ focusedAssignmentId }: { focusedAssignmentId: string | null }) {
  const assignments = useSubAssignments({ status: 'CHECKED_OUT' });
  const [picked, setPicked] = useState<string | null>(focusedAssignmentId);

  if (assignments.isLoading) return <LoadingSpinner />;

  const rows = assignments.data ?? [];

  return (
    <div className="grid grid-cols-3 gap-4">
      <section className="col-span-1 rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
          Completed assignments ({rows.length})
        </div>
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No completed assignments yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
            {rows.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setPicked(a.id)}
                  className={cn(
                    'w-full text-left px-4 py-3 text-sm hover:bg-gray-50',
                    picked === a.id && 'bg-campus-50',
                  )}
                >
                  <div className="font-medium text-gray-900 font-mono text-xs">
                    {a.id.slice(0, 8)}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{formatDateTime(a.checkOutAt)}</div>
                  <span
                    className={cn(
                      'mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                      ASSIGNMENT_STATUS_PILL[a.status],
                    )}
                  >
                    {ASSIGNMENT_STATUS_LABEL[a.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="col-span-2">
        {picked ? (
          <RatingsDetail assignmentId={picked} />
        ) : (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-12 text-center text-sm text-gray-500">
            Select a completed assignment from the left to rate or view its session note + pay.
          </div>
        )}
      </section>
    </div>
  );
}

function RatingsDetail({ assignmentId }: { assignmentId: string }) {
  const assignment = useSubAssignment(assignmentId);
  const ratings = useAssignmentRatings(assignmentId);
  const note = useSessionNote(assignmentId);
  const pay = useAssignmentPay(assignmentId, !!assignment.data);
  const submit = useSubmitRating();
  const [formOpen, setFormOpen] = useState(false);
  const { toast } = useToast();

  if (assignment.isLoading) return <LoadingSpinner />;
  if (!assignment.data) return null;

  const a = assignment.data;
  const schoolRating = (ratings.data ?? []).find((r) => r.raterType === 'SCHOOL_RATES_SUB');
  const subRating = (ratings.data ?? []).find((r) => r.raterType === 'SUB_RATES_SCHOOL');

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Assignment</div>
        <div className="font-mono text-sm text-gray-900">{a.id}</div>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-gray-500">Substitute</div>
            <div className="font-mono text-xs">{a.substituteId.slice(0, 12)}…</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Pay</div>
            <div>
              {pay.data ? (
                <>
                  {formatRate(pay.data.rate, pay.data.rateType)}{' '}
                  <span className="text-xs text-gray-500">({pay.data.rateSource})</span>
                </>
              ) : pay.isError ? (
                <span className="text-rose-600 text-xs">No matching rate configured</span>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Ratings</h3>
          {!schoolRating && (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="text-sm font-medium text-campus-600 hover:text-campus-700"
            >
              + Rate substitute
            </button>
          )}
        </div>
        <RatingRow rating={schoolRating} type="SCHOOL_RATES_SUB" />
        <RatingRow rating={subRating} type="SUB_RATES_SCHOOL" />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Handover session note</h3>
        {note.data ? (
          <>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{note.data.notesText}</p>
            {note.data.homeworkSet && (
              <p className="mt-2 text-xs text-gray-600">
                <span className="font-medium">Homework set:</span> {note.data.homeworkSet}
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              Submitted {formatDateTime(note.data.submittedAt)}
              {note.data.isVisibleToTeacher
                ? ' • Visible to returning teacher'
                : ' • Substitute marked private'}
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-500">No session note yet.</p>
        )}
      </div>

      {formOpen && (
        <RatingFormModal
          onClose={() => setFormOpen(false)}
          onSubmit={async (payload) => {
            try {
              await submit.mutateAsync({ assignmentId, payload });
              toast('Rating submitted', 'success');
              setFormOpen(false);
            } catch (e) {
              toast(`Could not submit: ${(e as Error).message}`, 'error');
            }
          }}
          isPending={submit.isPending}
        />
      )}
    </div>
  );
}

function RatingRow({
  rating,
  type,
}: {
  rating: import('@/lib/types').SubRatingDto | undefined;
  type: SubRaterType;
}) {
  return (
    <div className="border-t border-gray-100 first:border-t-0 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500">{RATER_TYPE_LABEL[type]}</span>
        <span className="text-gray-900 font-medium">
          {formatRating(rating?.overallScore ?? null)}
        </span>
      </div>
      {rating?.comments && (
        <p className="text-xs text-gray-600 mt-1 italic">&ldquo;{rating.comments}&rdquo;</p>
      )}
    </div>
  );
}

function RatingFormModal({
  onClose,
  onSubmit,
  isPending,
}: {
  onClose: () => void;
  onSubmit: (payload: {
    raterType: SubRaterType;
    overallScore?: number;
    professionalism?: number;
    punctuality?: number;
    comments?: string;
  }) => Promise<void>;
  isPending: boolean;
}) {
  const [overall, setOverall] = useState(5);
  const [prof, setProf] = useState(5);
  const [punct, setPunct] = useState(5);
  const [comments, setComments] = useState('');

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Rate substitute"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              onSubmit({
                raterType: 'SCHOOL_RATES_SUB',
                overallScore: overall,
                professionalism: prof,
                punctuality: punct,
                comments: comments.trim() || undefined,
              })
            }
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Submit
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <ScoreSelector label="Overall" value={overall} onChange={setOverall} />
        <ScoreSelector label="Professionalism" value={prof} onChange={setProf} />
        <ScoreSelector label="Punctuality" value={punct} onChange={setPunct} />
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Comments</label>
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="Optional — visible to the substitute."
          />
        </div>
      </div>
    </Modal>
  );
}

function ScoreSelector({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={cn(
              'w-8 h-8 rounded-md text-sm font-semibold ring-1',
              n === value
                ? 'bg-amber-400 text-white ring-amber-400'
                : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50',
            )}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Pay rates tab ────────────────────────────────────────────────────

function PayRatesTab() {
  const rates = usePayRates();
  const create = useCreatePayRate();
  const close = useClosePayRate();
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  if (rates.isLoading) return <LoadingSpinner />;
  const rows = rates.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-700">
          Per-substitute rates override the school default for matching (school, substitute,
          jobType, daterange).
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
        >
          + Add rate
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium text-gray-700">Substitute</th>
              <th className="px-4 py-2 font-medium text-gray-700">Job type</th>
              <th className="px-4 py-2 font-medium text-gray-700">Rate</th>
              <th className="px-4 py-2 font-medium text-gray-700">Effective from</th>
              <th className="px-4 py-2 font-medium text-gray-700">Effective to</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                  No pay rates configured. Add a school default to enable pay computation.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3 text-gray-900">
                  {isSchoolDefaultRate(r.substituteId) ? (
                    <span className="inline-flex items-center rounded-full bg-sky-100 text-sky-700 px-2 py-0.5 text-xs font-medium">
                      School default
                    </span>
                  ) : (
                    <span className="font-mono text-xs">{r.substituteId.slice(0, 12)}…</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-700">{r.jobType}</td>
                <td className="px-4 py-3 font-medium">{formatRate(r.rate, r.rateType)}</td>
                <td className="px-4 py-3 text-gray-700">{formatDate(r.effectiveFrom)}</td>
                <td className="px-4 py-3 text-gray-700">
                  {r.effectiveTo ? (
                    formatDate(r.effectiveTo)
                  ) : (
                    <span className="text-emerald-700">Open-ended</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {!r.effectiveTo && (
                    <button
                      type="button"
                      onClick={async () => {
                        const today = new Date().toISOString().slice(0, 10);
                        if (
                          !window.confirm(
                            `Close this rate effective ${today}? Future rates can then be added.`,
                          )
                        )
                          return;
                        try {
                          await close.mutateAsync({ id: r.id, effectiveTo: today });
                          toast('Rate closed', 'info');
                        } catch (e) {
                          toast(`Could not close: ${(e as Error).message}`, 'error');
                        }
                      }}
                      className="text-xs font-medium text-amber-600 hover:text-amber-700"
                    >
                      Close (today)
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <PayRateModal
          onClose={() => setOpen(false)}
          onSubmit={async (payload) => {
            try {
              await create.mutateAsync(payload);
              toast('Rate added', 'success');
              setOpen(false);
            } catch (e) {
              toast(`Could not add: ${(e as Error).message}`, 'error');
            }
          }}
          isPending={create.isPending}
        />
      )}
    </div>
  );
}

function PayRateModal({
  onClose,
  onSubmit,
  isPending,
}: {
  onClose: () => void;
  onSubmit: (payload: {
    substituteId?: string;
    jobType?: SubJobType;
    rate: number;
    rateType?: SubRateType;
    effectiveFrom: string;
    effectiveTo?: string;
    notes?: string;
  }) => Promise<void>;
  isPending: boolean;
}) {
  const [isDefault, setIsDefault] = useState(true);
  const [substituteId, setSubstituteId] = useState('');
  const [jobType, setJobType] = useState<SubJobType>('FULL_DAY');
  const [rate, setRate] = useState('180');
  const [rateType, setRateType] = useState<SubRateType>('DAILY');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Add pay rate"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              isPending ||
              (!isDefault && !substituteId) ||
              !effectiveFrom ||
              !rate ||
              Number(rate) < 0
            }
            onClick={() =>
              onSubmit({
                substituteId: isDefault ? undefined : substituteId,
                jobType,
                rate: Number(rate),
                rateType,
                effectiveFrom,
                effectiveTo: effectiveTo || undefined,
                notes: notes.trim() || undefined,
              })
            }
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Add rate
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          School default rate (applies to any substitute)
        </label>
        {!isDefault && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Substitute ID (UUID)
            </label>
            <input
              value={substituteId}
              onChange={(e) => setSubstituteId(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm font-mono"
              placeholder="Find from /substitutes/pool"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Job type</label>
            <select
              value={jobType}
              onChange={(e) => setJobType(e.target.value as SubJobType)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            >
              <option value="FULL_DAY">Full day</option>
              <option value="HALF_DAY">Half day</option>
              <option value="SPECIFIC_PERIODS">Specific periods</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Rate type</label>
            <select
              value={rateType}
              onChange={(e) => setRateType(e.target.value as SubRateType)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            >
              <option value="DAILY">Daily</option>
              <option value="HALF_DAY">Half day</option>
              <option value="HOURLY">Hourly</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Rate (USD)</label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            className="w-32 rounded-md border border-gray-300 p-2 text-sm"
          />
          <span className="text-xs text-gray-500 ml-2">{RATE_TYPE_LABEL[rateType]}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Effective from *</label>
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Effective to (optional)
            </label>
            <input
              type="date"
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
          />
        </div>
        <p className="text-xs text-gray-500">
          The schema EXCLUDE-gist rejects overlapping date ranges per (school, substitute, jobType).
          If you see a 409 conflict, close the prior rate&apos;s `effective_to` first.
        </p>
      </div>
    </Modal>
  );
}

// ── Cancellation policy tab ──────────────────────────────────────────

function PolicyTab() {
  const policy = useCancellationPolicy();
  const upsert = useUpsertCancellationPolicy();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);

  if (policy.isLoading) return <LoadingSpinner />;
  const p = policy.data;

  return (
    <div className="space-y-4">
      {!p && !editing && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="text-amber-900">
            No cancellation policy configured. Setting one allows the CancellationPolicyConsumer to
            apply consequences when substitutes cancel late.
          </p>
        </div>
      )}

      {p && !editing && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <DescItem term="Late window" value={`${p.lateWindowHours} hours before job start`} />
            <DescItem term="Consequence" value={CANCEL_CONSEQUENCE_LABEL[p.consequence]} />
            <DescItem
              term="Repeat threshold"
              value={`${p.repeatOffenceThreshold} late cancellations`}
            />
            {p.consequence === 'TEMPORARY_POOL_SUSPENSION' && (
              <DescItem
                term="Suspension duration"
                value={p.suspensionDurationDays ? `${p.suspensionDurationDays} days` : '—'}
              />
            )}
            {p.consequence === 'RATING_PENALTY' && (
              <DescItem
                term="Rating penalty"
                value={p.ratingPenaltyAmount ? `−${p.ratingPenaltyAmount}` : '—'}
              />
            )}
            {p.notes && (
              <div className="col-span-2">
                <DescItem term="Notes" value={p.notes} />
              </div>
            )}
          </div>
          <div className="border-t border-gray-100 pt-3 text-right">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-sm font-medium text-campus-600 hover:text-campus-700"
            >
              Edit policy →
            </button>
          </div>
        </div>
      )}

      {(editing || !p) && (
        <PolicyEditor
          initial={p}
          onSubmit={async (payload) => {
            try {
              await upsert.mutateAsync(payload);
              toast('Policy saved', 'success');
              setEditing(false);
            } catch (e) {
              toast(`Could not save: ${(e as Error).message}`, 'error');
            }
          }}
          onCancel={() => setEditing(false)}
          isPending={upsert.isPending}
        />
      )}
    </div>
  );
}

function PolicyEditor({
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  initial: ReturnType<typeof useCancellationPolicy>['data'];
  onSubmit: (payload: {
    lateWindowHours?: number;
    consequence?: SubCancelConsequence;
    suspensionDurationDays?: number;
    repeatOffenceThreshold?: number;
    ratingPenaltyAmount?: number;
    notes?: string;
  }) => Promise<void>;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [lateWindow, setLateWindow] = useState(initial?.lateWindowHours ?? 2);
  const [consequence, setConsequence] = useState<SubCancelConsequence>(
    initial?.consequence ?? 'WARNING_ONLY',
  );
  const [suspDays, setSuspDays] = useState(initial?.suspensionDurationDays ?? 7);
  const [threshold, setThreshold] = useState(initial?.repeatOffenceThreshold ?? 3);
  const [penalty, setPenalty] = useState(
    initial?.ratingPenaltyAmount ? parseFloat(initial.ratingPenaltyAmount) : 0.5,
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Late window (hours)
          </label>
          <input
            type="number"
            min={1}
            value={lateWindow}
            onChange={(e) => setLateWindow(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 p-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Repeat offence threshold
          </label>
          <input
            type="number"
            min={1}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 p-2 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Consequence</label>
        <select
          value={consequence}
          onChange={(e) => setConsequence(e.target.value as SubCancelConsequence)}
          className="w-full rounded-md border border-gray-300 p-2 text-sm"
        >
          <option value="WARNING_ONLY">{CANCEL_CONSEQUENCE_LABEL.WARNING_ONLY}</option>
          <option value="TEMPORARY_POOL_SUSPENSION">
            {CANCEL_CONSEQUENCE_LABEL.TEMPORARY_POOL_SUSPENSION}
          </option>
          <option value="PERMANENT_POOL_REMOVAL">
            {CANCEL_CONSEQUENCE_LABEL.PERMANENT_POOL_REMOVAL}
          </option>
          <option value="RATING_PENALTY">{CANCEL_CONSEQUENCE_LABEL.RATING_PENALTY}</option>
        </select>
      </div>
      {consequence === 'TEMPORARY_POOL_SUSPENSION' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Suspension duration (days)
          </label>
          <input
            type="number"
            min={1}
            value={suspDays}
            onChange={(e) => setSuspDays(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 p-2 text-sm"
          />
        </div>
      )}
      {consequence === 'RATING_PENALTY' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Penalty amount (1.0–5.0 deducted from synthetic rating)
          </label>
          <input
            type="number"
            min={0}
            max={5}
            step={0.1}
            value={penalty}
            onChange={(e) => setPenalty(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 p-2 text-sm"
          />
        </div>
      )}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-gray-300 p-2 text-sm"
        />
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
        {initial && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            onSubmit({
              lateWindowHours: lateWindow,
              consequence,
              repeatOffenceThreshold: threshold,
              suspensionDurationDays:
                consequence === 'TEMPORARY_POOL_SUSPENSION' ? suspDays : undefined,
              ratingPenaltyAmount: consequence === 'RATING_PENALTY' ? penalty : undefined,
              notes: notes.trim() || undefined,
            })
          }
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
        >
          Save policy
        </button>
      </div>
    </div>
  );
}

function DescItem({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{term}</dt>
      <dd className="text-sm text-gray-900 mt-0.5">{value}</dd>
    </div>
  );
}
