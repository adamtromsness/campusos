'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

export default function PaymentsAdvancedHub() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const canFinAid = !!user && hasAnyPermission(user, ['fin-002:read', 'fin-002:write']);
  const isParent = !!user && user.personType === 'GUARDIAN';

  if (!user) return null;
  if (!isAdmin && !canFinAid && !isParent) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Payments — Advanced" />
        <EmptyState title="Access required" />
      </div>
    );
  }

  const tiles: Array<{ href: string; title: string; description: string; show: boolean }> = [
    {
      href: '/payments/financial-aid',
      title: 'Financial Aid',
      description: 'Programmes, parent applications, awards. Atomic fund decrement on approval.',
      show: canFinAid,
    },
    {
      href: '/payments/fees-advanced',
      title: 'Fees & auto-invoicing',
      description: 'Auto-invoice rules, sibling + early-payment discounts, generation runs.',
      show: isAdmin,
    },
    {
      href: '/payments/lunch',
      title: 'Lunch accounts',
      description: isAdmin
        ? 'Per-student balances + low-balance dashboard + IMMUTABLE transfers.'
        : 'Top up your child’s lunch account and view meal charges.',
      show: isAdmin || isParent,
    },
    {
      href: '/payments/operations',
      title: 'Billing operations',
      description: 'Credit notes, payment reversals (both IMMUTABLE), late fee policy + scan.',
      show: isAdmin,
    },
    {
      href: '/billing',
      title: 'Billing dashboard',
      description: 'Invoices, payments, refunds, family accounts (Cycle 6 surface).',
      show: true,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Family billing, financial aid, lunch accounts, and operational tooling."
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {tiles
          .filter((t) => t.show)
          .map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="block rounded-md border border-gray-200 bg-white p-4 hover:border-campus-300 hover:shadow"
            >
              <p className="text-base font-semibold text-gray-900">{t.title}</p>
              <p className="mt-1 text-sm text-gray-600">{t.description}</p>
            </Link>
          ))}
      </div>
    </div>
  );
}
