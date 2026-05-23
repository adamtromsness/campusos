'use client';

import Link from 'next/link';
import { useAuthStore } from '@/lib/auth-store';

/**
 * Getting Started — Section 2 / Step 3 of the persona-registration
 * design. A fresh account lands here with zero personas; the page
 * disappears once any action (link a child / accept an invitation /
 * register as a substitute) activates a persona.
 *
 * This is the minimal placeholder shipped with the registration
 * endpoint. The richer action-card layout from the design doc
 * (Add children, I received an invitation, Substitute teach, Find a
 * school) lands in the next step.
 */
export default function GettingStartedPage() {
  const user = useAuthStore((s) => s.user);
  const greeting = user?.firstName ? `Welcome, ${user.firstName}` : 'Welcome to CampusOS';

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center px-4 pt-16 pb-16 text-center sm:pt-24">
      <h1 className="text-3xl font-semibold tracking-tight text-campus-700 sm:text-4xl">
        {greeting}
      </h1>
      <p className="mt-3 text-sm text-gray-600">
        Your account is ready. Pick what brings you here so we can set up the right experience.
      </p>

      <div className="mt-10 grid w-full gap-3">
        <Link
          href="/family"
          className="group flex items-center justify-between rounded-card border border-gray-200 bg-white px-5 py-4 text-left shadow-sm transition-colors hover:border-campus-300 hover:bg-campus-50/50"
        >
          <div>
            <p className="text-sm font-semibold text-gray-900">I have children</p>
            <p className="mt-0.5 text-xs text-gray-500">
              Add them to your family and link their CampusOS accounts.
            </p>
          </div>
          <span className="text-campus-600 transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </Link>

        <Link
          href="/invitations"
          className="group flex items-center justify-between rounded-card border border-gray-200 bg-white px-5 py-4 text-left shadow-sm transition-colors hover:border-campus-300 hover:bg-campus-50/50"
        >
          <div>
            <p className="text-sm font-semibold text-gray-900">I received an invitation</p>
            <p className="mt-0.5 text-xs text-gray-500">
              Accept an offer from a school or another parent.
            </p>
          </div>
          <span className="text-campus-600 transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </Link>

        <Link
          href="/find-schools"
          className="group flex items-center justify-between rounded-card border border-gray-200 bg-white px-5 py-4 text-left shadow-sm transition-colors hover:border-campus-300 hover:bg-campus-50/50"
        >
          <div>
            <p className="text-sm font-semibold text-gray-900">I&rsquo;m looking for a school</p>
            <p className="mt-0.5 text-xs text-gray-500">
              Browse public school listings and submit an application.
            </p>
          </div>
          <span className="text-campus-600 transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </Link>
      </div>

      <p className="mt-8 text-xs text-gray-400">
        Once you complete one of these, your apps will appear in the launchpad.
      </p>
    </div>
  );
}
