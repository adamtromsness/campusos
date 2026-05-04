'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCreateIncident,
  useDisciplineCategories,
  useStudentsForReport,
} from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { SEVERITY_LABELS, SEVERITY_PILL } from '@/lib/discipline-format';
import type { DisciplineCategoryDto } from '@/lib/types';

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

function severityRank(sev: string): number {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[sev] ?? 4;
}

export default function ReportIncidentPage() {
  const user = useAuthStore((s) => s.user);
  const canReport = !!user && hasAnyPermission(user, ['beh-001:write']);
  const router = useRouter();
  const { toast } = useToast();

  const students = useStudentsForReport(canReport);
  const categories = useDisciplineCategories(canReport);
  const create = useCreateIncident();

  const [studentId, setStudentId] = useState<string>('');
  const [studentSearch, setStudentSearch] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [incidentDate, setIncidentDate] = useState<string>(todayIso());
  const [incidentTime, setIncidentTime] = useState<string>('');
  const [location, setLocation] = useState<string>('');
  const [witnesses, setWitnesses] = useState<string>('');
  const [description, setDescription] = useState<string>('');

  const sortedCategories = useMemo(() => {
    const list = (categories.data ?? []).filter((c) => c.isActive);
    return list.slice().sort((a, b) => {
      const sevDiff = severityRank(a.severity) - severityRank(b.severity);
      if (sevDiff !== 0) return sevDiff;
      return a.name.localeCompare(b.name);
    });
  }, [categories.data]);

  const filteredStudents = useMemo(() => {
    const list = students.data ?? [];
    const q = studentSearch.trim().toLowerCase();
    if (!q) return list.slice(0, 100);
    return list
      .filter((s) => {
        const name = (s.fullName || s.firstName + ' ' + s.lastName).toLowerCase();
        return (
          name.includes(q) ||
          (s.studentNumber ?? '').toLowerCase().includes(q) ||
          (s.gradeLevel ?? '').toLowerCase().includes(q)
        );
      })
      .slice(0, 100);
  }, [students.data, studentSearch]);

  const selectedCategory: DisciplineCategoryDto | undefined = sortedCategories.find(
    (c) => c.id === categoryId,
  );

  if (!user) return null;
  if (!canReport) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Report incident" />
        <EmptyState
          title="Access required"
          description="Reporting an incident requires the Behaviour write permission."
        />
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!studentId) {
      toast('Pick a student', 'error');
      return;
    }
    if (!categoryId) {
      toast('Pick a category', 'error');
      return;
    }
    if (!description.trim()) {
      toast('Description is required', 'error');
      return;
    }
    try {
      const created = await create.mutateAsync({
        studentId,
        categoryId,
        description: description.trim(),
        incidentDate,
        incidentTime: incidentTime || undefined,
        location: location.trim() || undefined,
        witnesses: witnesses.trim() || undefined,
      });
      toast('Incident reported', 'success');
      router.push('/behaviour/' + created.id);
    } catch (err: any) {
      toast('Could not report incident: ' + (err?.message ?? 'unknown error'), 'error');
    }
  }

  const isLoading = students.isLoading || categories.isLoading;
  const submitting = create.isPending;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Report incident" description="Log a new behaviour incident for review." />

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-lg border border-gray-200 bg-white p-6"
        >
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Student</label>
            <input
              type="text"
              value={studentSearch}
              onChange={(e) => setStudentSearch(e.target.value)}
              placeholder="Search by name, ID, or grade…"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white">
              {filteredStudents.length === 0 ? (
                <p className="p-3 text-sm text-gray-500">
                  {students.data?.length === 0
                    ? 'No students available.'
                    : 'No matches for that search.'}
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {filteredStudents.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setStudentId(s.id)}
                        className={cn(
                          'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50',
                          studentId === s.id ? 'bg-campus-50 ring-1 ring-campus-200' : '',
                        )}
                      >
                        <span className="font-medium text-gray-900">{s.fullName}</span>
                        <span className="text-xs text-gray-500">
                          {s.gradeLevel ? 'Grade ' + s.gradeLevel : ''}
                          {s.studentNumber ? ' · ' + s.studentNumber : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Category</label>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              <option value="">— pick a category —</option>
              {sortedCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {SEVERITY_LABELS[c.severity]}
                </option>
              ))}
            </select>
            {selectedCategory && (
              <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
                    SEVERITY_PILL[selectedCategory.severity],
                  )}
                >
                  {SEVERITY_LABELS[selectedCategory.severity]}
                </span>
                {selectedCategory.description && <span>{selectedCategory.description}</span>}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900">Date</label>
              <input
                type="date"
                value={incidentDate}
                onChange={(e) => setIncidentDate(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900">
                Time <span className="text-gray-400">(optional)</span>
              </label>
              <input
                type="time"
                value={incidentTime}
                onChange={(e) => setIncidentTime(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">
              Location <span className="text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Hallway B, Cafeteria, Room 101"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={5}
              maxLength={4000}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              placeholder="What happened? Be specific about behaviours observed."
            />
            <p className="mt-1 text-xs text-gray-400">{description.length} / 4000</p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900">
              Witnesses <span className="text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={witnesses}
              onChange={(e) => setWitnesses(e.target.value)}
              placeholder="Names of staff or students who witnessed the incident"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
            <Link
              href="/behaviour"
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-campus-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {submitting ? 'Submitting…' : 'Submit incident'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
