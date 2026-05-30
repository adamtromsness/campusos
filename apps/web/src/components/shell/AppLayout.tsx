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

/**
 * Routes a 0-persona user is allowed to reach from /getting-started.
 * The unauthenticated public routes /find-schools and /invitations live
 * outside the (app) group so they aren't subject to AppLayout's
 * persona-presence bounce; this list covers the (app)-group onboarding
 * destinations that the Getting Started cards link to. Matching is
 * prefix-based so nested routes (e.g. /family/add-child/step-2) stay
 * reachable.
 *
 * /profile and /settings are also allowlisted because the TopBar
 * user menu surfaces them to every authenticated user including
 * 0-persona accounts — bouncing back to /getting-started would make
 * the menu items look broken even though the API endpoints accept
 * the request.
 */
const ONBOARDING_ALLOWED_PREFIXES = ['/family', '/substitute', '/profile', '/settings'];

function isOnboardingRoute(pathname: string): boolean {
  if (pathname === GETTING_STARTED_PATH) return true;
  return ONBOARDING_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

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
  //
  // Exception: a 0-persona user must be able to reach the (app)-group
  // onboarding destinations linked from /getting-started (Add a child,
  // Substitute register, and their sub-pages). Without this carve-out
  // the launchpad cards appear inert — they navigate, then this effect
  // immediately bounces the user back to /getting-started.
  useEffect(() => {
    if (status !== 'authenticated' || !user) return;
    const onGettingStarted = pathname === GETTING_STARTED_PATH;
    if (user.personas.length === 0 && !isOnboardingRoute(pathname)) {
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
