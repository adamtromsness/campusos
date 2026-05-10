'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFinancialAidPrograms,
  useCreateFinancialAidApplication,
} from '@/hooks/use-payments-advanced';
import { useAcademicYears } from '@/hooks/use-enrollment';
import { useMyChildren } from '@/hooks/use-children';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { INCOME_BAND_LABELS, INCOME_BANDS } from '@/lib/billing-format';
import type { IncomeBand, FinancialAidApplicationDocument } from '@/lib/types';

export default function ApplyForFinancialAidPage() {
  const user = useAuthStore((s) => s.user);
  const canWrite = !!user && hasAnyPermission(user, ['fin-002:write']);
  const router = useRouter();
  const { toast } = useToast();
  const programs = useFinancialAidPrograms({}, canWrite);
  const years = useAcademicYears();
  const children = useMyChildren();
  const create = useCreateFinancialAidApplication();

  const [studentId, setStudentId] = useState('');
  const [programId, setProgramId] = useState('');
  const [academicYearId, setAcademicYearId] = useState('');
  const [householdIncomeBand, setHouseholdIncomeBand] = useState<IncomeBand | ''>('');
  const [statement, setStatement] = useState('');
  const [docs, setDocs] = useState<FinancialAidApplicationDocument[]>([]);
  const [docInput, setDocInput] = useState({ s3Key: '', label: '' });

  // Auto-pick the only available year
  useEffect(() => {
    if (!academicYearId && years.data && years.data.length > 0) {
      const current = years.data.find((y) => y.isCurrent) ?? years.data[0]!;
      setAcademicYearId(current.id);
    }
  }, [academicYearId, years.data]);

  if (!user) return null;
  if (!canWrite) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Apply for financial aid" />
        <EmptyState
          title="Access required"
          description="Financial aid applications require fin-002:write."
        />
      </div>
    );
  }

  const submitDisabled = !studentId || !programId || !academicYearId || create.isPending;

  async function submit(asDraft: boolean) {
    try {
      const application = await create.mutateAsync({
        studentId,
        programId,
        academicYearId,
        householdIncomeBand: householdIncomeBand || undefined,
        applicationStatement: statement || undefined,
        supportingDocuments: docs.length > 0 ? docs : undefined,
        submit: !asDraft,
      });
      toast(asDraft ? 'Saved as draft' : 'Submitted financial aid application', 'success');
      router.push(`/payments/financial-aid?status=${application.status}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to submit application', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Apply for financial aid"
        description="Submit an application for one of your children. Approval creates an award against the programme fund."
      />

      {programs.isLoading || years.isLoading || children.isLoading ? (
        <LoadingSpinner />
      ) : (programs.data?.length ?? 0) === 0 ? (
        <div className="space-y-3">
          <EmptyState
            title="No programmes accepting applications"
            description="Check back later or contact the school office."
          />
          <p className="text-center text-sm">
            <Link href="/payments/financial-aid" className="text-campus-700 hover:underline">
              ← Back to financial aid
            </Link>
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <Section title="Student">
            <select
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="">— Select a child —</option>
              {(children.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName} (Grade {c.gradeLevel})
                </option>
              ))}
            </select>
          </Section>

          <Section title="Programme">
            <select
              value={programId}
              onChange={(e) => setProgramId(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="">— Select a programme —</option>
              {(programs.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (
                  {p.reductionType === 'PERCENTAGE'
                    ? `${p.reductionValue}%`
                    : `$${p.reductionValue}`}{' '}
                  reduction)
                </option>
              ))}
            </select>
          </Section>

          <Section title="Academic year">
            <select
              value={academicYearId}
              onChange={(e) => setAcademicYearId(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="">— Select an academic year —</option>
              {(years.data ?? []).map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                  {y.isCurrent ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </Section>

          <Section title="Household income band (optional)">
            <select
              value={householdIncomeBand}
              onChange={(e) => setHouseholdIncomeBand(e.target.value as IncomeBand)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="">— Prefer not to state —</option>
              {INCOME_BANDS.map((b) => (
                <option key={b} value={b}>
                  {INCOME_BAND_LABELS[b]}
                </option>
              ))}
            </select>
          </Section>

          <Section title="Statement (optional)">
            <textarea
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              rows={4}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              placeholder="Briefly describe your situation…"
            />
          </Section>

          <Section title="Supporting documents">
            {docs.length > 0 && (
              <ul className="mb-2 space-y-1 text-sm text-gray-700">
                {docs.map((d, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded border border-gray-200 bg-gray-50 px-2 py-1"
                  >
                    <span>
                      <strong>{d.label}</strong>{' '}
                      <span className="text-xs text-gray-500">({d.s3Key})</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setDocs(docs.filter((_, j) => j !== i))}
                      className="text-xs text-rose-700 hover:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={docInput.label}
                onChange={(e) => setDocInput({ ...docInput, label: e.target.value })}
                placeholder="Label (e.g. 2024 Tax Return)"
                className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
              <input
                type="text"
                value={docInput.s3Key}
                onChange={(e) => setDocInput({ ...docInput, s3Key: e.target.value })}
                placeholder="S3 key (signed URL)"
                className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  if (docInput.s3Key && docInput.label) {
                    setDocs([...docs, docInput]);
                    setDocInput({ s3Key: '', label: '' });
                  }
                }}
                className="rounded border border-campus-700 px-2 py-1.5 text-xs font-semibold text-campus-700 hover:bg-campus-50"
              >
                Add
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              In production, files upload via signed S3 URL. Today, paste any reference key for the
              demo.
            </p>
          </Section>

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={submitDisabled}
              onClick={() => submit(true)}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Save as draft
            </button>
            <button
              type="button"
              disabled={submitDisabled}
              onClick={() => submit(false)}
              className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
            >
              Submit application
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-gray-700">{title}</h3>
      {children}
    </div>
  );
}
