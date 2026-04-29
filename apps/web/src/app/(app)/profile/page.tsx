'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import {
  AccountTab,
  DemographicsTab,
  EmergencyContactTab,
  EmploymentTab,
  HouseholdTab,
  PersonalInfoTab,
} from '@/components/profile/ProfileTabs';
import { useMyProfile } from '@/hooks/use-profile';
import { profileTabs, type ProfileTabKey } from '@/lib/profile-format';

export default function MyProfilePage() {
  const profile = useMyProfile();
  const [tab, setTab] = useState<ProfileTabKey>('personal');

  if (profile.isLoading) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (profile.isError || !profile.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState
          title="Couldn’t load your profile"
          description="Try refreshing. If the problem persists, contact support."
        />
      </div>
    );
  }

  const p = profile.data;
  const tabs = profileTabs(p.personType);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My Profile"
        description={
          [p.preferredName ?? p.firstName, p.lastName, p.personType?.toLowerCase()]
            .filter(Boolean)
            .join(' · ') || ''
        }
      />

      <div className="mt-4 border-b border-gray-200">
        <nav className="flex flex-wrap gap-1">
          {tabs
            .filter((t) => t.visible)
            .map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'rounded-t-md px-3 py-2 text-sm font-medium transition-colors',
                  tab === t.key
                    ? 'border-b-2 border-campus-600 text-campus-700'
                    : 'text-gray-500 hover:text-campus-700',
                )}
              >
                {t.label}
              </button>
            ))}
        </nav>
      </div>

      <div className="mt-6">
        {tab === 'personal' && <PersonalInfoTab profile={p} isAdminView={false} />}
        {tab === 'household' && <HouseholdTab profile={p} isAdminView={false} />}
        {tab === 'emergency' && <EmergencyContactTab profile={p} isAdminView={false} />}
        {tab === 'demographics' && p.personType === 'STUDENT' && (
          <DemographicsTab profile={p} isAdminView={false} />
        )}
        {tab === 'employment' && p.personType === 'GUARDIAN' && (
          <EmploymentTab profile={p} isAdminView={false} />
        )}
        {tab === 'account' && <AccountTab profile={p} isAdminView={false} />}
      </div>
    </div>
  );
}
