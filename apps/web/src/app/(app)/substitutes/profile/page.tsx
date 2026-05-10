'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useAuthStore } from '@/lib/auth-store';
import {
  useCreateAvailability,
  useCreatePreference,
  useCreateSubstituteProfile,
  useDeleteAvailability,
  useDeletePreference,
  useMyAvailability,
  useMyPreferences,
  useMySubstituteProfile,
} from '@/hooks/use-substitutes';
import {
  AVAILABILITY_TYPE_LABEL,
  AVAILABILITY_TYPE_PILL,
  DAY_OF_WEEK_LABEL,
  PREFERENCE_TYPE_LABEL,
  PREFERENCE_TYPE_PILL,
  formatDate,
  formatRating,
  formatTimeRange,
} from '@/lib/substitutes-format';
import type { AvailabilityType, PreferenceType } from '@/lib/types';

export default function SubstituteProfilePage() {
  const user = useAuthStore((s) => s.user);
  const profile = useMySubstituteProfile(!!user);
  const availability = useMyAvailability(!!user);
  const preferences = useMyPreferences(!!user);
  const createProfile = useCreateSubstituteProfile();
  const createAv = useCreateAvailability();
  const deleteAv = useDeleteAvailability();
  const createPref = useCreatePreference();
  const deletePref = useDeletePreference();
  const { toast } = useToast();
  const [setupOpen, setSetupOpen] = useState(false);
  const [avModalOpen, setAvModalOpen] = useState(false);
  const [prefModalOpen, setPrefModalOpen] = useState(false);

  if (!user) return null;
  if (profile.isLoading) return <LoadingSpinner />;
  const me = profile.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Substitute Profile"
        description={
          me
            ? `${me.displayName ?? 'No display name'} • ${me.totalAssignments} assignments • ${formatRating(me.overallRating)}`
            : 'Set up your platform-portable substitute profile'
        }
      />

      {!me ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center">
          <p className="text-sm text-gray-700 mb-3">
            You don&apos;t have a substitute profile yet. Create one to appear in the marketplace.
          </p>
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
          >
            Create profile
          </button>
        </div>
      ) : (
        <>
          <Card title="About">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <DescItem term="Display name" value={me.displayName ?? '—'} />
              <DescItem
                term="Years experience"
                value={me.yearsExperience !== null ? `${me.yearsExperience}` : '—'}
              />
              <DescItem
                term="Grade levels"
                value={me.gradeLevels.length > 0 ? me.gradeLevels.join(', ') : '—'}
              />
              <DescItem
                term="Subject areas"
                value={me.subjectAreas.length > 0 ? me.subjectAreas.join(', ') : '—'}
              />
              <DescItem
                term="Max travel"
                value={me.maxTravelMiles !== null ? `${me.maxTravelMiles} miles` : '—'}
              />
              <DescItem term="Currently available" value={me.isAvailable ? 'Yes' : 'No'} />
            </dl>
            {me.bio && (
              <>
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">
                    Bio
                  </p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{me.bio}</p>
                </div>
              </>
            )}
          </Card>

          <Card
            title={`Availability (${availability.data?.length ?? 0})`}
            actions={
              <button
                type="button"
                onClick={() => setAvModalOpen(true)}
                className="text-sm font-medium text-campus-600 hover:text-campus-700"
              >
                + Add slot
              </button>
            }
          >
            {availability.data && availability.data.length === 0 ? (
              <p className="text-sm text-gray-500">
                No availability set yet. Add at least one RECURRING row to receive job offers.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {availability.data?.map((a) => (
                  <li key={a.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          AVAILABILITY_TYPE_PILL[a.availabilityType],
                        )}
                      >
                        {AVAILABILITY_TYPE_LABEL[a.availabilityType]}
                      </span>
                      <span className="text-gray-700">
                        {a.availabilityType === 'RECURRING' && a.dayOfWeek !== null
                          ? `${DAY_OF_WEEK_LABEL[a.dayOfWeek]}`
                          : a.specificDate
                            ? formatDate(a.specificDate)
                            : ''}
                      </span>
                      <span className="text-gray-500 text-xs">
                        {formatTimeRange(a.startTime, a.endTime)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await deleteAv.mutateAsync(a.id);
                          toast('Removed', 'info');
                        } catch (e) {
                          toast(`Could not remove: ${(e as Error).message}`, 'error');
                        }
                      }}
                      className="text-xs text-gray-500 hover:text-rose-600"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title={`School preferences (${preferences.data?.length ?? 0})`}
            actions={
              <button
                type="button"
                onClick={() => setPrefModalOpen(true)}
                className="text-sm font-medium text-campus-600 hover:text-campus-700"
              >
                + Add preference
              </button>
            }
          >
            {preferences.data && preferences.data.length === 0 ? (
              <p className="text-sm text-gray-500">
                No preferences set. Mark schools you&apos;d prefer or want to avoid.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {preferences.data?.map((p) => (
                  <li key={p.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          PREFERENCE_TYPE_PILL[p.preferenceType],
                        )}
                      >
                        {PREFERENCE_TYPE_LABEL[p.preferenceType]}
                      </span>
                      <span className="text-gray-700 font-mono text-xs">
                        School {p.schoolId.slice(0, 8)}
                      </span>
                      {p.reason && (
                        <span className="text-xs text-gray-500 truncate">{p.reason}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await deletePref.mutateAsync(p.id);
                          toast('Removed', 'info');
                        } catch (e) {
                          toast(`Could not remove: ${(e as Error).message}`, 'error');
                        }
                      }}
                      className="text-xs text-gray-500 hover:text-rose-600"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {setupOpen && (
        <ProfileSetupModal
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          onSubmit={async (payload) => {
            try {
              await createProfile.mutateAsync({ ...payload, personId: user.personId });
              toast('Profile created', 'success');
              setSetupOpen(false);
            } catch (e) {
              toast(`Could not create profile: ${(e as Error).message}`, 'error');
            }
          }}
          isPending={createProfile.isPending}
        />
      )}
      {avModalOpen && (
        <AvailabilityModal
          open={avModalOpen}
          onClose={() => setAvModalOpen(false)}
          onSubmit={async (payload) => {
            try {
              await createAv.mutateAsync(payload);
              toast('Availability added', 'success');
              setAvModalOpen(false);
            } catch (e) {
              toast(`Could not add: ${(e as Error).message}`, 'error');
            }
          }}
          isPending={createAv.isPending}
        />
      )}
      {prefModalOpen && (
        <PreferenceModal
          open={prefModalOpen}
          onClose={() => setPrefModalOpen(false)}
          onSubmit={async (payload) => {
            try {
              await createPref.mutateAsync(payload);
              toast('Preference added', 'success');
              setPrefModalOpen(false);
            } catch (e) {
              toast(`Could not add: ${(e as Error).message}`, 'error');
            }
          }}
          isPending={createPref.isPending}
        />
      )}
    </div>
  );
}

function Card({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function DescItem({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{term}</dt>
      <dd className="text-sm text-gray-900 mt-0.5">{value}</dd>
    </div>
  );
}

function ProfileSetupModal({
  open,
  onClose,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    displayName: string;
    bio?: string;
    gradeLevels: string[];
    subjectAreas?: string[];
    yearsExperience?: number;
    maxTravelMiles?: number;
  }) => Promise<void>;
  isPending: boolean;
}) {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [gradeLevelsRaw, setGradeLevelsRaw] = useState('');
  const [subjectAreasRaw, setSubjectAreasRaw] = useState('');
  const [yearsExp, setYearsExp] = useState('');
  const [maxTravel, setMaxTravel] = useState('');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create your substitute profile"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || !displayName.trim() || !gradeLevelsRaw.trim()}
            onClick={() =>
              onSubmit({
                displayName: displayName.trim(),
                bio: bio.trim() || undefined,
                gradeLevels: gradeLevelsRaw
                  .split(',')
                  .map((s) => s.trim().toUpperCase())
                  .filter(Boolean),
                subjectAreas: subjectAreasRaw
                  ? subjectAreasRaw
                      .split(',')
                      .map((s) => s.trim().toUpperCase())
                      .filter(Boolean)
                  : undefined,
                yearsExperience: yearsExp ? Number(yearsExp) : undefined,
                maxTravelMiles: maxTravel ? Number(maxTravel) : undefined,
              })
            }
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Create
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Display name *">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="e.g. Sarah J."
          />
        </Field>
        <Field label="Grade levels * (comma-separated)">
          <input
            value={gradeLevelsRaw}
            onChange={(e) => setGradeLevelsRaw(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="ELEMENTARY, MIDDLE"
          />
        </Field>
        <Field label="Subject areas (comma-separated)">
          <input
            value={subjectAreasRaw}
            onChange={(e) => setSubjectAreasRaw(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="MATHS, SCIENCE"
          />
        </Field>
        <Field label="Bio">
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="A short summary of your experience..."
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Years experience">
            <input
              type="number"
              min={0}
              value={yearsExp}
              onChange={(e) => setYearsExp(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
          <Field label="Max travel (miles)">
            <input
              type="number"
              min={0}
              value={maxTravel}
              onChange={(e) => setMaxTravel(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function AvailabilityModal({
  open,
  onClose,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    availabilityType: AvailabilityType;
    dayOfWeek?: number;
    specificDate?: string;
    startTime?: string;
    endTime?: string;
  }) => Promise<void>;
  isPending: boolean;
}) {
  const [type, setType] = useState<AvailabilityType>('RECURRING');
  const [dow, setDow] = useState('1');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('15:00');
  const [allDay, setAllDay] = useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add availability"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || (type !== 'RECURRING' && !date)}
            onClick={() =>
              onSubmit({
                availabilityType: type,
                dayOfWeek: type === 'RECURRING' ? Number(dow) : undefined,
                specificDate: type !== 'RECURRING' ? date : undefined,
                startTime: allDay ? undefined : start,
                endTime: allDay ? undefined : end,
              })
            }
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Add
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Type">
          <div className="flex gap-2">
            {(['RECURRING', 'SPECIFIC', 'BLOCKED'] as AvailabilityType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium',
                  type === t
                    ? AVAILABILITY_TYPE_PILL[t]
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                )}
              >
                {AVAILABILITY_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </Field>
        {type === 'RECURRING' ? (
          <Field label="Day of week">
            <select
              value={dow}
              onChange={(e) => setDow(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            >
              {Object.entries(DAY_OF_WEEK_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
            />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          All day
        </label>
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2 text-sm"
              />
            </Field>
            <Field label="End">
              <input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2 text-sm"
              />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PreferenceModal({
  open,
  onClose,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    schoolId: string;
    preferenceType: PreferenceType;
    reason?: string;
  }) => Promise<void>;
  isPending: boolean;
}) {
  const [schoolId, setSchoolId] = useState('');
  const [type, setType] = useState<PreferenceType>('PREFERRED');
  const [reason, setReason] = useState('');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add school preference"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || !schoolId}
            onClick={() =>
              onSubmit({
                schoolId,
                preferenceType: type,
                reason: reason.trim() || undefined,
              })
            }
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Add
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="School ID">
          <input
            value={schoolId}
            onChange={(e) => setSchoolId(e.target.value)}
            placeholder="UUID — visible school directory is a future polish"
            className="w-full rounded-md border border-gray-300 p-2 text-sm font-mono"
          />
        </Field>
        <Field label="Preference">
          <div className="flex gap-2">
            {(['PREFERRED', 'BLOCKED'] as PreferenceType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium',
                  type === t
                    ? PREFERENCE_TYPE_PILL[t]
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                )}
              >
                {PREFERENCE_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Reason (private — only you can see this)">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
          />
        </Field>
      </div>
    </Modal>
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
