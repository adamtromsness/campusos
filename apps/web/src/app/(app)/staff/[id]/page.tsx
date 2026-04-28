'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import {
  useEmployee,
  useEmployeeCertifications,
  useEmployeeCompliance,
  useEmployeeDocuments,
  useLeaveRequests,
  useMyEmployee,
  useMyLeaveBalances,
} from '@/hooks/use-hr';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { CertificationDto, ComplianceUrgency, EmployeeDto } from '@/lib/types';

type TabKey = 'info' | 'certifications' | 'leave' | 'documents';

export default function EmployeeProfilePage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : '';
  const user = useAuthStore((s) => s.user);

  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const employee = useEmployee(id);
  const me = useMyEmployee(!!user);

  const isOwnProfile = !!me.data && me.data.id === id;
  const canSeeFullProfile = isAdmin || isOwnProfile;

  const [tab, setTab] = useState<TabKey>('info');

  if (!user) return null;

  if (employee.isLoading) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (employee.isError || !employee.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState title="Employee not found" description="This profile may have been removed." />
        <div className="mt-4">
          <Link href="/staff" className="text-sm text-campus-700 hover:underline">
            ← Back to directory
          </Link>
        </div>
      </div>
    );
  }

  const emp = employee.data;
  const tabs: { key: TabKey; label: string; visible: boolean }[] = [
    { key: 'info', label: 'Info', visible: true },
    { key: 'certifications', label: 'Certifications', visible: canSeeFullProfile },
    { key: 'leave', label: 'Leave', visible: canSeeFullProfile },
    { key: 'documents', label: 'Documents', visible: canSeeFullProfile },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-2">
        <Link
          href="/staff"
          className="text-sm text-gray-500 transition-colors hover:text-campus-700"
        >
          ← Staff Directory
        </Link>
      </div>
      <PageHeader
        title={emp.fullName}
        description={
          [emp.primaryPositionTitle, emp.employeeNumber].filter(Boolean).join(' · ') ||
          'No position assigned'
        }
      />

      <div className="mt-4 border-b border-gray-200">
        <nav className="flex flex-wrap gap-1">
          {tabs
            .filter((t) => t.visible)
            .map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'rounded-t-md px-3 py-2 text-sm font-medium transition-colors',
                  tab === t.key
                    ? 'border-b-2 border-campus-600 text-campus-700'
                    : 'text-gray-500 hover:text-campus-700',
                )}
              >
                {t.label}
              </button>
            ))}
        </nav>
      </div>

      <div className="mt-6">
        {tab === 'info' && <InfoTab emp={emp} />}
        {tab === 'certifications' && canSeeFullProfile && <CertificationsTab employeeId={emp.id} />}
        {tab === 'leave' && canSeeFullProfile && (
          <LeaveTab employeeId={emp.id} isOwnProfile={isOwnProfile} />
        )}
        {tab === 'documents' && canSeeFullProfile && <DocumentsTab employeeId={emp.id} />}
      </div>
    </div>
  );
}

function InfoTab({ emp }: { emp: EmployeeDto }) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm md:col-span-1">
        <div className="flex flex-col items-center text-center">
          <Avatar name={emp.fullName} size="lg" />
          <p className="mt-3 text-base font-semibold text-gray-900">{emp.fullName}</p>
          <p className="text-xs text-gray-500">{emp.email ?? '—'}</p>
        </div>
      </section>
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm md:col-span-2">
        <h3 className="text-sm font-semibold text-gray-900">Employment</h3>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <Field label="Employee number" value={emp.employeeNumber ?? '—'} />
          <Field label="Status" value={prettyStatus(emp.employmentStatus)} />
          <Field label="Type" value={prettyType(emp.employmentType)} />
          <Field label="Hire date" value={emp.hireDate} />
          {emp.terminationDate && (
            <Field label="Termination date" value={emp.terminationDate} />
          )}
          <Field
            label="Primary position"
            value={emp.primaryPositionTitle ?? '— not assigned'}
          />
        </dl>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm md:col-span-3">
        <h3 className="text-sm font-semibold text-gray-900">Position history</h3>
        {emp.positions.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No position assignments recorded.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {emp.positions.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <span className="font-medium text-gray-900">{p.positionTitle}</span>
                  {p.isPrimary && (
                    <span className="ml-2 rounded-full bg-campus-100 px-2 py-0.5 text-xs font-medium text-campus-700">
                      Primary
                    </span>
                  )}
                  {p.isTeachingRole && (
                    <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                      Teaching
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  {p.effectiveFrom} → {p.effectiveTo ?? 'present'} · FTE {p.fte.toFixed(2)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CertificationsTab({ employeeId }: { employeeId: string }) {
  const certs = useEmployeeCertifications(employeeId);
  const compliance = useEmployeeCompliance(employeeId);

  if (certs.isLoading || compliance.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (certs.isError || compliance.isError) {
    return <EmptyState title="Couldn’t load certifications" />;
  }

  const list = certs.data ?? [];
  const summary = compliance.data;

  return (
    <div className="space-y-6">
      {summary && (
        <section className="grid grid-cols-2 gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-4">
          <Stat label="Requirements" value={summary.totalRequirements} />
          <Stat label="Compliant" value={summary.compliantCount} tone="green" />
          <Stat label="Expiring" value={summary.amberCount} tone="amber" />
          <Stat label="Non-compliant" value={summary.redCount} tone="red" />
        </section>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900">Certifications</h3>
        {list.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No certifications on file yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {list.map((c) => (
              <CertificationRow key={c.id} cert={c} />
            ))}
          </ul>
        )}
      </section>

      {summary && summary.rows.length > 0 && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">Training requirements</h3>
          <ul className="mt-3 divide-y divide-gray-100">
            {summary.rows.map((r) => (
              <li key={r.requirementId} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-medium text-gray-900">{r.requirementName}</p>
                  <p className="text-xs text-gray-500">
                    {r.frequency} · {r.lastCompletedDate ? `last ${r.lastCompletedDate}` : 'never completed'}
                    {r.nextDueDate && ` · due ${r.nextDueDate}`}
                  </p>
                </div>
                <UrgencyPill urgency={r.urgency} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CertificationRow({ cert }: { cert: CertificationDto }) {
  const urgency: ComplianceUrgency =
    cert.verificationStatus === 'EXPIRED' || cert.verificationStatus === 'REVOKED'
      ? 'red'
      : cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= 90
        ? 'amber'
        : 'green';
  return (
    <li className="flex items-center justify-between py-2 text-sm">
      <div>
        <p className="font-medium text-gray-900">{cert.certificationName}</p>
        <p className="text-xs text-gray-500">
          {cert.certificationType.replace(/_/g, ' ').toLowerCase()}
          {cert.issuingBody && ` · ${cert.issuingBody}`}
          {cert.referenceNumber && ` · ref ${cert.referenceNumber}`}
        </p>
      </div>
      <div className="text-right text-xs text-gray-500">
        <UrgencyPill urgency={urgency} />
        <p className="mt-1">
          {cert.expiryDate
            ? `expires ${cert.expiryDate}${cert.daysUntilExpiry !== null ? ` · ${cert.daysUntilExpiry}d` : ''}`
            : 'no expiry'}
        </p>
      </div>
    </li>
  );
}

function LeaveTab({ employeeId, isOwnProfile }: { employeeId: string; isOwnProfile: boolean }) {
  const balances = useMyLeaveBalances(isOwnProfile);
  const requests = useLeaveRequests({ employeeId });

  return (
    <div className="space-y-6">
      {isOwnProfile ? (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">Balances</h3>
          {balances.isLoading ? (
            <div className="py-6 text-center">
              <LoadingSpinner />
            </div>
          ) : balances.isError ? (
            <p className="mt-3 text-sm text-gray-500">Couldn’t load balances.</p>
          ) : (balances.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No leave balances configured.</p>
          ) : (
            <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(balances.data ?? []).map((b) => (
                <li
                  key={b.leaveTypeId}
                  className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium text-gray-900">{b.leaveTypeName}</p>
                    <p className="text-xs text-gray-500">
                      accrued {b.accrued} · used {b.used} · pending {b.pending}
                    </p>
                  </div>
                  <span className="text-base font-semibold text-campus-700">{b.available}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p className="text-sm text-gray-500">
          Leave balances are visible only to the owning employee. Admins can view request history below.
        </p>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900">Request history</h3>
        {requests.isLoading ? (
          <div className="py-6 text-center">
            <LoadingSpinner />
          </div>
        ) : requests.isError ? (
          <p className="mt-3 text-sm text-gray-500">Couldn’t load requests.</p>
        ) : (requests.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No leave requests yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {(requests.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-medium text-gray-900">{r.leaveTypeName}</p>
                  <p className="text-xs text-gray-500">
                    {r.startDate} → {r.endDate} · {r.daysRequested}d
                    {r.reason && ` · ${r.reason}`}
                  </p>
                </div>
                <LeaveStatusPill status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DocumentsTab({ employeeId }: { employeeId: string }) {
  const docs = useEmployeeDocuments(employeeId);
  if (docs.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (docs.isError) return <EmptyState title="Couldn’t load documents" />;
  const list = docs.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title="No documents uploaded"
        description="Upload contracts, ID copies, or certification scans through the document workflow (Step 9)."
      />
    );
  }
  return (
    <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm">
      {list.map((d) => (
        <li key={d.id} className="flex items-center justify-between px-4 py-3 text-sm">
          <div>
            <p className="font-medium text-gray-900">{d.fileName}</p>
            <p className="text-xs text-gray-500">
              {d.documentTypeName}
              {d.fileSizeBytes !== null && ` · ${prettyBytes(d.fileSizeBytes)}`}
              {d.expiryDate && ` · expires ${d.expiryDate}`}
            </p>
          </div>
          <p className="text-xs text-gray-400">{d.uploadedAt.slice(0, 10)}</p>
        </li>
      ))}
    </ul>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-gray-900">{value}</dd>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'green' | 'amber' | 'red';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'red'
          ? 'text-red-700'
          : 'text-gray-900';
  return (
    <div className="text-center">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold', toneClass)}>{value}</p>
    </div>
  );
}

function UrgencyPill({ urgency }: { urgency: ComplianceUrgency }) {
  const cls =
    urgency === 'green'
      ? 'bg-emerald-100 text-emerald-800'
      : urgency === 'amber'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-red-100 text-red-800';
  const label = urgency === 'green' ? 'Compliant' : urgency === 'amber' ? 'Expiring' : 'Action';
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', cls)}>
      {label}
    </span>
  );
}

function LeaveStatusPill({ status }: { status: string }) {
  const cls =
    status === 'APPROVED'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'PENDING'
        ? 'bg-amber-100 text-amber-800'
        : status === 'REJECTED'
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-700';
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', cls)}>
      {status.toLowerCase()}
    </span>
  );
}

function prettyStatus(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace('_', ' ');
}

function prettyType(t: string): string {
  return t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
