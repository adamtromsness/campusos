'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFamilyAccounts,
  useFeeSchedules,
  useGenerateFromSchedule,
  useInvoices,
} from '@/hooks/use-billing';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  INVOICE_STATUSES,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_PILL,
  formatCurrency,
  formatDateOnly,
} from '@/lib/billing-format';
import type { InvoiceStatus } from '@/lib/types';

export default function BillingInvoicesPage() {
  const user = useAuthStore((s) => s.user);
  const isWriter = !!user && hasAnyPermission(user, ['fin-001:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'ALL'>('ALL');
  const [accountFilter, setAccountFilter] = useState<string>('');
  const [showGenerate, setShowGenerate] = useState(false);

  const accounts = useFamilyAccounts(!!user);
  const invoices = useInvoices(
    {
      familyAccountId: accountFilter || undefined,
      status: statusFilter === 'ALL' ? undefined : statusFilter,
    },
    !!user,
  );

  if (!user) return null;
  if (!isWriter) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing — Invoices" description="Billing access required." />
        <EmptyState title="Access required" />
      </div>
    );
  }

  const rows = invoices.data ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Invoices"
        description="Family invoices for tuition, fees, and one-time charges."
        actions={
          isAdmin && (
            <button
              type="button"
              onClick={() => setShowGenerate(true)}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              Generate from schedule
            </button>
          )
        }
      />

      <BillingTabs active="invoices" />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <FilterChip
          label="All"
          active={statusFilter === 'ALL'}
          onClick={() => setStatusFilter('ALL')}
        />
        {INVOICE_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={INVOICE_STATUS_LABELS[s]}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          />
        ))}
        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="ml-auto rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          <option value="">All families</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.accountNumber} — {a.accountHolderName}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {invoices.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16">
            <EmptyState
              title="No invoices match"
              description={
                statusFilter !== 'ALL' || accountFilter
                  ? 'Try clearing the filters.'
                  : 'Generate an invoice from a fee schedule to get started.'
              }
            />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Invoice</th>
                <th className="px-4 py-2">Family</th>
                <th className="px-4 py-2">Total</th>
                <th className="px-4 py-2">Paid</th>
                <th className="px-4 py-2">Balance</th>
                <th className="px-4 py-2">Due</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/billing/invoices/${inv.id}`}
                      className="font-medium text-campus-700 hover:text-campus-900"
                    >
                      {inv.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {inv.familyAccountNumber} · {inv.familyAccountHolderName}
                  </td>
                  <td className="px-4 py-2 font-semibold text-gray-900">
                    {formatCurrency(inv.totalAmount)}
                  </td>
                  <td className="px-4 py-2 text-emerald-700">{formatCurrency(inv.amountPaid)}</td>
                  <td className="px-4 py-2 text-rose-700">{formatCurrency(inv.balanceDue)}</td>
                  <td className="px-4 py-2 text-gray-600">{formatDateOnly(inv.dueDate)}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        INVOICE_STATUS_PILL[inv.status]
                      }`}
                    >
                      {INVOICE_STATUS_LABELS[inv.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showGenerate && <GenerateModal onClose={() => setShowGenerate(false)} />}
    </div>
  );
}

function BillingTabs({ active }: { active: 'accounts' | 'invoices' | 'payments' | 'fees' }) {
  const items: { key: typeof active; label: string; href: string }[] = [
    { key: 'accounts', label: 'Accounts', href: '/billing/accounts' },
    { key: 'invoices', label: 'Invoices', href: '/billing/invoices' },
    { key: 'payments', label: 'Payments', href: '/billing/payments' },
    { key: 'fees', label: 'Fees', href: '/billing/fees' },
  ];
  return (
    <nav className="mt-2 flex gap-3 text-sm">
      {items.map((it, i) => (
        <span key={it.key} className="flex items-center gap-3">
          {it.key === active ? (
            <span className="font-medium text-campus-700">{it.label}</span>
          ) : (
            <Link href={it.href} className="text-gray-500 hover:text-campus-700">
              {it.label}
            </Link>
          )}
          {i < items.length - 1 && <span className="text-gray-300">·</span>}
        </span>
      ))}
    </nav>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-campus-700 text-white'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      }`}
    >
      {label}
    </button>
  );
}

function GenerateModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const schedules = useFeeSchedules();
  const generate = useGenerateFromSchedule();
  const [feeScheduleId, setFeeScheduleId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const activeSchedules = (schedules.data ?? []).filter((s) => s.isActive);

  async function onSubmit() {
    if (!feeScheduleId) {
      toast('Pick a fee schedule', 'error');
      return;
    }
    try {
      const res = await generate.mutateAsync({
        feeScheduleId,
        dueDate: dueDate || undefined,
      });
      toast(
        `Generated ${res.created} invoice${res.created === 1 ? '' : 's'} (${res.skipped} skipped).`,
        'success',
      );
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not generate invoices', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Generate invoices from schedule"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={generate.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={generate.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {generate.isPending ? 'Generating…' : 'Generate'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          One DRAFT invoice per linked family will be created. Families that already have a
          non-cancelled invoice attributed to this schedule are skipped.
        </p>
        <label className="block text-sm">
          <span className="text-gray-700">
            Fee schedule <span className="text-rose-600">*</span>
          </span>
          <select
            value={feeScheduleId}
            onChange={(e) => setFeeScheduleId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="">Select…</option>
            {activeSchedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {formatCurrency(s.amount)}
                {s.gradeLevel ? ` (Grade ${s.gradeLevel})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Due date (optional)</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
      </div>
    </Modal>
  );
}
