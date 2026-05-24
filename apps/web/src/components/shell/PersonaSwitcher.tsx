'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api-client';
import {
  useAuthStore,
  type ActivePersona,
  type AuthUser,
  type PersonaType,
  type UserPersona,
} from '@/lib/auth-store';
import {
  AcademicCapIcon,
  BriefcaseIcon,
  CheckIcon,
  ChevronDownIcon,
  ChildrenIcon,
  HeartIcon,
  SubstitutesIcon,
  TrophyIcon,
} from './icons';

/**
 * Persona switcher pill — top-bar entry point for changing the active
 * persona AND adding new profiles.
 *
 * Dropdown layout:
 *   ── Active personas (grouped by type) ──
 *     ✓ Parent
 *     ✓ Staff at Lincoln Elementary
 *   ── Add a profile ─────────────────────
 *     Staff             (expands inline invite-code form)
 *     Substitute        (navigates to /substitute/register)
 *
 * Switch flow: POST /auth/switch-persona, drop the fresh MeResponse
 * into Zustand, invalidate every React Query so per-app data refetches.
 *
 * Add flow (Staff): GET /invitations/:token to validate EMPLOYEE type,
 * POST /invitations/:token/accept to materialise the hr_employees row,
 * then POST /auth/switch-persona with the returned personaId so the
 * new STAFF persona becomes active immediately.
 *
 * The dropdown is interactive whenever the user has at least one
 * persona — even with a single persona we want to surface the
 * "Add a profile" options. The pill is hidden entirely for 0-persona
 * users (AppLayout has already routed them to /getting-started).
 */

type IconComponent = (props: { className?: string }) => React.ReactNode;

const TYPE_ICON: Record<PersonaType, IconComponent> = {
  STAFF: BriefcaseIcon,
  PARENT: ChildrenIcon,
  STUDENT: AcademicCapIcon,
  SUBSTITUTE: SubstitutesIcon,
  ALUMNI: TrophyIcon,
  COMMUNITY: HeartIcon,
};

const TYPE_LABEL: Record<PersonaType, string> = {
  STAFF: 'Staff',
  PARENT: 'Parent',
  STUDENT: 'Student',
  SUBSTITUTE: 'Substitute',
  ALUMNI: 'Alumni',
  COMMUNITY: 'Community',
};

// Display order in the dropdown grouping. STAFF first because most
// employee workflows are the primary use case; PARENT next because
// parent-teacher conferences and billing depend on it; STUDENT third
// for current students who hold both. SUBSTITUTE / ALUMNI / COMMUNITY
// tail.
const TYPE_ORDER: PersonaType[] = [
  'STAFF',
  'PARENT',
  'STUDENT',
  'SUBSTITUTE',
  'ALUMNI',
  'COMMUNITY',
];

// Persona types that have a self-serve "add" flow. PARENT is added by
// linking a child; STUDENT comes from enrolment; ALUMNI is provisioned
// by the school's graduation worker; COMMUNITY follows group membership.
// Only STAFF (invite code) and SUBSTITUTE (registration form) are
// surfaced as user-initiated profile additions here.
type AddablePersonaType = 'STAFF' | 'SUBSTITUTE';
const ADDABLE_TYPES: AddablePersonaType[] = ['STAFF', 'SUBSTITUTE'];

const ADD_OPTION_COPY: Record<AddablePersonaType, { label: string; hint: string }> = {
  STAFF: { label: 'Staff', hint: 'Enter an employee invitation code' },
  SUBSTITUTE: { label: 'Substitute Teacher', hint: 'Register as a substitute' },
};

interface MeResponse {
  user: {
    id: string;
    personId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    preferredName: string | null;
    displayName: string;
  };
  activePersona: ActivePersona | null;
  personas: UserPersona[];
  permissions: string[];
}

interface InvitationSummary {
  id: string;
  type: 'EMPLOYEE' | 'CHILD_LINK' | 'PARENT_LINK' | 'SUBSTITUTE';
  inviterName: string;
  schoolId: string | null;
  schoolName: string | null;
  jobTitle: string | null;
  expiresAt: string;
  status: string;
}

interface AcceptInvitationResult {
  invitationId: string;
  type: InvitationSummary['type'];
  personaType: string | null;
  personaId: string | null;
  schoolId: string | null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function meToAuthUser(me: MeResponse): AuthUser {
  return {
    ...me.user,
    activePersona: me.activePersona,
    personas: me.personas,
    permissions: me.permissions,
  };
}

export function PersonaSwitcher() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [staffInviteOpen, setStaffInviteOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on click-outside or Escape. Two listeners share one cleanup.
  useEffect(() => {
    if (!open) return;
    function handleClickAway(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setStaffInviteOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setStaffInviteOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickAway);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickAway);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  // Reset the inline staff invite form whenever the dropdown closes so
  // a re-open starts from the option list, not a stale form.
  useEffect(() => {
    if (!open) setStaffInviteOpen(false);
  }, [open]);

  if (!user) {
    return null;
  }

  // 0-persona users get a "Set up your profile" pill that opens the
  // dropdown straight into the Add a profile section. This gives them
  // a persistent entry into the staff-invite + substitute-register
  // flows from any page in the (app) onboarding allowlist, not just
  // /getting-started.
  const active = user.activePersona;
  const ActiveIcon = active ? TYPE_ICON[active.type] : null;
  const hasAnyPersona = user.personas.length > 0;

  // "Add a profile" entries are the addable types the user doesn't
  // already hold. A user with STAFF + PARENT sees only Substitute in
  // the add section; a user with everything sees no add section at all
  // and the switcher falls back to plain persona switching. A
  // 0-persona user sees the full ADDABLE_TYPES list.
  const activeTypes = new Set(user.personas.map((p) => p.type));
  const addOptions = ADDABLE_TYPES.filter((t) => !activeTypes.has(t));

  async function handleSelect(persona: UserPersona) {
    if (!user) return;
    if (persona.id === user.activePersona?.id) {
      setOpen(false);
      return;
    }
    setSwitching(persona.id);
    try {
      const next = await apiFetch<MeResponse>('/api/v1/auth/switch-persona', {
        method: 'POST',
        body: JSON.stringify({ personaId: persona.id }),
      });
      setUser(meToAuthUser(next));
      try {
        window.localStorage.setItem('activePersonaId', persona.id);
      } catch {
        // Ignore storage failures — the switch already happened.
      }
      // Drop every cached query so the launchpad + per-app pages
      // refetch under the new persona's permission scope. Apps that
      // surface STAFF-only data (e.g. gradebook) must not render
      // PARENT-fetched rows after a switch.
      await queryClient.invalidateQueries();
    } catch {
      // Soft-fail: the dropdown closes but the active persona stays
      // unchanged. The user can retry.
    } finally {
      setSwitching(null);
      setOpen(false);
    }
  }

  function handleAddOption(type: AddablePersonaType) {
    if (type === 'SUBSTITUTE') {
      setOpen(false);
      router.push('/substitute/register');
      return;
    }
    if (type === 'STAFF') {
      setStaffInviteOpen(true);
    }
  }

  // The whole sequence runs while the dropdown is open so the user
  // sees inline progress / error feedback without a page navigation.
  async function acceptStaffInvite(code: string): Promise<{ personaId: string } | { error: string }> {
    const token = code.trim();
    if (!token) return { error: 'Enter the code from your invitation email.' };
    try {
      const summary = await apiFetch<InvitationSummary>(
        '/api/v1/invitations/' + encodeURIComponent(token),
      );
      if (summary.type !== 'EMPLOYEE') {
        return {
          error:
            "That code isn't an employee invitation. Use Getting Started → I received an invitation.",
        };
      }
      const result = await apiFetch<AcceptInvitationResult>(
        '/api/v1/invitations/' + encodeURIComponent(token) + '/accept',
        { method: 'POST' },
      );
      if (!result.personaId) {
        return {
          error: 'Invitation accepted but no persona was returned. Try refreshing the page.',
        };
      }
      return { personaId: result.personaId };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return { error: "We couldn't find that invitation. Check the code and try again." };
      }
      if (err instanceof ApiError && err.status === 410) {
        return { error: 'That invitation has expired. Ask your school admin to resend it.' };
      }
      return { error: 'Something went wrong validating your code. Please try again.' };
    }
  }

  async function switchToPersonaId(personaId: string) {
    if (!user) return;
    const next = await apiFetch<MeResponse>('/api/v1/auth/switch-persona', {
      method: 'POST',
      body: JSON.stringify({ personaId }),
    });
    setUser(meToAuthUser(next));
    try {
      window.localStorage.setItem('activePersonaId', personaId);
    } catch {
      // Ignore.
    }
    await queryClient.invalidateQueries();
  }

  const groupedPersonas: Array<[PersonaType, UserPersona[]]> = TYPE_ORDER.map(
    (t): [PersonaType, UserPersona[]] => [t, user.personas.filter((p) => p.type === t)],
  ).filter(([, list]) => list.length > 0);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          'flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 ' +
          'text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50'
        }
      >
        {active && ActiveIcon ? (
          <>
            <ActiveIcon className="h-4 w-4 text-gray-600" />
            <span className="hidden truncate sm:inline">{truncate(active.label, 28)}</span>
            <span className="inline sm:hidden">{TYPE_LABEL[active.type]}</span>
          </>
        ) : (
          <span className="truncate">Set up your profile</span>
        )}
        <ChevronDownIcon className="h-4 w-4 text-gray-500" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Persona switcher"
          className="absolute right-0 top-11 z-40 w-80 overflow-hidden rounded-card border border-gray-200 bg-white shadow-elevated"
        >
          {/* Active personas — switch list. Skipped entirely when the
              user has 0 personas so the dropdown opens straight into
              Add a profile. */}
          {hasAnyPersona &&
            groupedPersonas.map(([type, list], i) => (
              <div key={type}>
                {i > 0 && <div className="border-t border-gray-100" />}
                <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  {TYPE_LABEL[type]}
                </div>
                {list.map((p) => {
                  const Icon = TYPE_ICON[p.type];
                  const isActive = p.id === active?.id;
                  const isSwitching = switching === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitem"
                      aria-current={isActive}
                      disabled={isSwitching}
                      onClick={() => void handleSelect(p)}
                      className={
                        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm ' +
                        (isActive ? 'bg-gray-50 text-gray-900' : 'text-gray-700 hover:bg-gray-50') +
                        (isSwitching ? ' opacity-60' : '')
                      }
                    >
                      <Icon className="h-4 w-4 text-gray-600" />
                      <span className="flex-1 truncate">{p.label}</span>
                      {isActive && <CheckIcon className="h-4 w-4 text-campus-700" />}
                    </button>
                  );
                })}
              </div>
            ))}

          {/* Add a profile — only render when there's at least one
              addable type the user doesn't already hold. */}
          {addOptions.length > 0 && (
            <div>
              {hasAnyPersona && <div className="border-t border-gray-200" />}
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Add a profile
              </div>
              {addOptions.map((type) => {
                const Icon = TYPE_ICON[type];
                const copy = ADD_OPTION_COPY[type];
                if (type === 'STAFF' && staffInviteOpen) {
                  return (
                    <StaffInviteForm
                      key={type}
                      onCancel={() => setStaffInviteOpen(false)}
                      onSubmit={async (code) => {
                        const r = await acceptStaffInvite(code);
                        if ('error' in r) return r;
                        await switchToPersonaId(r.personaId);
                        setOpen(false);
                        setStaffInviteOpen(false);
                        return null;
                      }}
                    />
                  );
                }
                return (
                  <button
                    key={type}
                    type="button"
                    role="menuitem"
                    onClick={() => handleAddOption(type)}
                    className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Icon className="mt-0.5 h-4 w-4 text-gray-600" />
                    <span className="flex-1">
                      <span className="block">{copy.label}</span>
                      <span className="block text-xs text-gray-500">{copy.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline form rendered in place of the "Staff" option when the user
 * clicks it. Submits the 8-char code, calls back with a typed result
 * — null on success (parent closes the dropdown), { error } on a
 * validation / network failure (the form shows it inline and stays
 * open so the user can correct + retry).
 */
function StaffInviteForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (code: string) => Promise<{ error: string } | null>;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onSubmit(code);
    if (result && 'error' in result) {
      setError(result.error);
      setBusy(false);
    }
    // On success the parent unmounts the dropdown; no setBusy(false).
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 px-3 pb-3 pt-1">
      <label htmlFor="staff-invite-code" className="sr-only">
        Employee invitation code
      </label>
      <input
        id="staff-invite-code"
        type="text"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          if (error) setError(null);
        }}
        placeholder="Invitation code"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        aria-invalid={!!error}
        className={
          'block w-full rounded-md border bg-white px-3 py-2 font-mono text-sm uppercase tracking-wider text-gray-900 ' +
          'shadow-sm placeholder:font-mono placeholder:text-gray-400 ' +
          'focus:outline-none focus:ring-2 focus:ring-campus-500 focus:border-campus-500 ' +
          (error ? 'border-red-300' : 'border-gray-300')
        }
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center rounded-md bg-campus-700 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-campus-600 disabled:opacity-60"
        >
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}
