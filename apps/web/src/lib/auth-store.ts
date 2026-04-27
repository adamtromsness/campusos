import { create } from 'zustand';

export type PersonType =
  | 'STAFF'
  | 'STUDENT'
  | 'GUARDIAN'
  | 'VOLUNTEER'
  | 'SUBSTITUTE'
  | 'ALUMNI'
  | 'EXTERNAL';

export interface AuthUser {
  id: string;
  personId: string;
  email: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
  personType: PersonType | null;
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
  setAuth: (token, user) =>
    set({ status: 'authenticated', accessToken: token, user }),
  setUser: (user) => set({ user }),
  setUnauthenticated: () =>
    set({ status: 'unauthenticated', accessToken: null, user: null }),
}));

export function hasPermission(user: AuthUser | null, code: string): boolean {
  return !!user && user.permissions.includes(code);
}

export function hasAnyPermission(
  user: AuthUser | null,
  codes: string[],
): boolean {
  if (!user) return false;
  for (const c of codes) if (user.permissions.includes(c)) return true;
  return false;
}
