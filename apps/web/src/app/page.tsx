'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth-store';
import { PageLoader } from '@/components/ui/LoadingSpinner';

export default function HomePage() {
  const status = useAuthStore((s) => s.status);
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
    else if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  return <PageLoader label="Loading CampusOS…" />;
}
