'use client';

import { useGuardianAccess, useSetGuardianAccess } from '@/hooks/use-relationships';
import { useToast } from '@/components/ui/Toast';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * "People who can edit my account" — the 18+ subject's self-service control
 * over guardian edit access (the post-18 consent switch).
 *
 * Shown ONLY to the subject themselves, and only once they are 18+ (under-18s
 * have nothing to manage — a guardian's access is automatic). The API enforces
 * the same: the GET 403s for under-18 / non-self callers, so we gate on age
 * here and simply render nothing when there's no control to show.
 *
 * Each guardian row carries Revoke (for GRANTED) or Grant (for REVOKED). A
 * guardian can never grant themselves access — only the subject sees this.
 * Navigation/permission is the server's call; this is the off switch.
 */
export function GuardianAccessSection({
  personId,
  dateOfBirth,
}: {
  personId: string;
  dateOfBirth: string | null;
}) {
  const age = ageFromDob(dateOfBirth);
  const isAdult = age !== null && age >= 18;
  const { data, isLoading, isError } = useGuardianAccess(personId, isAdult);

  // Under 18 (or unknown DOB): nothing to manage — access is automatic.
  if (!isAdult) return null;
  // The endpoint failed (e.g. race on the age gate) — stay quiet rather than
  // show a broken control.
  if (isError) return null;

  const guardians = data?.guardians ?? [];

  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">People who can edit my account</h2>
      <p className="mt-0.5 text-xs text-gray-500">
        You&rsquo;re 18+, so you control who may edit your account. Revoke a guardian to make your
        profile read-only for them; grant it back any time.
      </p>

      <div className="mt-4">
        {isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : guardians.length === 0 ? (
          <p className="text-sm text-gray-500">No one else can edit your account.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {guardians.map((g) => (
              <GuardianRow
                key={g.guardianPersonId}
                personId={personId}
                guardianPersonId={g.guardianPersonId}
                displayName={g.displayName}
                state={g.state}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function GuardianRow({
  personId,
  guardianPersonId,
  displayName,
  state,
}: {
  personId: string;
  guardianPersonId: string;
  displayName: string;
  state: 'GRANTED' | 'REVOKED';
}) {
  const { toast } = useToast();
  const setAccess = useSetGuardianAccess(personId);
  const granted = state === 'GRANTED';

  async function toggle() {
    const next = granted ? 'REVOKED' : 'GRANTED';
    try {
      await setAccess.mutateAsync({ guardianId: guardianPersonId, state: next });
      toast(
        next === 'REVOKED' ? `Removed ${displayName}'s edit access` : `Restored ${displayName}'s edit access`,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update access.', 'error');
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-200 bg-white p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900">{displayName}</p>
        <p className="text-xs text-gray-500">
          {granted ? 'Can edit your account' : 'Cannot edit your account'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={setAccess.isPending}
        className={
          granted
            ? 'inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-50 disabled:opacity-60'
            : 'inline-flex items-center gap-2 rounded-md bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60'
        }
      >
        {setAccess.isPending && <LoadingSpinner size="sm" />}
        <span>{granted ? 'Revoke access' : 'Grant access'}</span>
      </button>
    </li>
  );
}

function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
