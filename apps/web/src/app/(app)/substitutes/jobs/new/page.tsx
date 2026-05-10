'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useEmployees } from '@/hooks/use-hr';
import { usePostJob } from '@/hooks/use-substitutes';
import { JOB_TYPE_LABEL } from '@/lib/substitutes-format';
import type { SubJobType } from '@/lib/types';

const todayPlus = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

export default function PostJobPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin =
    !!user && hasAnyPermission(user, ['sch-001:admin', 'sch-004:write', 'sch-004:admin']);
  const router = useRouter();
  const employees = useEmployees({}, isAdmin);
  const post = usePostJob();
  const { toast } = useToast();

  const [absentTeacherId, setAbsentTeacherId] = useState('');
  const [jobDate, setJobDate] = useState(todayPlus(1));
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('15:00');
  const [jobType, setJobType] = useState<SubJobType>('FULL_DAY');
  const [gradeLevel, setGradeLevel] = useState('');
  const [subject, setSubject] = useState('');
  const [requirements, setRequirements] = useState('');
  const [windowMins, setWindowMins] = useState(30);

  const teacherOptions = useMemo(() => {
    const rows = employees.data ?? [];
    return rows.filter((e) => e.employmentStatus === 'ACTIVE');
  }, [employees.data]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-700">
        Posting substitute jobs requires admin scope. Contact your school admin.
      </div>
    );
  }
  if (employees.isLoading) return <LoadingSpinner />;

  const valid = !!absentTeacherId && !!jobDate && !!startTime && !!endTime && endTime > startTime;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Post Substitute Job"
        description="Tier-1 POOL members will be notified immediately. After the acceptance window, the marketplace tier picks up unfilled jobs automatically."
      />

      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <Field label="Absent teacher *">
          <select
            value={absentTeacherId}
            onChange={(e) => setAbsentTeacherId(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
          >
            <option value="">Select a teacher...</option>
            {teacherOptions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.firstName} {e.lastName} ({e.employeeNumber ?? '—'})
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Date *">
            <input
              type="date"
              value={jobDate}
              onChange={(e) => setJobDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
          <Field label="Start *">
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
          <Field label="End *">
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
        </div>

        <Field label="Job type">
          <div className="flex gap-2">
            {(['FULL_DAY', 'HALF_DAY', 'SPECIFIC_PERIODS'] as SubJobType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setJobType(t)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium ring-1',
                  jobType === t
                    ? 'bg-campus-600 text-white ring-campus-600'
                    : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50',
                )}
              >
                {JOB_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Grade level (optional — improves matching)">
            <input
              value={gradeLevel}
              onChange={(e) => setGradeLevel(e.target.value)}
              placeholder="e.g. 5 or HIGH"
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
          <Field label="Subject (optional)">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Math"
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
        </div>

        <Field label="Special requirements (optional)">
          <textarea
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="Anything the substitute should know up front..."
          />
        </Field>

        <Field label="Acceptance window (minutes)">
          <input
            type="number"
            min={5}
            value={windowMins}
            onChange={(e) => setWindowMins(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 p-2 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Pool members get notified immediately. After this window, the JobNotificationWorker
            escalates to the wider marketplace.
          </p>
        </Field>

        <div className="border-t border-gray-100 pt-4 flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => router.push('/substitutes/coverage')}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || post.isPending}
            onClick={async () => {
              try {
                const job = await post.mutateAsync({
                  absentTeacherId,
                  jobDate,
                  startTime,
                  endTime,
                  jobType,
                  gradeLevel: gradeLevel.trim() || undefined,
                  subject: subject.trim() || undefined,
                  specialRequirements: requirements.trim() || undefined,
                  acceptanceWindowMinutes: windowMins,
                });
                toast(`Job posted • ${job.notifications.length} pool members notified`, 'success');
                router.push('/substitutes/coverage');
              } catch (e) {
                toast(`Could not post: ${(e as Error).message}`, 'error');
              }
            }}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Post job
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}
