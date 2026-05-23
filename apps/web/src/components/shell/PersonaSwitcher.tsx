'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
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
 * persona. Renders nothing when the user has zero personas (the
 * Getting Started state); renders a non-interactive pill when the
 * user has exactly one persona; and renders a clickable pill with a
 * grouped dropdown when there are two or more.
 *
 * On switch the component POSTs to /auth/switch-persona, drops the
 * fresh MeResponse into the Zustand auth store, and invalidates
 * every React Query cache so the launchpad + sidebar + per-app data
 * refetch under the new persona's permission set.
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
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on click-outside or Escape. Two listeners share one cleanup.
  useEffect(() => {
    if (!open) return;
    function handleClickAway(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickAway);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickAway);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  if (!user || !user.activePersona || user.personas.length === 0) {
    return null;
  }

  const active = user.activePersona;
  const ActiveIcon = TYPE_ICON[active.type];
  const onlyOne = user.personas.length === 1;

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
      // Persist the choice — useful when the page reloads or the
      // user opens a fresh tab; AuthContext can rehydrate the
      // persona via the X-Active-Persona header on the next
      // /auth/me. Best-effort, swallow QuotaExceededError etc.
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

  const groupedPersonas: Array<[PersonaType, UserPersona[]]> = TYPE_ORDER.map(
    (t): [PersonaType, UserPersona[]] => [t, user.personas.filter((p) => p.type === t)],
  ).filter(([, list]) => list.length > 0);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => {
          if (!onlyOne) setOpen((v) => !v);
        }}
        aria-haspopup={onlyOne ? undefined : 'listbox'}
        aria-expanded={onlyOne ? undefined : open}
        disabled={onlyOne}
        className={
          'flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 ' +
          'text-sm font-medium text-gray-800 transition-colors ' +
          (onlyOne ? 'cursor-default' : 'hover:bg-gray-50')
        }
      >
        <ActiveIcon className="h-4 w-4 text-gray-600" />
        <span className="hidden truncate sm:inline">{truncate(active.label, 28)}</span>
        <span className="inline sm:hidden">{TYPE_LABEL[active.type]}</span>
        {!onlyOne && <ChevronDownIcon className="h-4 w-4 text-gray-500" />}
      </button>

      {open && !onlyOne && (
        <div
          role="listbox"
          aria-label="Switch persona"
          className="absolute right-0 top-11 z-40 w-72 overflow-hidden rounded-card border border-gray-200 bg-white shadow-elevated"
        >
          {groupedPersonas.map(([type, list], i) => (
            <div key={type}>
              {i > 0 && <div className="border-t border-gray-100" />}
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {TYPE_LABEL[type]}
              </div>
              {list.map((p) => {
                const Icon = TYPE_ICON[p.type];
                const isActive = p.id === active.id;
                const isSwitching = switching === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
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
        </div>
      )}
    </div>
  );
}
