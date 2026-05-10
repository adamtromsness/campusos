'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useCreateFinancialAidProgram,
  useFinancialAidApplications,
  useFinancialAidPrograms,
  useReviewFinancialAidApplication,
} from '@/hooks/use-payments-advanced';
import { useAcademicYears } from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_PILL,
  APPLICATION_STATUSES,
  INCOME_BAND_LABELS,
  REDUCTION_TYPE_LABELS,
  formatCurrency,
  formatDateOnly,
  fundRemainingPct,
  fundRemainingTone,
} from '@/lib/billing-format';
import type {
  FinancialAidApplicationDto,
  FinancialAidProgramDto,
  FinancialAidApplicationStatus,
  ReductionType,
} from '@/lib/types';

export default function FinancialAidPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-002:admin']);
  const canRead = !!user && hasAnyPermission(user, ['fin-002:read']);
  const programs = useFinancialAidPrograms({}, canRead);
  const [statusFilter, setStatusFilter] = useState<FinancialAidApplicationStatus | 'ALL'>('ALL');
  const apps = useFinancialAidApplications(
    statusFilter === 'ALL' ? {} : { status: statusFilter },
    canRead,
  );
  const [showNewProgram, setShowNewProgram] = useState(false);
  const [reviewApp, setReviewApp] = useState<FinancialAidApplicationDto | null>(null);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Financial Aid" description="Financial aid access required." />
        <EmptyState
          title="Access required"
          description="Ask a school admin for the Financial Aid app."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financial Aid"
        description={
          isAdmin
            ? 'Programmes, parent applications, and fund pool tracking.'
            : 'Track your financial aid applications.'
        }
        actions={
          <div className="flex gap-2">
            {!isAdmin && (
              <Link
                href="/payments/financial-aid/apply"
                className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800"
              >
                Apply for aid
              </Link>
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={() => setShowNewProgram(true)}
                className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800"
              >
                New programme
              </button>
            )}
          </div>
        }
      />

      {programs.isLoading ? (
        <LoadingSpinner />
      ) : (programs.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No programmes yet"
          description={
            isAdmin ? 'Create one to start accepting applications.' : 'Check back later.'
          }
        />
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
            Programmes
          </h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {(programs.data ?? []).map((p) => (
              <ProgramCard key={p.id} program={p} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
            {isAdmin ? 'Application queue' : 'My applications'}
          </h2>
          <div className="flex flex-wrap gap-1">
            <FilterChip
              active={statusFilter === 'ALL'}
              onClick={() => setStatusFilter('ALL')}
              label="All"
            />
            {APPLICATION_STATUSES.map((s) => (
              <FilterChip
                key={s}
                active={statusFilter === s}
                onClick={() => setStatusFilter(s)}
                label={APPLICATION_STATUS_LABELS[s]}
              />
            ))}
          </div>
        </div>
        {apps.isLoading ? (
          <LoadingSpinner />
        ) : (apps.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No applications"
            description={
              isAdmin ? 'Nothing to review.' : 'Submit an application to apply for financial aid.'
            }
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Programme</th>
                  <th className="px-3 py-2">Income band</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Submitted</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(apps.data ?? []).map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">{a.studentName ?? a.studentId}</td>
                    <td className="px-3 py-2">{a.programName}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {a.householdIncomeBand ? INCOME_BAND_LABELS[a.householdIncomeBand] : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${APPLICATION_STATUS_PILL[a.status]}`}
                      >
                        {APPLICATION_STATUS_LABELS[a.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-600">{formatDateOnly(a.submittedAt)}</td>
                    <td className="px-3 py-2 text-right">
                      {isAdmin && (a.status === 'SUBMITTED' || a.status === 'UNDER_REVIEW') ? (
                        <button
                          type="button"
                          onClick={() => setReviewApp(a)}
                          className="text-xs font-semibold text-campus-700 hover:underline"
                        >
                          Review
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showNewProgram && <NewProgramModal onClose={() => setShowNewProgram(false)} />}
      {reviewApp && <ReviewApplicationModal app={reviewApp} onClose={() => setReviewApp(null)} />}
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
        active
          ? 'border-campus-700 bg-campus-700 text-white'
          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  );
}

function ProgramCard({ program }: { program: FinancialAidProgramDto }) {
  const pct = fundRemainingPct(program);
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{program.name}</h3>
          {program.description && (
            <p className="mt-1 text-sm text-gray-600 line-clamp-2">{program.description}</p>
          )}
          <p className="mt-2 text-xs text-gray-600">
            {REDUCTION_TYPE_LABELS[program.reductionType as ReductionType]} —{' '}
            {program.reductionType === 'PERCENTAGE'
              ? `${program.reductionValue}%`
              : formatCurrency(program.reductionValue)}{' '}
            reduction
          </p>
        </div>
        {!program.isActive && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            Inactive
          </span>
        )}
      </div>
      {program.totalFundAmount !== null ? (
        <div className="mt-3">
          <div className="flex items-baseline justify-between text-xs text-gray-600">
            <span>Fund remaining</span>
            <span>
              {formatCurrency(program.fundRemaining ?? 0)} of{' '}
              {formatCurrency(program.totalFundAmount)}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded bg-gray-200">
            <div
              className={`h-full ${fundRemainingTone(pct)}`}
              style={{ width: `${pct ?? 100}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-gray-500">Uncapped fund</p>
      )}
    </div>
  );
}

function NewProgramModal({ onClose }: { onClose: () => void }) {
  const create = useCreateFinancialAidProgram();
  const years = useAcademicYears();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [reductionType, setReductionType] = useState<ReductionType>('PERCENTAGE');
  const [reductionValue, setReductionValue] = useState('15');
  const [totalFund, setTotalFund] = useState('50000');
  const [academicYearId, setAcademicYearId] = useState('');

  async function submit() {
    try {
      await create.mutateAsync({
        name,
        description: description || undefined,
        reductionType,
        reductionValue: Number(reductionValue),
        totalFundAmount: totalFund ? Number(totalFund) : undefined,
        academicYearId: academicYearId || undefined,
      });
      toast(`Created programme "${name}"`, 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to create programme', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New financial aid programme"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name || !reductionValue || create.isPending}
            onClick={submit}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Need-Based Aid"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reduction type">
            <select
              value={reductionType}
              onChange={(e) => setReductionType(e.target.value as ReductionType)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="PERCENTAGE">Percentage</option>
              <option value="FIXED_AMOUNT">Fixed amount</option>
            </select>
          </Field>
          <Field label={reductionType === 'PERCENTAGE' ? 'Value (%)' : 'Value ($)'}>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={reductionValue}
              onChange={(e) => setReductionValue(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </Field>
        </div>
        <Field label="Total fund ($) — leave empty for uncapped">
          <input
            type="number"
            step="0.01"
            min="0"
            value={totalFund}
            onChange={(e) => setTotalFund(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Academic year (optional)">
          <select
            value={academicYearId}
            onChange={(e) => setAcademicYearId(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">— Any year —</option>
            {(years.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function ReviewApplicationModal({
  app,
  onClose,
}: {
  app: FinancialAidApplicationDto;
  onClose: () => void;
}) {
  const review = useReviewFinancialAidApplication(app.id);
  const { toast } = useToast();
  const [action, setAction] = useState<'APPROVE' | 'REJECT' | 'UNDER_REVIEW'>('APPROVE');
  const [awardAmount, setAwardAmount] = useState('1500');
  const [reviewerNotes, setReviewerNotes] = useState('');

  const summaryDocs = useMemo(() => app.supportingDocuments ?? [], [app.supportingDocuments]);

  async function submit() {
    try {
      await review.mutateAsync({
        action,
        awardAmount: action === 'APPROVE' && awardAmount ? Number(awardAmount) : undefined,
        reviewerNotes: reviewerNotes || undefined,
      });
      toast(`Application ${action.toLowerCase()}d`, 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Review failed', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Review: ${app.studentName ?? app.studentId}`}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={review.isPending || (action === 'APPROVE' && !awardAmount)}
            onClick={submit}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 ${
              action === 'REJECT'
                ? 'bg-rose-700 hover:bg-rose-800'
                : 'bg-campus-700 hover:bg-campus-800'
            }`}
          >
            {action === 'APPROVE'
              ? 'Approve + create award'
              : action === 'REJECT'
                ? 'Reject'
                : 'Mark under review'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Application</p>
          <p className="mt-1">
            <span className="font-semibold">{app.studentName}</span> · {app.programName}
          </p>
          <p className="mt-1 text-xs text-gray-600">
            Submitted by {app.guardianName} ·{' '}
            {app.householdIncomeBand
              ? INCOME_BAND_LABELS[app.householdIncomeBand]
              : 'Income band not stated'}
          </p>
        </div>
        {app.applicationStatement && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Statement</p>
            <p className="mt-1 whitespace-pre-wrap text-gray-800">{app.applicationStatement}</p>
          </div>
        )}
        {summaryDocs.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Supporting documents
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-gray-700">
              {summaryDocs.map((d, i) => (
                <li key={i}>{d.label}</li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Review action">
          <div className="flex flex-wrap gap-2">
            {(['APPROVE', 'UNDER_REVIEW', 'REJECT'] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAction(a)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  action === a
                    ? a === 'REJECT'
                      ? 'border-rose-700 bg-rose-700 text-white'
                      : 'border-campus-700 bg-campus-700 text-white'
                    : 'border-gray-300 bg-white text-gray-700'
                }`}
              >
                {a === 'APPROVE' ? 'Approve' : a === 'REJECT' ? 'Reject' : 'Under review'}
              </button>
            ))}
          </div>
        </Field>
        {action === 'APPROVE' && (
          <Field label="Award amount ($)">
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={awardAmount}
              onChange={(e) => setAwardAmount(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              Decrements the programme&apos;s fund_remaining atomically. Cannot exceed remaining
              fund.
            </p>
          </Field>
        )}
        <Field label="Reviewer notes (optional)">
          <textarea
            value={reviewerNotes}
            onChange={(e) => setReviewerNotes(e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Add internal review notes…"
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
