'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  attemptSilentLogin,
  setAccessToken,
  setOnUnauthenticated,
} from './api-client';
import { useAuthStore, type ActivePersona, type AuthUser, type UserPersona } from './auth-store';

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

function meToAuthUser(me: MeResponse): AuthUser {
  return {
    ...me.user,
    activePersona: me.activePersona,
    personas: me.personas,
    permissions: me.permissions,
  };
}

/**
 * /auth/me with the persisted persona selection. The backend returns
 * 404 when X-Active-Persona points at a persona the caller no longer
 * owns (e.g. removed since last session); on that signal we drop the
 * stale localStorage entry and retry without the header so the user
 * still loads — bound to the default sorted persona.
 */
async function fetchMe(): Promise<MeResponse> {
  let storedPersonaId: string | null = null;
  if (typeof window !== 'undefined') {
    try {
      storedPersonaId = window.localStorage.getItem('activePersonaId');
    } catch {
      storedPersonaId = null;
    }
  }
  const init: RequestInit = storedPersonaId
    ? { headers: { 'X-Active-Persona': storedPersonaId } }
    : {};
  try {
    return await apiFetch<MeResponse>('/api/v1/auth/me', init);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && storedPersonaId) {
      try {
        window.localStorage.removeItem('activePersonaId');
      } catch {
        // ignore
      }
      return apiFetch<MeResponse>('/api/v1/auth/me');
    }
    throw e;
  }
}

interface AuthContextValue {
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const setAuth = useAuthStore((s) => s.setAuth);
  const setUnauthenticated = useAuthStore((s) => s.setUnauthenticated);
  const setUser = useAuthStore((s) => s.setUser);
  const bootstrapped = useRef(false);

  useEffect(() => {
    setOnUnauthenticated(() => {
      setUnauthenticated();
      if (pathname && pathname !== '/login') {
        router.replace('/login');
      }
    });
  }, [pathname, router, setUnauthenticated]);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    (async () => {
      const token = await attemptSilentLogin();
      if (!token) {
        setUnauthenticated();
        return;
      }
      setAccessToken(token);
      try {
        const me = await fetchMe();
        setAuth(token, meToAuthUser(me));
      } catch {
        setUnauthenticated();
      }
    })();
  }, [setAuth, setUnauthenticated]);

  const login = async (email: string) => {
    const res = await apiFetch<{ accessToken: string }>('/api/v1/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    setAccessToken(res.accessToken);
    const me = await fetchMe();
    setAuth(res.accessToken, meToAuthUser(me));
    router.replace('/dashboard');
  };

  const logout = async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // best-effort — clear local state regardless
    }
    setAccessToken(null);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem('activePersonaId');
      } catch {
        // ignore
      }
    }
    setUnauthenticated();
    router.replace('/login');
  };

  const refreshUser = async () => {
    const me = await fetchMe();
    setUser(meToAuthUser(me));
  };

  return (
    <AuthContext.Provider value={{ login, logout, refreshUser }}>{children}</AuthContext.Provider>
  );
}

export function useAuthActions(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthActions must be used inside AuthProvider');
  return ctx;
}
