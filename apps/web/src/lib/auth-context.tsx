'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch, attemptSilentLogin, setAccessToken, setOnUnauthenticated } from './api-client';
import { useAuthStore, type AuthUser } from './auth-store';

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
        const me = await apiFetch<AuthUser>('/api/v1/auth/me');
        setAuth(token, me);
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
    const me = await apiFetch<AuthUser>('/api/v1/auth/me');
    setAuth(res.accessToken, me);
    router.replace('/dashboard');
  };

  const logout = async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // best-effort — clear local state regardless
    }
    setAccessToken(null);
    setUnauthenticated();
    router.replace('/login');
  };

  const refreshUser = async () => {
    const me = await apiFetch<AuthUser>('/api/v1/auth/me');
    setUser(me);
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
