'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useCreditNotes,
  useIssueCreditNote,
  useLatePaymentPolicy,
  useReversals,
  useReversePayment,
  useRunLateFeesScan,
  useUpsertLatePaymentPolicy,
} from '@/hooks/use-payments-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CREDIT_CATEGORIES,
  CREDIT_CATEGORY_LABELS,
  LATE_FEE_TYPE_LABELS,
  REVERSAL_TYPE_LABELS,
  REVERSAL_TYPES,
  formatCurrency,
  formatDateTime,
} from '@/lib/billing-format';
import type { CreditCategory, LateFeeType, ReversalType } from '@/lib/types';

type Tab = 'credit-notes' | 'reversals' | 'late-fees' | 'allocations';

export default function BillingOperationsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const [tab, setTab] = useState<Tab>('credit-notes');

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Billing operations" description="Admin access required." />
        <EmptyState
          title="Admin only"
          description="The billing operations surface requires fin-001:admin."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Billing operations"
        description="Credit notes, payment reversals, late fee policy, and payment allocations. Credit notes + reversals are IMMUTABLE."
      />
      <div className="flex flex-wrap gap-2 border-b border-gray-200">
        {(['credit-notes', 'reversals', 'late-fees', 'allocations'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm font-medium ${
              tab === t
                ? 'border-b-2 border-campus-700 text-campus-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'credit-notes'
              ? 'Credit notes'
              : t === 'reversals'
                ? 'Payment reversals'
                : t === 'late-fees'
                  ? 'Late fees'
                  : 'Allocations'}
          </button>
        ))}
      </div>

      {tab === 'credit-notes' && <CreditNotesTab />}
      {tab === 'reversals' && <ReversalsTab />}
      {tab === 'late-fees' && <LateFeesTab />}
      {tab === 'allocations' && <AllocationsTab />}
    </div>
  );
}

function CreditNotesTab() {
  const list = useCreditNotes();
  const [issueOpen, setIssueOpen] = useState(false);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          IMMUTABLE per ADR-010 — corrections are made by issuing offsetting credit notes or
          refunds.
        </p>
        <button
          type="button"
          onClick={() => setIssueOpen(true)}
          className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800"
        >
          Issue credit note
        </button>
      </div>
      {list.isLoading ? (
        <LoadingSpinner />
      ) : (list.data?.length ?? 0) === 0 ? (
        <EmptyState title="No credit notes" />
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">Issued</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Invoice ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(list.data ?? []).map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-600">{formatDateTime(c.issuedAt)}</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                      {CREDIT_CATEGORY_LABELS[c.creditCategory]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-700 line-clamp-2">{c.reason}</td>
                  <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                    -{formatCurrency(c.creditAmount)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">
                    {c.invoiceId.slice(0, 8)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {issueOpen && <IssueCreditNoteModal onClose={() => setIssueOpen(false)} />}
    </section>
  );
}

function IssueCreditNoteModal({ onClose }: { onClose: () => void }) {
  const [invoiceId, setInvoiceId] = useState('');
  const [creditAmount, setCreditAmount] = useState('25');
  const [creditCategory, setCreditCategory] = useState<CreditCategory>('GOODWILL');
  const [reason, setReason] = useState('');
  const issue = useIssueCreditNote(invoiceId);
  const { toast } = useToast();

  async function submit() {
    try {
      await issue.mutateAsync({
        creditAmount: Number(creditAmount),
        creditCategory,
        reason,
      });
      toast(`Issued ${formatCurrency(Number(creditAmount))} credit note`, 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to issue credit note', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Issue credit note (IMMUTABLE)"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!invoiceId || !creditAmount || !reason || issue.isPending}
            onClick={submit}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Issue (cannot edit)
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          IMMUTABLE: this credit note cannot be edited or deleted once issued. Writes a CREDIT
          ledger entry + emits pay.credit_note.issued for the GLConsumer.
        </div>
        <Field label="Invoice ID">
          <input
            type="text"
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            placeholder="UUID"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Credit amount ($)">
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="Category">
            <select
              value={creditCategory}
              onChange={(e) => setCreditCategory(e.target.value as CreditCategory)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {CREDIT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CREDIT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Reason (required)">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Late fee waived as a goodwill gesture…"
          />
        </Field>
      </div>
    </Modal>
  );
}

function ReversalsTab() {
  const list = useReversals();
  const [reverseOpen, setReverseOpen] = useState(false);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          IMMUTABLE per ADR-010. UNIQUE(payment_id) at the schema layer enforces one reversal per
          payment.
        </p>
        <button
          type="button"
          onClick={() => setReverseOpen(true)}
          className="rounded bg-rose-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-800"
        >
          Reverse payment
        </button>
      </div>
      {list.isLoading ? (
        <LoadingSpinner />
      ) : (list.data?.length ?? 0) === 0 ? (
        <EmptyState title="No reversals" />
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">Reversed</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Bank ref</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-600">{formatDateTime(r.reversedAt)}</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                      {REVERSAL_TYPE_LABELS[r.reversalType]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-700 line-clamp-2">{r.reversalReason}</td>
                  <td className="px-3 py-2 text-gray-500">{r.bankReference ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold text-rose-700">
                    {formatCurrency(r.reversedAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reverseOpen && <ReversePaymentModal onClose={() => setReverseOpen(false)} />}
    </section>
  );
}

function ReversePaymentModal({ onClose }: { onClose: () => void }) {
  const [paymentId, setPaymentId] = useState('');
  const [reversalType, setReversalType] = useState<ReversalType>('BOUNCED_CHEQUE');
  const [reversalReason, setReversalReason] = useState('');
  const [bankReference, setBankReference] = useState('');
  const reverse = useReversePayment(paymentId);
  const { toast } = useToast();

  async function submit() {
    try {
      await reverse.mutateAsync({
        reversalType,
        reversalReason,
        bankReference: bankReference || undefined,
      });
      toast('Payment reversed (IMMUTABLE)', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to reverse payment', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Reverse payment (IMMUTABLE)"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!paymentId || !reversalReason || reverse.isPending}
            onClick={submit}
            className="rounded bg-rose-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-800 disabled:opacity-50"
          >
            Reverse (cannot undo)
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          IMMUTABLE. Flips payment to FAILED, writes an offsetting CHARGE ledger entry, reinstates
          the parent invoice, and emits pay.payment.reversed. Cannot be undone — re-record via a new
          payment row.
        </div>
        <Field label="Payment ID">
          <input
            type="text"
            value={paymentId}
            onChange={(e) => setPaymentId(e.target.value)}
            placeholder="UUID"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
          />
        </Field>
        <Field label="Reversal type">
          <select
            value={reversalType}
            onChange={(e) => setReversalType(e.target.value as ReversalType)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            {REVERSAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {REVERSAL_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason (required)">
          <textarea
            value={reversalReason}
            onChange={(e) => setReversalReason(e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Bank reference (optional)">
          <input
            type="text"
            value={bankReference}
            onChange={(e) => setBankReference(e.target.value)}
            placeholder="e.g. NSF-2026-0042"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
      </div>
    </Modal>
  );
}

function LateFeesTab() {
  const policy = useLatePaymentPolicy();
  const upsert = useUpsertLatePaymentPolicy();
  const scan = useRunLateFeesScan();
  const { toast } = useToast();

  const [feeType, setFeeType] = useState<LateFeeType>('FIXED');
  const [feeAmount, setFeeAmount] = useState('25');
  const [feePercentage, setFeePercentage] = useState('0.015');
  const [gracePeriodDays, setGracePeriodDays] = useState('7');
  const [maxLateFee, setMaxLateFee] = useState('100');
  const [isActive, setIsActive] = useState(true);
  const [initialised, setInitialised] = useState(false);

  if (policy.data && !initialised) {
    setFeeType(policy.data.feeType);
    if (policy.data.feeAmount !== null) setFeeAmount(String(policy.data.feeAmount));
    if (policy.data.feePercentage !== null) setFeePercentage(String(policy.data.feePercentage));
    setGracePeriodDays(String(policy.data.gracePeriodDays));
    if (policy.data.maxLateFeeAmount !== null) setMaxLateFee(String(policy.data.maxLateFeeAmount));
    setIsActive(policy.data.isActive);
    setInitialised(true);
  }

  async function save() {
    try {
      await upsert.mutateAsync({
        feeType,
        feeAmount: feeType === 'FIXED' ? Number(feeAmount) : undefined,
        feePercentage: feeType === 'PERCENTAGE_MONTHLY' ? Number(feePercentage) : undefined,
        gracePeriodDays: Number(gracePeriodDays),
        maxLateFeeAmount: maxLateFee ? Number(maxLateFee) : undefined,
        isActive,
      });
      toast('Late payment policy saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to save policy', 'error');
    }
  }

  async function runScan() {
    try {
      const result = await scan.mutateAsync();
      toast(
        `Scan: ${result.lateFeesApplied} late fee(s) applied (${formatCurrency(result.totalLateFeeAmount)} total) across ${result.invoicesEvaluated} invoice(s)`,
        'success',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Scan failed', 'error');
    }
  }

  if (policy.isLoading) return <LoadingSpinner />;

  return (
    <section className="space-y-4">
      <div className="rounded-md border border-gray-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-700">School late payment policy</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Fee type">
            <select
              value={feeType}
              onChange={(e) => setFeeType(e.target.value as LateFeeType)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {(['FIXED', 'PERCENTAGE_MONTHLY'] as LateFeeType[]).map((t) => (
                <option key={t} value={t}>
                  {LATE_FEE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Grace period (days)">
            <input
              type="number"
              min="0"
              value={gracePeriodDays}
              onChange={(e) => setGracePeriodDays(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </Field>
          {feeType === 'FIXED' && (
            <Field label="Fixed fee amount ($)">
              <input
                type="number"
                step="0.01"
                min="0"
                value={feeAmount}
                onChange={(e) => setFeeAmount(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </Field>
          )}
          {feeType === 'PERCENTAGE_MONTHLY' && (
            <Field label="Monthly percentage (decimal — 0.015 = 1.5%)">
              <input
                type="number"
                step="0.0001"
                min="0"
                value={feePercentage}
                onChange={(e) => setFeePercentage(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </Field>
          )}
          <Field label="Max late fee amount ($, optional)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={maxLateFee}
              onChange={(e) => setMaxLateFee(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>Active</span>
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={upsert.isPending}
            onClick={save}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Save policy
          </button>
        </div>
      </div>
      <div className="rounded-md border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-700">LateFeesWorker scan</h3>
        <p className="text-xs text-gray-600">
          Walks invoices PAST due_date + grace_period_days, in SENT/PARTIAL/OVERDUE without an
          existing late-fee line item, and adds the configured fee (capped at max).
        </p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={scan.isPending || !policy.data?.isActive}
            onClick={runScan}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
          >
            Run scan now
          </button>
        </div>
      </div>
    </section>
  );
}

function AllocationsTab() {
  return (
    <section className="space-y-3">
      <p className="text-sm text-gray-700">
        Multi-invoice payment allocation. Use the per-payment <em>Allocate</em> action on the
        <code className="mx-1 rounded bg-gray-100 px-1 py-0.5 text-xs">/billing/payments</code>
        page to split a single payment across multiple invoices. The allocation total must equal the
        payment amount; the API enforces this inside a locked tx.
      </p>
      <p className="text-xs text-gray-500">
        Saved payment methods are managed inline on each family account page. Stripe SetupIntent
        wiring lands in Phase 3.
      </p>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
