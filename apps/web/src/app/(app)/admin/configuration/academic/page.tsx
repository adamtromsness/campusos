'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/lib/api-client';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAcademicTree,
  useUpdateGradeBands,
  type GradeBandDefinitionEntry,
  type GradeBandDefinitions,
  type AcademicTreeBandNode,
  type AcademicTreeGradeNode,
} from '@/hooks/use-configuration';

/**
 * Step 3 — Academic Structure Manager.
 *
 * Year selector + tree of terms / bands / grades / classes. Grade
 * band configuration modal lets the admin group grade levels under
 * named bands (Lower School / Middle School / Upper School). Click a
 * grade or class to surface a small detail panel.
 *
 * Per docs/campusos-school-configuration-admin.html step 03. Gated
 * on sys-001:admin.
 */

const COMMON_GRADES = ['PK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

export default function AcademicPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const [yearId, setYearId] = useState<string | undefined>(undefined);
  const tree = useAcademicTree(yearId, isAdmin);
  const [showBandsModal, setShowBandsModal] = useState(false);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Academic Structure" />
        <EmptyState
          title="Admin access required"
          description="The Academic Manager is gated on the SYS-001:admin permission."
        />
      </div>
    );
  }

  const data = tree.data;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageHeader title="Academic Structure" />
          <p className="-mt-1 text-sm text-gray-600">
            <Link href="/admin/configuration" className="text-campus-700 hover:underline">
              ← Configuration
            </Link>
            {' · '}Years, terms, grades, and classes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data && data.availableYears.length > 0 && (
            <select
              value={yearId ?? data.selectedYear?.id ?? ''}
              onChange={(e) => setYearId(e.target.value || undefined)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            >
              {data.availableYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                  {y.isCurrent ? ' (current)' : ''}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setShowBandsModal(true)}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Configure grade bands
          </button>
        </div>
      </div>

      {tree.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading academic tree…
        </div>
      )}

      {tree.isError && <p className="text-sm text-rose-600">Failed to load academic tree.</p>}

      {data && (
        <>
          {data.selectedYear ? (
            <YearHeader year={data.selectedYear} terms={data.terms} />
          ) : (
            <div className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
              <p className="text-sm text-gray-700">
                No academic years configured yet. Create one in SIS first.
              </p>
            </div>
          )}

          {data.gradeBands.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
                Grade bands
              </h2>
              {data.gradeBands.map((b) => (
                <BandSection key={b.bandKey} band={b} />
              ))}
            </section>
          )}

          {data.ungroupedGrades.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
                Ungrouped grades
              </h2>
              <div className="rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                These grades have classes but aren&apos;t bound to any band. Add them to a band to
                organise the tree.
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {data.ungroupedGrades.map((g) => (
                  <GradeCard key={g.gradeLevel} grade={g} />
                ))}
              </div>
            </section>
          )}

          {data.gradeBands.length === 0 && data.ungroupedGrades.length === 0 && (
            <div className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
              <p className="text-sm text-gray-700">
                No classes scheduled in {data.selectedYear?.name ?? 'the selected year'} yet.
              </p>
            </div>
          )}
        </>
      )}

      {showBandsModal && data && (
        <GradeBandsModal
          existing={data.gradeBandDefinitions}
          knownGrades={collectKnownGrades(data)}
          onClose={() => setShowBandsModal(false)}
        />
      )}
    </div>
  );
}

// ─── Sections ─────────────────────────────────────────────────────

function YearHeader({
  year,
  terms,
}: {
  year: { name: string; startDate: string; endDate: string; isCurrent: boolean };
  terms: Array<{ id: string; name: string; startDate: string; endDate: string; termType: string }>;
}) {
  return (
    <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold text-gray-900">{year.name}</h2>
        <span className="text-xs uppercase tracking-wide text-gray-500">
          {year.startDate} → {year.endDate}
          {year.isCurrent ? ' · current' : ''}
        </span>
      </div>
      {terms.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600">Terms</p>
          <div className="flex flex-wrap gap-2">
            {terms.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-2 rounded-full bg-sky-50 px-3 py-1 text-xs text-sky-800"
              >
                <strong className="font-semibold">{t.name}</strong>
                <span className="text-sky-600">
                  {t.startDate} → {t.endDate}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function BandSection({ band }: { band: AcademicTreeBandNode }) {
  const totalClasses = band.grades.reduce((acc, g) => acc + g.classes.length, 0);
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-gray-900">{band.bandLabel}</h3>
        <span className="text-xs text-gray-500">
          {band.grades.length} grade{band.grades.length === 1 ? '' : 's'} · {totalClasses} classes
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {band.grades.map((g) => (
          <GradeCard key={g.gradeLevel} grade={g} />
        ))}
      </div>
    </div>
  );
}

function GradeCard({ grade }: { grade: AcademicTreeGradeNode }) {
  const label = grade.gradeLevel === '__ungraded__' ? 'Ungraded' : `Grade ${grade.gradeLevel}`;
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        <span className="text-xs text-gray-500">
          {grade.classes.length} {grade.classes.length === 1 ? 'class' : 'classes'}
        </span>
      </div>
      {grade.classes.length === 0 ? (
        <p className="text-xs italic text-gray-500">No classes scheduled.</p>
      ) : (
        <ul className="space-y-1">
          {grade.classes.map((cls) => (
            <li key={cls.id} className="rounded bg-white p-2 text-xs ring-1 ring-gray-100">
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-gray-900">
                  {cls.courseName} · {cls.sectionCode}
                </span>
                <span className="text-gray-500">
                  {cls.studentCount} student{cls.studentCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="mt-0.5 text-gray-600">
                {cls.teacherNames.length > 0 ? cls.teacherNames.join(', ') : 'No teacher'}
                {cls.roomText && <span className="ml-2 text-gray-400">· Room {cls.roomText}</span>}
                {cls.termName && <span className="ml-2 text-gray-400">· {cls.termName}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Grade bands modal ───────────────────────────────────────────

function GradeBandsModal({
  existing,
  knownGrades,
  onClose,
}: {
  existing: GradeBandDefinitions;
  knownGrades: string[];
  onClose: () => void;
}) {
  const update = useUpdateGradeBands();
  const { toast } = useToast();
  const [bands, setBands] = useState<GradeBandDefinitionEntry[]>(() =>
    existing.bands.length > 0
      ? existing.bands.map((b) => ({ ...b }))
      : [
          { key: 'lower', label: 'Lower School', grades: [] },
          { key: 'middle', label: 'Middle School', grades: [] },
          { key: 'upper', label: 'Upper School', grades: [] },
        ],
  );
  const [submitting, setSubmitting] = useState(false);

  const allGrades = useMemo(() => {
    const set = new Set([...COMMON_GRADES, ...knownGrades]);
    return Array.from(set).sort((a, b) => {
      const an = Number(a);
      const bn = Number(b);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
      if (a === 'PK') return -2;
      if (b === 'PK') return 2;
      if (a === 'K') return -1;
      if (b === 'K') return 1;
      return a.localeCompare(b);
    });
  }, [knownGrades]);

  const usedGrades = useMemo(() => new Set(bands.flatMap((b) => b.grades)), [bands]);

  function setBand(idx: number, patch: Partial<GradeBandDefinitionEntry>) {
    setBands((prev) => prev.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  }

  function toggleGrade(bandIdx: number, grade: string) {
    setBands((prev) =>
      prev.map((b, i) => {
        if (i === bandIdx) {
          const has = b.grades.includes(grade);
          return {
            ...b,
            grades: has ? b.grades.filter((g) => g !== grade) : [...b.grades, grade],
          };
        }
        // Remove the grade from any other band — exclusive ownership.
        return { ...b, grades: b.grades.filter((g) => g !== grade) };
      }),
    );
  }

  function removeBand(idx: number) {
    setBands((prev) => prev.filter((_, i) => i !== idx));
  }

  function addBand() {
    setBands((prev) => [
      ...prev,
      { key: `band-${prev.length + 1}`, label: `Band ${prev.length + 1}`, grades: [] },
    ]);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Configure grade bands"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await update.mutateAsync({ bands });
                toast('Grade bands saved', 'success');
                onClose();
              } catch (e) {
                if (e instanceof ApiError) {
                  const body = e.body as { message?: string } | undefined;
                  toast(body?.message ?? 'Save failed', 'error');
                } else {
                  toast('Save failed', 'error');
                }
              } finally {
                setSubmitting(false);
              }
            }}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save bands'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-700">
          Group grade levels into named bands (Lower School / Middle School / Upper School). Each
          grade can belong to at most one band.
        </p>

        {bands.map((band, idx) => {
          // Grades available in OTHER bands are disabled here so the operator
          // sees they're already claimed — clicking still toggles them over.
          return (
            <div key={idx} className="rounded-md border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <input
                  value={band.key}
                  onChange={(e) => setBand(idx, { key: e.target.value })}
                  placeholder="key"
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                />
                <input
                  value={band.label}
                  onChange={(e) => setBand(idx, { label: e.target.value })}
                  placeholder="Label"
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeBand(idx)}
                  className="rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                >
                  Remove
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {allGrades.map((g) => {
                  const inThis = band.grades.includes(g);
                  const inOther = !inThis && usedGrades.has(g);
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => toggleGrade(idx, g)}
                      className={`rounded-full px-3 py-1 text-xs ${
                        inThis
                          ? 'bg-campus-700 text-white'
                          : inOther
                            ? 'bg-gray-200 text-gray-500'
                            : 'border border-gray-300 bg-white text-gray-700 hover:border-campus-300'
                      }`}
                    >
                      {g}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={addBand}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-campus-700 hover:bg-campus-50"
        >
          + Add band
        </button>
      </div>
    </Modal>
  );
}

function collectKnownGrades(data: {
  gradeBands: AcademicTreeBandNode[];
  ungroupedGrades: AcademicTreeGradeNode[];
}): string[] {
  const set = new Set<string>();
  for (const b of data.gradeBands) for (const g of b.grades) set.add(g.gradeLevel);
  for (const g of data.ungroupedGrades) set.add(g.gradeLevel);
  return Array.from(set);
}
