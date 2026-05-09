'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  EXPENSE_STATUS_LABEL,
  EXPENSE_STATUS_PILL,
  formatCurrency,
  formatDate,
  formatDateTime,
} from '@/lib/hr-development-format';
import {
  useCreateExpenseClaim,
  useDecideExpenseClaim,
  useExpenseClaims,
  useMarkExpensePaid,
} from '@/hooks/use-hr-development';
import type { ExpenseClaimDto, ExpenseStatus } from '@/lib/types';

/**
 * Expense claims surface. Self-submission is gated on hr-012:read
 * (every staff persona). Admin decide / mark-paid is gated on
 * hr-013:write — held only by School Admin / Platform Admin via
 * everyFunction. The page renders both surfaces in one route so
 * teachers see their own queue + can submit; admins see the
 * approval queue with decision controls.
 */
export default function ExpenseClaimsPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['hr-012:read', 'hr-012:write', 'sch-001:admin']);
  const canSubmit = hasAnyPermission(user, ['hr-012:write', 'sch-001:admin']);
  const isAdmin = hasAnyPermission(user, ['hr-013:write', 'hr-013:admin', 'sch-001:admin']);
  const [tab, setTab] = useState<'mine' | 'queue'>(isAdmin ? 'queue' : 'mine');
  const [showCreate, setShowCreate] = useState(false);

  if (!canRead) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Expense claims</h1>
        <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          Expense claims are restricted to school employees with HR-012.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Expense claims</h1>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/hr/training">
            Training
          </Link>
          <Link className="text-sky-700 hover:underline" href="/hr/appraisals">
            Appraisals
          </Link>
          {canSubmit ? (
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowCreate(true)}
            >
              Submit claim
            </button>
          ) : null}
        </div>
      </div>

      {isAdmin ? (
        <div className="flex gap-2 border-b border-slate-200">
          {(['queue', 'mine'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === k
                  ? 'border-sky-600 font-semibold text-sky-700'
                  : 'border-transparent text-slate-600 hover:text-slate-800'
              }`}
            >
              {k === 'queue' ? 'Approval queue' : 'My claims'}
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'queue' && isAdmin ? <QueueTab /> : <MineTab />}

      {showCreate ? <CreateClaimModal onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

function MineTab() {
  const claims = useExpenseClaims({ mine: true });
  return (
    <ClaimsTable
      claims={claims.data ?? []}
      mode="mine"
      emptyText="You haven't submitted any expense claims yet."
    />
  );
}

function QueueTab() {
  const [statusFilter, setStatusFilter] = useState<ExpenseStatus | ''>('SUBMITTED');
  const claims = useExpenseClaims(statusFilter ? { status: statusFilter } : undefined);
  return (
    <section className="rounded border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Approval queue</h2>
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter((e.target.value as ExpenseStatus) || '')}
        >
          <option value="">All statuses</option>
          {(['SUBMITTED', 'APPROVED', 'REJECTED', 'PAID'] as ExpenseStatus[]).map((s) => (
            <option key={s} value={s}>
              {EXPENSE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <ClaimsTable
        claims={claims.data ?? []}
        mode="admin"
        emptyText="No claims match the filter."
      />
    </section>
  );
}

function ClaimsTable({
  claims,
  mode,
  emptyText,
}: {
  claims: ExpenseClaimDto[];
  mode: 'mine' | 'admin';
  emptyText: string;
}) {
  return (
    <table className="mt-3 min-w-full text-sm">
      <thead className="text-xs uppercase text-slate-500">
        <tr className="text-left">
          <th className="py-2">Title</th>
          {mode === 'admin' ? <th>Employee</th> : null}
          <th>Incurred</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Decided</th>
          <th></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {claims.map((c) => (
          <ClaimRow key={c.id} claim={c} mode={mode} />
        ))}
        {claims.length === 0 ? (
          <tr>
            <td colSpan={mode === 'admin' ? 7 : 6} className="py-3 text-slate-500">
              {emptyText}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function ClaimRow({ claim, mode }: { claim: ExpenseClaimDto; mode: 'mine' | 'admin' }) {
  const { toast } = useToast();
  const decide = useDecideExpenseClaim(claim.id);
  const markPaid = useMarkExpensePaid(claim.id);
  return (
    <tr>
      <td className="py-2">
        <div className="font-medium">{claim.claimTitle}</div>
        {claim.description ? (
          <div className="text-xs text-slate-500">{claim.description}</div>
        ) : null}
      </td>
      {mode === 'admin' ? <td>{claim.employeeName ?? claim.employeeId.slice(0, 8)}</td> : null}
      <td>{formatDate(claim.incurredOn)}</td>
      <td>{formatCurrency(claim.totalAmount)}</td>
      <td>
        <span className={`rounded px-2 py-0.5 text-xs ${EXPENSE_STATUS_PILL[claim.status]}`}>
          {EXPENSE_STATUS_LABEL[claim.status]}
        </span>
      </td>
      <td className="text-xs text-slate-500">
        {claim.approvedByName ? (
          <div>
            <div>{claim.approvedByName}</div>
            <div>{formatDateTime(claim.approvedAt)}</div>
            {claim.rejectionReason ? (
              <div className="text-rose-700">{claim.rejectionReason}</div>
            ) : null}
          </div>
        ) : (
          '—'
        )}
      </td>
      <td className="space-x-2 text-right text-xs">
        {mode === 'admin' && claim.status === 'SUBMITTED' ? (
          <>
            <button
              className="text-emerald-700 hover:underline"
              onClick={async () => {
                if (!window.confirm('Approve this claim?')) return;
                try {
                  await decide.mutateAsync({ decision: 'APPROVED' });
                  toast('Claim approved');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Approve
            </button>
            <button
              className="text-rose-700 hover:underline"
              onClick={async () => {
                const reason = window.prompt('Reason for rejection (required)?');
                if (!reason || reason.trim() === '') return;
                try {
                  await decide.mutateAsync({ decision: 'REJECTED', rejectionReason: reason });
                  toast('Claim rejected');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Reject
            </button>
          </>
        ) : null}
        {mode === 'admin' && claim.status === 'APPROVED' ? (
          <button
            className="text-emerald-700 hover:underline"
            onClick={async () => {
              if (!window.confirm('Mark this claim PAID? This is the terminal status.')) return;
              try {
                await markPaid.mutateAsync();
                toast('Claim marked paid');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Mark paid
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function CreateClaimModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateExpenseClaim();
  const [claimTitle, setClaimTitle] = useState('');
  const [description, setDescription] = useState('');
  const [incurredOn, setIncurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [totalAmount, setTotalAmount] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(totalAmount);
    if (!amt || amt <= 0) {
      toast('Amount must be greater than 0', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        claimTitle,
        description: description || undefined,
        incurredOn,
        totalAmount: amt,
      });
      toast('Claim submitted');
      onClose();
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-6 shadow-lg"
        onSubmit={submit}
      >
        <h3 className="text-lg font-semibold">Submit expense claim</h3>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Title</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={claimTitle}
            onChange={(e) => setClaimTitle(e.target.value)}
            required
            minLength={2}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Description</span>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Date incurred</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={incurredOn}
            onChange={(e) => setIncurredOn(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Amount (USD)</span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            required
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="text-sm text-slate-600" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Submit
          </button>
        </div>
      </form>
    </div>
  );
}
