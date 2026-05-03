'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import {
  useChildLinkRequests,
  useChildSearch,
  useMyChildren,
  useSubmitAddNewChild,
  useSubmitLinkExistingChild,
} from '@/hooks/use-children';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Avatar } from '@/components/ui/Avatar';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type {
  ChildSearchArgs,
  ChildSearchResultDto,
  StudentDto,
  SubmitAddNewChildPayload,
} from '@/lib/types';

export default function ChildrenPage() {
  const user = useAuthStore((s) => s.user);
  const children = useMyChildren();
  const myRequests = useChildLinkRequests(undefined, !!user && user.personType === 'GUARDIAN');
  const [showAdd, setShowAdd] = useState(false);
  if (!user) return null;

  if (user.personType !== 'GUARDIAN') {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="My Children" />
        <EmptyState
          title="Not available"
          description="My Children is only available for guardian accounts."
        />
      </div>
    );
  }

  const pendingMine = (myRequests.data ?? []).filter((r) => r.status === 'PENDING');

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My Children"
        description="Your linked students."
        actions={
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            Add child
          </button>
        }
      />

      {pendingMine.length > 0 && (
        <div className="mb-4 rounded-card border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-medium text-amber-900">
            You have {pendingMine.length} pending request
            {pendingMine.length === 1 ? '' : 's'} awaiting admin review.
          </p>
          <ul className="mt-1 text-xs text-amber-800">
            {pendingMine.map((r) => (
              <li key={r.id}>
                {r.requestType === 'LINK_EXISTING'
                  ? `Link to ${r.existingStudentName ?? 'student'}`
                  : `Add ${r.newChildFirstName ?? ''} ${r.newChildLastName ?? ''}`}{' '}
                · submitted {new Date(r.createdAt).toLocaleDateString()}
              </li>
            ))}
          </ul>
        </div>
      )}

      {children.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading your children…
        </div>
      ) : children.isError ? (
        <EmptyState
          title="Couldn't load your children"
          description="The API returned an error. Try refreshing the page."
        />
      ) : (children.data ?? []).length === 0 ? (
        <EmptyState
          title="No children linked to this account"
          description="Use Add child to link an existing student or request a new one. The school office reviews every request."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(children.data ?? []).map((c) => (
            <ChildCard key={c.id} child={c} />
          ))}
        </div>
      )}

      <AddChildModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  );
}

function ChildCard({ child }: { child: StudentDto }) {
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex items-center gap-3 px-5 py-4">
        <Avatar name={child.fullName} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-gray-900">{child.fullName}</h3>
          <p className="text-sm text-gray-500">
            {child.gradeLevel ? `Grade ${child.gradeLevel}` : 'Grade —'}
            {child.studentNumber ? ` · #${child.studentNumber}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm">
        <Link
          href={`/children/${child.id}/attendance`}
          className="flex-1 rounded-lg bg-campus-700 px-3 py-2 text-center font-medium text-white shadow-card hover:bg-campus-600"
        >
          Attendance
        </Link>
        <Link
          href={`/children/${child.id}/grades`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          Grades
        </Link>
        <Link
          href={`/children/${child.id}/schedule`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          Schedule
        </Link>
        <Link
          href={`/children/${child.id}/absence-request`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          Report absence
        </Link>
      </div>
    </div>
  );
}

// ─── Add Child modal ─────────────────────────────────────────────

type AddChildStep = 'SEARCH' | 'PICK_RESULT' | 'ADD_NEW';

function AddChildModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<AddChildStep>('SEARCH');
  const [args, setArgs] = useState<ChildSearchArgs | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gender, setGender] = useState('');
  const [gradeLevel, setGradeLevel] = useState('');
  const search = useChildSearch(args);
  const linkExisting = useSubmitLinkExistingChild();
  const addNew = useSubmitAddNewChild();
  const { toast } = useToast();

  function reset() {
    setStep('SEARCH');
    setArgs(null);
    setFirstName('');
    setLastName('');
    setDateOfBirth('');
    setGender('');
    setGradeLevel('');
  }

  function close() {
    reset();
    onClose();
  }

  function startSearch() {
    if (!firstName.trim() || !lastName.trim() || !dateOfBirth) return;
    setArgs({ firstName: firstName.trim(), lastName: lastName.trim(), dateOfBirth });
    setStep('PICK_RESULT');
  }

  async function pickExisting(r: ChildSearchResultDto) {
    try {
      await linkExisting.mutateAsync({ existingStudentId: r.studentId });
      toast('Link request submitted — the school office will review it', 'success');
      close();
    } catch (e: any) {
      toast(e?.message || 'Could not submit the request', 'error');
    }
  }

  async function submitAddNew() {
    if (!firstName.trim() || !lastName.trim() || !dateOfBirth || !gradeLevel.trim()) return;
    const payload: SubmitAddNewChildPayload = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      dateOfBirth,
      gradeLevel: gradeLevel.trim(),
    };
    if (gender.trim()) payload.gender = gender.trim();
    try {
      await addNew.mutateAsync(payload);
      toast('Add-child request submitted — the school office will review it', 'success');
      close();
    } catch (e: any) {
      toast(e?.message || 'Could not submit the request', 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a child to your account"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          {step === 'SEARCH' && (
            <button
              type="button"
              onClick={startSearch}
              disabled={!firstName.trim() || !lastName.trim() || !dateOfBirth}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
            >
              Search
            </button>
          )}
          {step === 'PICK_RESULT' && (
            <button
              type="button"
              onClick={() => setStep('ADD_NEW')}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              Add new child
            </button>
          )}
          {step === 'ADD_NEW' && (
            <button
              type="button"
              onClick={submitAddNew}
              disabled={addNew.isPending || !gradeLevel.trim()}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
            >
              Submit add-new request
            </button>
          )}
        </>
      }
    >
      {step === 'SEARCH' && (
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">
            We&rsquo;ll first check whether this child already has a record at the school.
          </p>
          <label className="block">
            <span className="font-medium text-gray-700">First name</span>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block">
            <span className="font-medium text-gray-700">Last name</span>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block">
            <span className="font-medium text-gray-700">Date of birth</span>
            <input
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
        </div>
      )}

      {step === 'PICK_RESULT' && (
        <div className="space-y-3 text-sm">
          {search.isLoading ? (
            <div className="flex items-center gap-2 text-gray-500">
              <LoadingSpinner size="sm" /> Searching…
            </div>
          ) : (search.data ?? []).length === 0 ? (
            <p className="rounded-lg bg-gray-50 p-3 text-gray-700">
              No matching student record found. You can request to add this child as a new
              student — the school office will review your request before it becomes active.
            </p>
          ) : (
            <>
              <p className="text-gray-700">
                Match found — pick the student to request a link, or fall back to add-new.
              </p>
              <ul className="space-y-2">
                {(search.data ?? []).map((r) => (
                  <li
                    key={r.studentId}
                    className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{r.fullName}</p>
                      <p className="text-xs text-gray-500">
                        {r.gradeLevel ? `Grade ${r.gradeLevel}` : 'Grade —'}
                        {r.schoolName ? ` · ${r.schoolName}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => pickExisting(r)}
                      disabled={linkExisting.isPending}
                      className="rounded-lg bg-campus-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
                    >
                      Link to me
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {step === 'ADD_NEW' && (
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">
            New-child request — please provide the child&rsquo;s details. The school office
            will review and confirm.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="font-medium text-gray-700">First name</span>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
            <label className="block">
              <span className="font-medium text-gray-700">Last name</span>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
          </div>
          <label className="block">
            <span className="font-medium text-gray-700">Date of birth</span>
            <input
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="font-medium text-gray-700">Grade level</span>
              <input
                value={gradeLevel}
                onChange={(e) => setGradeLevel(e.target.value)}
                placeholder="e.g. 5"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
            <label className="block">
              <span className="font-medium text-gray-700">Gender (optional)</span>
              <input
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
          </div>
        </div>
      )}
    </Modal>
  );
}
