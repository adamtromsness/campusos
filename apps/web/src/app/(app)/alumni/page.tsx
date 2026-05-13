'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAddAlumniTag,
  useAlumniProfiles,
  useMyAlumniProfile,
  useUpdateAlumniProfile,
} from '@/hooks/use-alumni';
import { COMMON_ALUMNI_TAGS, formatDateOnly } from '@/lib/alumni-format';
import type { AlumniProfileDto } from '@/lib/types';

export default function AlumniPortalPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  // Filters
  const [graduationYear, setGraduationYear] = useState('');
  const [employerSearch, setEmployerSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  const directoryQ = useAlumniProfiles({
    graduationYear: graduationYear ? Number(graduationYear) : undefined,
    employer: employerSearch || undefined,
    tag: tagFilter || undefined,
  });
  const myProfileQ = useMyAlumniProfile(!!user);

  // Stats
  const stats = useMemo(() => {
    const rows = directoryQ.data ?? [];
    const optedIn = rows.filter((r) => r.isOptedIn).length;
    const years = new Set(rows.map((r) => r.graduationYear));
    return { count: rows.length, optedIn, yearCount: years.size };
  }, [directoryQ.data]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Alumni"
        description={
          showStaffSurfaces
            ? 'Self-maintained alumni directory. Use tags to segment for outreach + campaigns.'
            : 'Reconnect with classmates. Search by year, employer, or tag — only opted-in alumni are visible.'
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/alumni/campaigns"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Campaigns
        </Link>
        <Link
          href="/alumni/news"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          News
        </Link>
        <Link
          href="/alumni/reunions"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Reunions
        </Link>
        <Link
          href="/alumni/events"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Events
        </Link>
      </div>

      {/* Own profile card */}
      {myProfileQ.data && <OwnProfileCard profile={myProfileQ.data} />}
      {!myProfileQ.isLoading && !myProfileQ.data && (
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Your profile
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            You do not have an alumni profile at this school yet. Once your graduation audit
            completes, the alumni office will invite you to create one.
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Directory size" value={String(stats.count)} />
        <Stat label="Opted in" value={String(stats.optedIn)} />
        <Stat label="Class years" value={String(stats.yearCount)} />
      </div>

      {/* Filters */}
      <div className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Directory
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-500">
              Graduation year
            </span>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              placeholder="e.g. 2020"
              value={graduationYear}
              onChange={(e) => setGraduationYear(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-500">Employer</span>
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              placeholder="search employer"
              value={employerSearch}
              onChange={(e) => setEmployerSearch(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-500">Tag</span>
            <select
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="">— any tag —</option>
              {COMMON_ALUMNI_TAGS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Results */}
      {directoryQ.isLoading ? (
        <p className="text-sm text-gray-500">Loading directory…</p>
      ) : (directoryQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No alumni match"
          description="Try clearing the filters or asking the alumni office to widen the directory."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {directoryQ.data!.map((p) => (
            <DirectoryCard key={p.id} profile={p} highlightOptOut={showStaffSurfaces} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function DirectoryCard({
  profile,
  highlightOptOut,
}: {
  profile: AlumniProfileDto;
  highlightOptOut: boolean;
}) {
  return (
    <li className="rounded-md border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-base font-semibold text-gray-900">{profile.displayName}</p>
            <span className="rounded bg-campus-50 px-2 py-0.5 text-xs font-medium text-campus-700 ring-1 ring-campus-200">
              Class of {profile.graduationYear}
            </span>
            {highlightOptOut && !profile.isOptedIn && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                Opted out
              </span>
            )}
          </div>
          {(profile.currentEmployer || profile.currentTitle) && (
            <p className="mt-1 text-sm text-gray-700">
              {profile.currentTitle ? <strong>{profile.currentTitle}</strong> : null}
              {profile.currentTitle && profile.currentEmployer ? ' at ' : null}
              {profile.currentEmployer}
            </p>
          )}
          {profile.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {profile.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-violet-200"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        {profile.linkedinUrl && (
          <a
            href={profile.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs text-campus-700 hover:underline"
          >
            LinkedIn ↗
          </a>
        )}
      </div>
    </li>
  );
}

function OwnProfileCard({ profile }: { profile: AlumniProfileDto }) {
  const { toast } = useToast();
  const update = useUpdateAlumniProfile(profile.id);
  const addTag = useAddAlumniTag();
  const [editOpen, setEditOpen] = useState(false);
  const [tagInput, setTagInput] = useState('');

  const toggleOptIn = async () => {
    try {
      await update.mutateAsync({ isOptedIn: !profile.isOptedIn });
      toast(
        profile.isOptedIn
          ? 'You are now hidden from the alumni directory.'
          : 'You are now visible in the alumni directory.',
        'success',
      );
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const addTagSubmit = async () => {
    const tag = tagInput.trim().toUpperCase().replace(/\s+/g, '_');
    if (!tag || !/^[A-Z][A-Z0-9_]*$/.test(tag)) {
      toast('Tag must be uppercase letters, digits, underscores (e.g. STEM_MENTOR).', 'error');
      return;
    }
    try {
      await addTag.mutateAsync({ alumniId: profile.id, tag });
      setTagInput('');
      toast('Tag added.', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <section className="rounded-md border border-campus-200 bg-campus-50/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-campus-700">
              Your profile
            </h2>
            <p className="mt-1 text-lg font-semibold text-gray-900">{profile.displayName}</p>
            <p className="text-sm text-gray-700">
              Class of {profile.graduationYear}
              {profile.degreeProgramme ? ' · ' + profile.degreeProgramme : ''}
            </p>
            {(profile.currentEmployer || profile.currentTitle) && (
              <p className="mt-1 text-sm text-gray-700">
                {profile.currentTitle ? <strong>{profile.currentTitle}</strong> : null}
                {profile.currentTitle && profile.currentEmployer ? ' at ' : null}
                {profile.currentEmployer}
              </p>
            )}
            <p className="mt-1 text-xs text-gray-500">
              Registered {formatDateOnly(profile.createdAt)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span
              className={
                'rounded px-2 py-1 text-xs font-medium ring-1 ' +
                (profile.isOptedIn
                  ? 'bg-emerald-100 text-emerald-700 ring-emerald-200'
                  : 'bg-amber-100 text-amber-700 ring-amber-200')
              }
            >
              {profile.isOptedIn ? 'Listed in directory' : 'Hidden from directory'}
            </span>
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
              onClick={toggleOptIn}
            >
              {profile.isOptedIn ? 'Hide me' : 'List me'}
            </button>
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
              onClick={() => setEditOpen(true)}
            >
              Edit details
            </button>
          </div>
        </div>

        {/* Tags */}
        <div className="mt-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Your tags (used for mentorship + campaign matching)
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {profile.tags.length === 0 ? (
              <span className="text-xs text-gray-500">No tags yet.</span>
            ) : (
              profile.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200"
                >
                  {t}
                </span>
              ))
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              placeholder="STEM_MENTOR"
              className="rounded-md border border-gray-300 px-2 py-1 text-sm"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
            <button
              type="button"
              className="rounded-md bg-campus-600 px-3 py-1 text-sm text-white hover:bg-campus-700"
              onClick={addTagSubmit}
              disabled={addTag.isPending}
            >
              Add tag
            </button>
            <span className="text-xs text-gray-500">
              Common: {COMMON_ALUMNI_TAGS.slice(0, 4).join(', ')}…
            </span>
          </div>
        </div>
      </section>

      <EditProfileModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        profile={profile}
        onSaved={() => setEditOpen(false)}
      />
    </>
  );
}

function EditProfileModal({
  open,
  onClose,
  profile,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  profile: AlumniProfileDto;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateAlumniProfile(profile.id);
  const [degreeProgramme, setDegreeProgramme] = useState(profile.degreeProgramme ?? '');
  const [currentEmployer, setCurrentEmployer] = useState(profile.currentEmployer ?? '');
  const [currentTitle, setCurrentTitle] = useState(profile.currentTitle ?? '');
  const [linkedinUrl, setLinkedinUrl] = useState(profile.linkedinUrl ?? '');
  const [contactEmail, setContactEmail] = useState(profile.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(profile.contactPhone ?? '');

  const submit = async () => {
    try {
      await update.mutateAsync({
        degreeProgramme: degreeProgramme || undefined,
        currentEmployer: currentEmployer || undefined,
        currentTitle: currentTitle || undefined,
        linkedinUrl: linkedinUrl || undefined,
        contactEmail: contactEmail || undefined,
        contactPhone: contactPhone || undefined,
      });
      toast('Profile updated.', 'success');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit your alumni profile"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={submit}
            disabled={update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Degree programme">
          <input
            type="text"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={degreeProgramme}
            onChange={(e) => setDegreeProgramme(e.target.value)}
          />
        </Field>
        <Field label="Current employer">
          <input
            type="text"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={currentEmployer}
            onChange={(e) => setCurrentEmployer(e.target.value)}
          />
        </Field>
        <Field label="Current title">
          <input
            type="text"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={currentTitle}
            onChange={(e) => setCurrentTitle(e.target.value)}
          />
        </Field>
        <Field label="LinkedIn URL">
          <input
            type="url"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={linkedinUrl}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            placeholder="https://linkedin.com/in/your-handle"
          />
        </Field>
        <Field label="Contact email">
          <input
            type="email"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
        </Field>
        <Field label="Contact phone">
          <input
            type="tel"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
