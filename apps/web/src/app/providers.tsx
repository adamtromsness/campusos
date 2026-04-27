'use client';

import { type ReactNode } from 'react';
import { ReactQueryProvider } from '@/lib/query-client';
import { AuthProvider } from '@/lib/auth-context';
import { ToastProvider } from '@/components/ui/Toast';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ReactQueryProvider>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </ReactQueryProvider>
  );
}
