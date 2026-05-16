'use client';

import { useState } from 'react';
import { PageHeader, EmptyState, LoadingSpinner } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';
import { useMyStudent } from '@/hooks/use-classroom';
import {
  useStudentCollegeApplications,
  useCreateCollegeApplication,
  useUpdateCollegeApplication,
  useUpcomingDeadlines,
} from '@/hooks/use-portfolio-advanced';
import type {
  CollegeApplicationDto,
  CollegeApplicationStatus,
  CollegeApplicationType,
} from '@/lib/types';

const STATUS_PILL: Record<CollegeApplicationStatus, string> = {
  RESEARCHING: 'bg-gray-100 text-gray-700',
  PREPARING: 'bg-amber-100 text-amber-700',
  SUBMITTED: 'bg-sky-100 text-sky-700',
  INTERVIEW_SCHEDULED: 'bg-violet-100 text-violet-700',
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
  WAITLISTED: 'bg-orange-100 text-orange-700',
};

const STATUS_OPTIONS: CollegeApplicationStatus[] = [
  'RESEARCHING',
  'PREPARING',
  'SUBMITTED',
  'INTERVIEW_SCHEDULED',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
];

const TYPE_OPTIONS: CollegeApplicationType[] = [
  'EARLY_DECISION',
  'EARLY_ACTION',
  'REGULAR',
  'ROLLING',
];

export default function CollegeApplicationsPage() {
  const { user } = useAuthStore();
  const myStudent = useMyStudent();
  const studentId = myStudent.data?.id ?? null;
  const apps = useStudentCollegeApplications(studentId);
  const create = useCreateCollegeApplication();
  const update = useUpdateCollegeApplication();
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({
    collegeName: '',
    applicationType: 'REGULAR' as CollegeApplicationType,
    deadline: '',
  });

  const isStudent = user?.personType === 'STUDENT';
  if (!isStudent) {
    return <CounsellorDeadlineView />;
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="College applications"
        description="Track your applications by deadline and status. Counsellors can see your progress."
      />
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Your applications</h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
        >
          {showForm ? 'Cancel' : 'Add college'}
        </button>
      </div>
      {showForm && (
        <form
          className="mb-6 grid grid-cols-1 gap-3 rounded-md border border-gray-200 bg-gray-50 p-4 sm:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.collegeName.trim()) return;
            await create.mutateAsync({
              collegeName: draft.collegeName,
              applicationType: draft.applicationType,
              deadline: draft.deadline || undefined,
            });
            setDraft({ collegeName: '', applicationType: 'REGULAR', deadline: '' });
            setShowForm(false);
          }}
        >
          <input
            value={draft.collegeName}
            onChange={(e) => setDraft({ ...draft, collegeName: e.target.value })}
            placeholder="College name"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            required
          />
          <select
            value={draft.applicationType}
            onChange={(e) =>
              setDraft({ ...draft, applicationType: e.target.value as CollegeApplicationType })
            }
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={draft.deadline}
            onChange={(e) => setDraft({ ...draft, deadline: e.target.value })}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="col-span-full">
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
            >
              {create.isPending ? 'Adding…' : 'Add college'}
            </button>
          </div>
        </form>
      )}
      {apps.isLoading ? (
        <LoadingSpinner />
      ) : !apps.data || apps.data.length === 0 ? (
        <EmptyState
          title="No college applications yet"
          description="Add a college to start tracking deadlines and status."
        />
      ) : (
        <ul className="space-y-3">
          {apps.data.map((a) => (
            <CollegeAppCard
              key={a.id}
              app={a}
              onStatusChange={async (status) =>
                update.mutateAsync({
                  applicationId: a.id,
                  payload: { status },
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CollegeAppCard({
  app,
  onStatusChange,
}: {
  app: CollegeApplicationDto;
  onStatusChange: (s: CollegeApplicationStatus) => Promise<unknown>;
}) {
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900">{app.collegeName}</h3>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[app.status]}`}
            >
              {app.status.replace('_', ' ')}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-600">
            {app.applicationType.replace('_', ' ')} ·{' '}
            {app.deadline ? `Deadline ${app.deadline.slice(0, 10)}` : 'No deadline set'}
          </p>
          {app.notes && <p className="mt-2 text-sm text-gray-500">{app.notes}</p>}
          <div className="mt-2 flex gap-4 text-xs text-gray-500">
            <span>Recs: {app.recommendationCount}</span>
            <span>Transcript: {app.transcriptSent ? 'sent' : 'pending'}</span>
            <span>Financial aid: {app.financialAidApplied ? 'applied' : 'pending'}</span>
          </div>
        </div>
        <select
          value={app.status}
          onChange={(e) => onStatusChange(e.target.value as CollegeApplicationStatus)}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}

function CounsellorDeadlineView() {
  const deadlines = useUpcomingDeadlines();
  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title="College application deadlines"
        description="Upcoming deadlines across all students — sorted by deadline ascending."
      />
      {deadlines.isLoading ? (
        <LoadingSpinner />
      ) : !deadlines.data || deadlines.data.length === 0 ? (
        <EmptyState title="No upcoming deadlines" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Student
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  College
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Deadline
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {deadlines.data.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {d.studentName ?? '(unknown)'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{d.collegeName}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {d.applicationType.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {d.deadline ? d.deadline.slice(0, 10) : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[d.status]}`}
                    >
                      {d.status.replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
