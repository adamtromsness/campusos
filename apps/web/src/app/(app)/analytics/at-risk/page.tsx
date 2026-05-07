'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  useAtRiskConfigs,
  useAtRiskStudents,
  useCreateAtRiskConfig,
  useRunWorkers,
  useUpdateAtRiskConfig,
} from '@/hooks/use-analytics';
import { attendanceTone, formatGpa, formatPercent, gpaTone } from '@/lib/analytics-format';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

export default function AtRiskPage() {
  const user = useAuthStore((s) => s.user);
  const isWriter = hasAnyPermission(user, ['rpt-002:write']);
  const { toast } = useToast();
  const students = useAtRiskStudents();
  const configs = useAtRiskConfigs();
  const createConfig = useCreateAtRiskConfig();
  const updateConfig = useUpdateAtRiskConfig();
  const runWorkers = useRunWorkers();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [attendanceThreshold, setAttendanceThreshold] = useState('0.85');
  const [gradeThreshold, setGradeThreshold] = useState('2.0');

  const onCreate = async () => {
    try {
      const conditions: Record<string, unknown> = {};
      const a = Number(attendanceThreshold);
      const g = Number(gradeThreshold);
      if (!Number.isNaN(a) && a > 0) conditions.attendance_threshold = a;
      if (!Number.isNaN(g) && g > 0) conditions.grade_threshold = g;
      if (Object.keys(conditions).length === 0) {
        toast('Set at least one threshold', 'error');
        return;
      }
      await createConfig.mutateAsync({ name, description, triggerConditions: conditions });
      toast('At-risk configuration created', 'success');
      setCreateOpen(false);
      setName('');
      setDescription('');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Failed to create', 'error');
    }
  };

  const onEvaluate = async () => {
    try {
      const summaries = await runWorkers.mutateAsync({ worker: 'at-risk' });
      const r = summaries[0];
      toast(
        `At-risk evaluation ${r?.status} — ${r?.rowsWritten ?? 0} students reviewed`,
        r?.status === 'OK' ? 'success' : 'error',
      );
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="At-risk dashboard"
        description="Configurable thresholds drive nightly flagging. Newly flagged students fire rpt.at_risk.flagged."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
              ← Analytics
            </Link>
            {isWriter && (
              <>
                <button
                  onClick={onEvaluate}
                  disabled={runWorkers.isPending}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                >
                  Re-evaluate
                </button>
                <button
                  onClick={() => setCreateOpen(true)}
                  className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
                >
                  New configuration
                </button>
              </>
            )}
          </div>
        }
      />

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Active configurations</h2>
        {configs.isLoading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (configs.data ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
            No at-risk configurations yet.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(configs.data ?? []).map((c) => (
              <div
                key={c.id}
                className="rounded-card border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold text-gray-900">{c.name}</div>
                    {c.description && <div className="text-xs text-gray-500">{c.description}</div>}
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${c.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}
                  >
                    {c.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <pre className="mt-2 overflow-x-auto rounded-md bg-gray-50 p-2 text-xs text-gray-800">
                  {JSON.stringify(c.triggerConditions, null, 2)}
                </pre>
                {isWriter && (
                  <div className="mt-2">
                    <button
                      onClick={() =>
                        updateConfig.mutate(
                          { id: c.id, payload: { isActive: !c.isActive } },
                          {
                            onSuccess: () => toast('Updated', 'success'),
                            onError: (err: Error) => toast(err.message, 'error'),
                          },
                        )
                      }
                      className="text-xs text-campus-700 hover:underline"
                    >
                      {c.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-gray-900">Flagged students</h2>
        {students.isLoading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (students.data ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50 px-4 py-12 text-center text-sm text-emerald-700">
            No students currently at-risk. Re-evaluate to refresh.
          </div>
        ) : (
          <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  <Th>Student</Th>
                  <Th>Grade</Th>
                  <Th>GPA</Th>
                  <Th>Attendance</Th>
                  <Th>Triggered configs</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(students.data ?? []).map((s) => (
                  <tr key={s.studentId} className="bg-rose-50">
                    <Td>{s.studentName ?? '—'}</Td>
                    <Td>{s.gradeLevel ?? '—'}</Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${gpaTone(s.currentGpa)}`}
                      >
                        {formatGpa(s.currentGpa)}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${attendanceTone(s.attendanceRate)}`}
                      >
                        {formatPercent(s.attendanceRate)}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {s.flaggedConfigs.map((cfg) => (
                          <span
                            key={cfg}
                            className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800"
                          >
                            {cfg}
                          </span>
                        ))}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New at-risk configuration"
        footer={
          <>
            <button
              onClick={() => setCreateOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onCreate}
              disabled={createConfig.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Description</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">Attendance threshold (0-1)</div>
              <input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={attendanceThreshold}
                onChange={(e) => setAttendanceThreshold(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">GPA threshold (0-4)</div>
              <input
                type="number"
                step="0.1"
                min={0}
                max={4}
                value={gradeThreshold}
                onChange={(e) => setGradeThreshold(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
          <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            Conditions AND together. Leave a threshold blank or 0 to skip it. The worker
            re-evaluates nightly.
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
