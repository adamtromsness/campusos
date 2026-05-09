'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import { useCreateNonDiscipline } from '@/hooks/use-incidents';
import {
  NON_DISCIPLINE_INCIDENT_TYPES,
  NON_DISCIPLINE_SEVERITIES,
  NON_DISCIPLINE_TYPE_LABEL,
  NonDisciplineIncidentType,
  NonDisciplineSeverity,
} from '@/lib/incidents-format';

/**
 * Non-discipline incident report form. Anyone with saf-003:write
 * (Teacher + Staff + Admin) can submit.
 */
export default function ReportIncidentPage() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const router = useRouter();
  const canReport = hasAnyPermission(user, ['saf-003:write']);
  const create = useCreateNonDiscipline();

  const [type, setType] = useState<NonDisciplineIncidentType>('STUDENT_INJURY');
  const [severity, setSeverity] = useState<NonDisciplineSeverity>('LOW');
  const [location, setLocation] = useState('');
  const [incidentDate, setIncidentDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [description, setDescription] = useState('');
  const [witnesses, setWitnesses] = useState('');
  const [studentsRaw, setStudentsRaw] = useState('');
  const [staffRaw, setStaffRaw] = useState('');

  if (!canReport) {
    return (
      <p className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        Reporting incidents requires saf-003:write.
      </p>
    );
  }

  const parseUuids = (s: string): string[] =>
    s
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter((x) => x.length === 36);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Report an incident</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/emergency/reports">
          ← All reports
        </Link>
      </div>

      <p className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Use this form for non-emergency incidents — playground injuries, property damage, medical
        episodes, environmental events. Emergencies (lockdown, fire, evacuation) go through the
        dashboard&apos;s Declare Emergency button.
      </p>

      <form
        className="space-y-4 rounded border border-slate-200 bg-white p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (description.trim().length < 10) {
            toast('Description must be at least 10 characters', 'error');
            return;
          }
          try {
            const students = parseUuids(studentsRaw);
            const staff = parseUuids(staffRaw);
            const out = await create.mutateAsync({
              incidentType: type,
              severity,
              location: location || undefined,
              incidentDate: new Date(incidentDate).toISOString(),
              description: description.trim(),
              witnesses: witnesses || undefined,
              studentsInvolved: students.length > 0 ? students : undefined,
              staffInvolved: staff.length > 0 ? staff : undefined,
            });
            toast(`Reported (${NON_DISCIPLINE_TYPE_LABEL[out.incidentType]}, ${out.severity})`);
            router.push('/emergency/reports');
          } catch (err) {
            toast(`Submit failed: ${(err as Error).message}`, 'error');
          }
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">Type</label>
            <select
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value as NonDisciplineIncidentType)}
            >
              {NON_DISCIPLINE_INCIDENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {NON_DISCIPLINE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">Severity</label>
            <select
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as NonDisciplineSeverity)}
            >
              {NON_DISCIPLINE_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">Location</label>
            <input
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Where did it happen?"
            />
          </div>
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">
              Date / time
            </label>
            <input
              type="datetime-local"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={incidentDate}
              onChange={(e) => setIncidentDate(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium uppercase text-slate-600">
            Description (≥ 10 chars)
          </label>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs font-medium uppercase text-slate-600">
            Witnesses (text)
          </label>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            value={witnesses}
            onChange={(e) => setWitnesses(e.target.value)}
            placeholder="Optional"
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">
              Students involved (comma-separated UUIDs)
            </label>
            <input
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={studentsRaw}
              onChange={(e) => setStudentsRaw(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">
              Staff involved (comma-separated UUIDs)
            </label>
            <input
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={staffRaw}
              onChange={(e) => setStaffRaw(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:bg-sky-300"
            disabled={create.isPending}
          >
            {create.isPending ? 'Submitting…' : 'Submit report'}
          </button>
        </div>
      </form>
    </div>
  );
}
