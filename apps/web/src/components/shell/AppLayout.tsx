'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth-store';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CloseIcon } from './icons';
import { EmergencyAlertBanner } from '@/components/notifications/EmergencyAlertBanner';

const GETTING_STARTED_PATH = '/getting-started';

export function AppLayout({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  // Persona-presence routing — Section 2 Step 3 of the
  // persona-registration design. A 0-persona user lands on
  // /getting-started; a user with one or more personas should never
  // see the onboarding page (it would be a dead end). Same logic
  // both directions so back-button + page reload + persona switcher
  // all stay coherent.
  useEffect(() => {
    if (status !== 'authenticated' || !user) return;
    const onGettingStarted = pathname === GETTING_STARTED_PATH;
    if (user.personas.length === 0 && !onGettingStarted) {
      router.replace(GETTING_STARTED_PATH);
    } else if (user.personas.length > 0 && onGettingStarted) {
      router.replace('/dashboard');
    }
  }, [status, user, pathname, router]);

  if (status === 'loading' || !user) {
    return <PageLoader label="Loading CampusOS…" />;
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <div className="hidden lg:block">
        <Sidebar user={user} />
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="absolute inset-0 bg-campus-900/40" onClick={() => setDrawerOpen(false)} />
          <div className="relative flex">
            <Sidebar user={user} onNavigate={() => setDrawerOpen(false)} />
            <button
              type="button"
              className="absolute -right-12 top-3 rounded-full bg-white p-2 text-gray-700 shadow-card"
              aria-label="Close navigation"
              onClick={() => setDrawerOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col">
        <TopBar user={user} onOpenMenu={() => setDrawerOpen(true)} />
        <EmergencyAlertBanner />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
