import { create } from 'zustand';

/**
 * Persona vocabulary returned by /auth/me and /auth/switch-persona.
 * Personas are derived from real actions (LINKED child → PARENT,
 * hr_employees row → STAFF, etc.) — see the persona registration design
 * doc. Replaces the legacy iam_person.person_type values surfaced as
 * `personType` on AuthUser.
 *
 * Mapping from legacy personType (where applicable):
 *   STAFF      → STAFF
 *   STUDENT    → STUDENT
 *   GUARDIAN   → PARENT
 *   SUBSTITUTE → SUBSTITUTE
 *   ALUMNI     → ALUMNI
 *   VOLUNTEER  → (no equivalent — use COMMUNITY)
 */
export type PersonaType = 'PARENT' | 'STUDENT' | 'STAFF' | 'SUBSTITUTE' | 'ALUMNI' | 'COMMUNITY';

export interface ActivePersona {
  id: string;
  type: PersonaType;
  label: string;
  schoolId: string | null;
  schoolName: string | null;
}

export interface UserPersona {
  id: string;
  type: PersonaType;
  label: string;
  schoolId: string | null;
}

export interface AuthUser {
  id: string;
  personId: string;
  email: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
  activePersona: ActivePersona | null;
  personas: UserPersona[];
  permissions: string[];
}

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: AuthUser | null;
  setAuth: (token: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  setUnauthenticated: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  accessToken: null,
  user: null,
  setAuth: (token, user) => set({ status: 'authenticated', accessToken: token, user }),
  setUser: (user) => set({ user }),
  setUnauthenticated: () => set({ status: 'unauthenticated', accessToken: null, user: null }),
}));

export function hasPermission(user: AuthUser | null, code: string): boolean {
  return !!user && user.permissions.includes(code);
}

export function hasAnyPermission(user: AuthUser | null, codes: string[]): boolean {
  if (!user) return false;
  for (const c of codes) if (user.permissions.includes(c)) return true;
  return false;
}
