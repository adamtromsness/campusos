import { type ReactNode } from 'react';
import { AppLayout } from '@/components/shell/AppLayout';

export default function AppRouteLayout({ children }: { children: ReactNode }) {
  return <AppLayout>{children}</AppLayout>;
}
