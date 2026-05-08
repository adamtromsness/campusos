'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/lib/api-client';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useImportStaff,
  useImportStudents,
  type BulkImportResponseDto,
  type ImportStaffRow,
  type ImportStudentRow,
} from '@/hooks/use-configuration';

/**
 * Step 7 — Bulk imports for staff + students.
 *
 * Two CSV uploaders side-by-side. Each parses on the client, shows a
 * preview, and POSTs to the matching tenant transaction. Mirrors the
 * Step 2 room-import contract: validates row-by-row up-front, rejects
 * the whole batch on any failure with structured rowErrors.
 *
 * Per docs/campusos-school-configuration-admin.html step 07. Gated
 * on sys-001:admin.
 */

export default function ImportsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Bulk imports" />
        <EmptyState
          title="Admin access required"
          description="Bulk imports are gated on the SYS-001:admin permission."
        />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <PageHeader title="Bulk imports" />
        <p className="-mt-1 text-sm text-gray-600">
          <Link href="/admin/configuration" className="text-campus-700 hover:underline">
            ← Configuration
          </Link>
          {' · '}Upload staff and students from CSV. Each batch runs in one transaction.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <StaffImportCard />
        <StudentImportCard />
      </div>

      <p className="text-xs text-gray-500">
        Need to bulk-import rooms? That lives on the{' '}
        <Link href="/admin/configuration/facilities" className="text-campus-700 hover:underline">
          Facilities page
        </Link>
        .
      </p>
    </div>
  );
}

// ─── Staff card ───────────────────────────────────────────────────

function StaffImportCard() {
  const importStaff = useImportStaff();
  const { toast } = useToast();
  const [csv, setCsv] = useState('first_name,last_name,email,position_title,department\n');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<BulkImportResponseDto | null>(null);

  const parsed = useMemo(() => parseStaffCsv(csv), [csv]);

  return (
    <ImportCard
      title="Staff"
      description={
        <>
          <strong>Required:</strong> first_name, last_name, email. <strong>Optional:</strong>{' '}
          position_title, department.
        </>
      }
      sample="first_name,last_name,email,position_title,department\nAva,Lopez,ava@school.edu,Teacher,Mathematics"
      csv={csv}
      setCsv={setCsv}
      parsed={parsed.rows.length}
      parseErrors={parsed.parseErrors}
      submitting={submitting}
      errors={errors}
      result={result}
      previewBody={
        parsed.rows.length > 0 && (
          <div className="rounded-md border border-gray-200">
            <PreviewHeader count={parsed.rows.length} />
            <div className="max-h-40 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="border-b border-gray-200 text-left">
                    <th className="px-3 py-1.5">Name</th>
                    <th className="px-3 py-1.5">Email</th>
                    <th className="px-3 py-1.5">Position</th>
                    <th className="px-3 py-1.5">Department</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="px-3 py-1">
                        {r.firstName} {r.lastName}
                      </td>
                      <td className="px-3 py-1">{r.email}</td>
                      <td className="px-3 py-1">{r.positionTitle ?? '—'}</td>
                      <td className="px-3 py-1">{r.departmentName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }
      onSubmit={async () => {
        setSubmitting(true);
        setErrors([]);
        setResult(null);
        try {
          const res = await importStaff.mutateAsync(parsed.rows);
          setResult(res);
          if (res.created > 0)
            toast(
              `${res.created} staff imported${res.skipped > 0 ? ` · ${res.skipped} skipped` : ''}`,
              'success',
            );
          else if (res.skipped > 0) toast('All emails already existed — nothing to do', 'info');
        } catch (e) {
          handleImportErr(e, setErrors, toast);
        } finally {
          setSubmitting(false);
        }
      }}
    />
  );
}

// ─── Student card ─────────────────────────────────────────────────

function StudentImportCard() {
  const importStudents = useImportStudents();
  const { toast } = useToast();
  const [csv, setCsv] = useState(
    'first_name,last_name,student_number,grade_level,guardian_first_name,guardian_last_name,guardian_email\n',
  );
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<BulkImportResponseDto | null>(null);

  const parsed = useMemo(() => parseStudentCsv(csv), [csv]);

  return (
    <ImportCard
      title="Students"
      description={
        <>
          <strong>Required:</strong> first_name, last_name, student_number.{' '}
          <strong>Optional:</strong> grade_level, guardian_first_name, guardian_last_name,
          guardian_email. Provide guardian fields together to link a guardian.
        </>
      }
      sample="first_name,last_name,student_number,grade_level,guardian_first_name,guardian_last_name,guardian_email\nElijah,Park,S-2050,9,Jenny,Park,jenny@example.com"
      csv={csv}
      setCsv={setCsv}
      parsed={parsed.rows.length}
      parseErrors={parsed.parseErrors}
      submitting={submitting}
      errors={errors}
      result={result}
      previewBody={
        parsed.rows.length > 0 && (
          <div className="rounded-md border border-gray-200">
            <PreviewHeader count={parsed.rows.length} />
            <div className="max-h-40 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="border-b border-gray-200 text-left">
                    <th className="px-3 py-1.5">Student</th>
                    <th className="px-3 py-1.5">Number</th>
                    <th className="px-3 py-1.5">Grade</th>
                    <th className="px-3 py-1.5">Guardian</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="px-3 py-1">
                        {r.firstName} {r.lastName}
                      </td>
                      <td className="px-3 py-1">{r.studentNumber}</td>
                      <td className="px-3 py-1">{r.gradeLevel ?? '—'}</td>
                      <td className="px-3 py-1">
                        {r.guardianFirstName
                          ? `${r.guardianFirstName} ${r.guardianLastName ?? ''} (${r.guardianEmail ?? '—'})`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }
      onSubmit={async () => {
        setSubmitting(true);
        setErrors([]);
        setResult(null);
        try {
          const res = await importStudents.mutateAsync(parsed.rows);
          setResult(res);
          if (res.created > 0)
            toast(
              `${res.created} students imported${res.skipped > 0 ? ` · ${res.skipped} skipped` : ''}`,
              'success',
            );
          else if (res.skipped > 0)
            toast('All student numbers already existed — nothing to do', 'info');
        } catch (e) {
          handleImportErr(e, setErrors, toast);
        } finally {
          setSubmitting(false);
        }
      }}
    />
  );
}

// ─── Shared card ──────────────────────────────────────────────────

function ImportCard({
  title,
  description,
  sample,
  csv,
  setCsv,
  parsed,
  parseErrors,
  submitting,
  errors,
  result,
  previewBody,
  onSubmit,
}: {
  title: string;
  description: React.ReactNode;
  sample: string;
  csv: string;
  setCsv: (v: string) => void;
  parsed: number;
  parseErrors: string[];
  submitting: boolean;
  errors: string[];
  result: BulkImportResponseDto | null;
  previewBody: React.ReactNode;
  onSubmit: () => Promise<void>;
}) {
  return (
    <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 text-sm text-gray-700">{description}</p>
      <textarea
        rows={8}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder={sample}
        className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
      />
      {parseErrors.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Parse warnings:</p>
          <ul className="ml-4 list-disc">
            {parseErrors.slice(0, 5).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {previewBody && <div className="mt-3">{previewBody}</div>}
      {errors.length > 0 && (
        <div className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          <p className="font-semibold">Some rows were rejected:</p>
          <ul className="ml-4 list-disc">
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {result && (
        <div className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          <strong>{result.created}</strong> created · <strong>{result.skipped}</strong> skipped.
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={parsed === 0 || submitting}
          onClick={() => void onSubmit()}
          className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
        >
          {submitting ? 'Importing…' : `Import ${parsed} row${parsed === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  );
}

function PreviewHeader({ count }: { count: number }) {
  return (
    <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-600">
      Preview ({count} rows)
    </div>
  );
}

function handleImportErr(
  e: unknown,
  setErrors: (e: string[]) => void,
  toast: (msg: string, variant?: 'success' | 'error' | 'info' | 'warning') => void,
) {
  if (e instanceof ApiError) {
    const body = e.body as { rowErrors?: string[]; message?: string } | undefined;
    if (Array.isArray(body?.rowErrors)) {
      setErrors(body!.rowErrors);
      toast('Some rows failed — see details below', 'error');
      return;
    }
    toast(body?.message ?? 'Import failed', 'error');
    return;
  }
  toast(e instanceof Error ? e.message : 'Import failed', 'error');
}

// ─── CSV parsing ──────────────────────────────────────────────────

function parseStaffCsv(text: string): { rows: ImportStaffRow[]; parseErrors: string[] } {
  const rows: ImportStaffRow[] = [];
  const parseErrors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows, parseErrors };
  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const iFirst = idx('first_name');
  const iLast = idx('last_name');
  const iEmail = idx('email');
  const iPos = idx('position_title');
  const iDept = idx('department');
  if (iFirst === -1 || iLast === -1 || iEmail === -1) {
    parseErrors.push('Header missing — required: first_name, last_name, email.');
    return { rows, parseErrors };
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const cells = line.split(',').map((c) => c.trim());
    const firstName = cells[iFirst];
    const lastName = cells[iLast];
    const email = cells[iEmail];
    if (!firstName || !lastName || !email) {
      parseErrors.push(`Line ${i + 1}: missing required field.`);
      continue;
    }
    rows.push({
      firstName,
      lastName,
      email,
      positionTitle: iPos !== -1 ? cells[iPos] || null : null,
      departmentName: iDept !== -1 ? cells[iDept] || null : null,
    });
  }
  return { rows, parseErrors };
}

function parseStudentCsv(text: string): { rows: ImportStudentRow[]; parseErrors: string[] } {
  const rows: ImportStudentRow[] = [];
  const parseErrors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows, parseErrors };
  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const iFirst = idx('first_name');
  const iLast = idx('last_name');
  const iSn = idx('student_number');
  const iGrade = idx('grade_level');
  const iGFirst = idx('guardian_first_name');
  const iGLast = idx('guardian_last_name');
  const iGEmail = idx('guardian_email');
  if (iFirst === -1 || iLast === -1 || iSn === -1) {
    parseErrors.push('Header missing — required: first_name, last_name, student_number.');
    return { rows, parseErrors };
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const cells = line.split(',').map((c) => c.trim());
    const firstName = cells[iFirst];
    const lastName = cells[iLast];
    const studentNumber = cells[iSn];
    if (!firstName || !lastName || !studentNumber) {
      parseErrors.push(`Line ${i + 1}: missing required field.`);
      continue;
    }
    rows.push({
      firstName,
      lastName,
      studentNumber,
      gradeLevel: iGrade !== -1 ? cells[iGrade] || null : null,
      guardianFirstName: iGFirst !== -1 ? cells[iGFirst] || null : null,
      guardianLastName: iGLast !== -1 ? cells[iGLast] || null : null,
      guardianEmail: iGEmail !== -1 ? cells[iGEmail] || null : null,
    });
  }
  return { rows, parseErrors };
}
