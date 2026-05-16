'use client';

import { useEffect, useState } from 'react';
import { PageHeader, EmptyState, LoadingSpinner } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';
import { useMyStudent } from '@/hooks/use-classroom';
import {
  useStudentResume,
  useUpdateResume,
  useGenerateResumePdf,
} from '@/hooks/use-portfolio-advanced';

/**
 * P2-27 Step 7 — Resume builder. Student-owned; counsellors / parents
 * have read-only view (server enforces). Generate-PDF assembles cross-
 * module data (endorsement skills + achievements + service hours +
 * extracurriculars).
 */
export default function ResumePage() {
  const { user } = useAuthStore();
  const myStudent = useMyStudent();
  const studentId = myStudent.data?.id ?? null;
  const resume = useStudentResume(studentId);
  const update = useUpdateResume();
  const generate = useGenerateResumePdf();

  const [objective, setObjective] = useState('');
  const [skills, setSkills] = useState('');

  useEffect(() => {
    if (resume.data) {
      setObjective(resume.data.objectiveStatement ?? '');
      setSkills((resume.data.skills ?? []).join(', '));
    }
  }, [resume.data]);

  const isStudent = user?.personType === 'STUDENT';
  if (!isStudent) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageHeader
          title="Resume builder"
          description="Resumes are student-owned. Students self-author their resume from their portfolio data."
        />
        <EmptyState title="Resume not available" />
      </div>
    );
  }

  if (resume.isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <LoadingSpinner />
      </div>
    );
  }
  if (!resume.data || !studentId) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageHeader title="Resume builder" />
        <EmptyState title="Initialise your resume" />
      </div>
    );
  }

  const r = resume.data;
  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Resume builder"
        description="Your resume auto-populates from endorsement skills, achievements, service hours, and activities."
      />
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Objective</h2>
        <textarea
          rows={3}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="A short professional objective statement."
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </section>
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Skills</h2>
        <p className="mb-2 text-xs text-gray-500">
          Comma-separated. Endorsement skills will be added automatically when you generate the PDF.
        </p>
        <input
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
          placeholder="e.g. Critical Thinking, Leadership"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {r.skills.map((s) => (
            <span
              key={s}
              className="inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700"
            >
              {s}
            </span>
          ))}
        </div>
      </section>
      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Service hours" value={r.serviceHoursTotal.toFixed(1)} />
        <StatCard label="Awards" value={String((r.awards as unknown[]).length)} />
        <StatCard label="Activities" value={String((r.extracurriculars as unknown[]).length)} />
      </section>
      {r.pdfS3Key && r.lastGeneratedAt && (
        <section className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <strong>PDF ready —</strong> generated {new Date(r.lastGeneratedAt).toLocaleString()} ·{' '}
          <code className="rounded bg-white px-2 py-0.5 text-xs">{r.pdfS3Key}</code>
        </section>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={update.isPending}
          onClick={async () => {
            await update.mutateAsync({
              studentId,
              payload: {
                objectiveStatement: objective,
                skills: skills
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
            });
          }}
          className="rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : 'Save resume'}
        </button>
        <button
          type="button"
          disabled={generate.isPending}
          onClick={async () => {
            const result = await generate.mutateAsync(studentId);
            alert(
              `PDF generated. Skills: ${result.skillsCount}, Awards: ${result.awardsCount}, Service hours: ${result.serviceHoursTotal}, Activities: ${result.extracurricularsCount}.`,
            );
          }}
          className="rounded-md border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
        >
          {generate.isPending ? 'Generating…' : 'Generate PDF'}
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}
