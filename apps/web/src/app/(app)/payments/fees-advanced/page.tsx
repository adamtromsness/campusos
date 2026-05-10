'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAcademicYears } from '@/hooks/use-enrollment';
import { useFeeCategories, useFeeSchedules } from '@/hooks/use-billing';
import {
  useAutoInvoiceRules,
  useCreateAutoInvoiceRule,
  useCreateDiscountRule,
  useDiscountRules,
  useGenerateInvoicesFromFeeSchedule,
  useInvoiceGenerationRuns,
  useTriggerAutoInvoiceRule,
  useUpdateAutoInvoiceRule,
  useUpdateDiscountRule,
} from '@/hooks/use-payments-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  DISCOUNT_TYPE_LABELS,
  DISCOUNT_TYPES,
  RUN_STATUS_PILL,
  RUN_TYPE_LABELS,
  TRIGGER_TYPE_LABELS,
  TRIGGER_TYPES,
  formatCurrency,
  formatDateTime,
} from '@/lib/billing-format';
import type {
  AutoInvoiceRuleDto,
  CalculationMethod,
  DiscountRuleDto,
  DiscountType,
  TriggerType,
} from '@/lib/types';

export default function FeesAdvancedPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['fin-001:admin']);
  const isReader = !!user && hasAnyPermission(user, ['fin-001:read']);

  const schedules = useFeeSchedules(isReader);
  const rules = useAutoInvoiceRules(true, isAdmin);
  const runs = useInvoiceGenerationRuns({}, isAdmin);
  const discounts = useDiscountRules({ includeInactive: true }, isAdmin);

  const [showNewRule, setShowNewRule] = useState(false);
  const [showNewDiscount, setShowNewDiscount] = useState(false);
  const [generateScheduleId, setGenerateScheduleId] = useState<string | null>(null);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Fees & auto-invoicing" description="Admin access required." />
        <EmptyState
          title="Admin only"
          description="The advanced fee surface requires fin-001:admin."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fees & auto-invoicing"
        description="Auto-invoice rules, sibling + early-payment discounts, and bulk generation runs."
        actions={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowNewDiscount(true)}
              className="rounded border border-campus-700 px-3 py-1.5 text-sm font-semibold text-campus-700 hover:bg-campus-50"
            >
              New discount
            </button>
            <button
              type="button"
              onClick={() => setShowNewRule(true)}
              className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800"
            >
              New auto rule
            </button>
          </div>
        }
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
            Auto-invoice rules
          </h2>
        </div>
        {rules.isLoading ? (
          <LoadingSpinner />
        ) : (rules.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No auto rules yet"
            description="Create one to fire bulk invoices on a trigger."
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Trigger</th>
                  <th className="px-3 py-2">Fee schedule</th>
                  <th className="px-3 py-2">Last run</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(rules.data ?? []).map((r) => (
                  <RuleRow key={r.id} rule={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
            Discount rules
          </h2>
        </div>
        {discounts.isLoading ? (
          <LoadingSpinner />
        ) : (discounts.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No discounts"
            description="Add SIBLING or EARLY_PAYMENT rules to apply at invoice generation."
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2">Sibling order</th>
                  <th className="px-3 py-2">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(discounts.data ?? []).map((d) => (
                  <DiscountRow key={d.id} discount={d} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
            Fee schedules
          </h2>
          <p className="text-xs text-gray-500">
            Cycle 6 fee schedules — click <em>Generate</em> to bulk-create invoices.
          </p>
        </div>
        {schedules.isLoading ? (
          <LoadingSpinner />
        ) : (schedules.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No fee schedules"
            description="Add via the Billing → Fees page first."
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Amount</th>
                  <th className="px-3 py-2">Cadence</th>
                  <th className="px-3 py-2">Grade</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(schedules.data ?? []).map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">{s.name}</td>
                    <td className="px-3 py-2">{formatCurrency(s.amount)}</td>
                    <td className="px-3 py-2">{s.recurrence}</td>
                    <td className="px-3 py-2 text-gray-600">{s.gradeLevel ?? '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setGenerateScheduleId(s.id)}
                        className="text-xs font-semibold text-campus-700 hover:underline"
                      >
                        Generate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
          Recent generation runs
        </h2>
        {runs.isLoading ? (
          <LoadingSpinner />
        ) : (runs.data?.length ?? 0) === 0 ? (
          <EmptyState title="No runs yet" />
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Schedule</th>
                  <th className="px-3 py-2">Created / skipped / failed</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(runs.data ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-gray-600">
                      {formatDateTime(r.startedAt ?? r.createdAt)}
                    </td>
                    <td className="px-3 py-2">{RUN_TYPE_LABELS[r.runType]}</td>
                    <td className="px-3 py-2 text-gray-700">{r.feeScheduleName ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {r.invoicesCreated} / {r.invoicesSkipped} / {r.invoicesFailed}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_PILL[r.status]}`}
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showNewRule && <NewAutoRuleModal onClose={() => setShowNewRule(false)} />}
      {showNewDiscount && <NewDiscountModal onClose={() => setShowNewDiscount(false)} />}
      {generateScheduleId && (
        <GenerateInvoicesModal
          scheduleId={generateScheduleId}
          onClose={() => setGenerateScheduleId(null)}
        />
      )}
    </div>
  );
}

function RuleRow({ rule }: { rule: AutoInvoiceRuleDto }) {
  const trigger = useTriggerAutoInvoiceRule(rule.id);
  const update = useUpdateAutoInvoiceRule(rule.id);
  const { toast } = useToast();
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-3 py-2">{rule.name}</td>
      <td className="px-3 py-2 text-gray-700">{TRIGGER_TYPE_LABELS[rule.triggerType]}</td>
      <td className="px-3 py-2 text-gray-700">{rule.feeScheduleName ?? '—'}</td>
      <td className="px-3 py-2 text-gray-600">
        {rule.lastRunAt ? formatDateTime(rule.lastRunAt) : '—'}
      </td>
      <td className="px-3 py-2">
        {rule.isActive ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
            Active
          </span>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            Inactive
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={!rule.isActive || trigger.isPending}
            onClick={async () => {
              try {
                const run = await trigger.mutateAsync({});
                toast(
                  `Generated ${run.invoicesCreated} invoice(s) (${run.invoicesSkipped} skipped)`,
                  'success',
                );
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Trigger failed', 'error');
              }
            }}
            className="text-xs font-semibold text-campus-700 hover:underline disabled:text-gray-400"
          >
            Trigger
          </button>
          <button
            type="button"
            onClick={() => {
              void update.mutateAsync({ isActive: !rule.isActive });
            }}
            className="text-xs text-gray-600 hover:underline"
          >
            {rule.isActive ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </td>
    </tr>
  );
}

function DiscountRow({ discount }: { discount: DiscountRuleDto }) {
  const update = useUpdateDiscountRule(discount.id);
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-3 py-2">{discount.name}</td>
      <td className="px-3 py-2 text-gray-700">{DISCOUNT_TYPE_LABELS[discount.discountType]}</td>
      <td className="px-3 py-2">
        {discount.calculationMethod === 'PERCENTAGE'
          ? `${discount.value}%`
          : formatCurrency(discount.value)}
      </td>
      <td className="px-3 py-2 text-gray-600">{discount.siblingOrder ?? '—'}</td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => void update.mutateAsync({ isActive: !discount.isActive })}
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            discount.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
          }`}
        >
          {discount.isActive ? 'Active' : 'Inactive'}
        </button>
      </td>
    </tr>
  );
}

function NewAutoRuleModal({ onClose }: { onClose: () => void }) {
  const create = useCreateAutoInvoiceRule();
  const schedules = useFeeSchedules();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<TriggerType>('TERM_START');
  const [feeScheduleId, setFeeScheduleId] = useState('');
  const [triggerOffset, setTriggerOffset] = useState('-14');
  const [triggerDom, setTriggerDom] = useState('1');
  const [grade, setGrade] = useState('');

  async function submit() {
    try {
      await create.mutateAsync({
        name,
        triggerType,
        feeScheduleId,
        triggerTermOffsetDays:
          triggerType === 'TERM_START' && triggerOffset ? Number(triggerOffset) : undefined,
        triggerDayOfMonth:
          triggerType === 'DATE_OF_MONTH' && triggerDom ? Number(triggerDom) : undefined,
        appliesToGradeLevel: grade || undefined,
      });
      toast('Created auto-invoice rule', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Create failed', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New auto-invoice rule"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name || !feeScheduleId || create.isPending}
            onClick={submit}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Tuition — fire 14 days before term"
          />
        </Field>
        <Field label="Trigger type">
          <select
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as TriggerType)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            {TRIGGER_TYPES.map((t) => (
              <option key={t} value={t}>
                {TRIGGER_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        {triggerType === 'TERM_START' && (
          <Field label="Trigger offset days (negative = before term)">
            <input
              type="number"
              value={triggerOffset}
              onChange={(e) => setTriggerOffset(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </Field>
        )}
        {triggerType === 'DATE_OF_MONTH' && (
          <Field label="Day of month (1-28)">
            <input
              type="number"
              min="1"
              max="28"
              value={triggerDom}
              onChange={(e) => setTriggerDom(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </Field>
        )}
        <Field label="Fee schedule">
          <select
            value={feeScheduleId}
            onChange={(e) => setFeeScheduleId(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">— Select a schedule —</option>
            {(schedules.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({formatCurrency(s.amount)})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Applies to grade level (optional)">
          <input
            type="text"
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            placeholder="e.g. 10"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
      </div>
    </Modal>
  );
}

function NewDiscountModal({ onClose }: { onClose: () => void }) {
  const create = useCreateDiscountRule();
  const years = useAcademicYears();
  const categories = useFeeCategories();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [discountType, setDiscountType] = useState<DiscountType>('SIBLING');
  const [calculationMethod, setCalculationMethod] = useState<CalculationMethod>('PERCENTAGE');
  const [value, setValue] = useState('10');
  const [siblingOrder, setSiblingOrder] = useState('2');
  const [feeCategoryId, setFeeCategoryId] = useState('');
  const [academicYearId, setAcademicYearId] = useState('');
  const [minInvoice, setMinInvoice] = useState('');

  async function submit() {
    try {
      await create.mutateAsync({
        name,
        discountType,
        calculationMethod,
        value: Number(value),
        siblingOrder: discountType === 'SIBLING' ? Number(siblingOrder) : undefined,
        appliesToFeeCategoryId: feeCategoryId || undefined,
        academicYearId: academicYearId || undefined,
        minimumInvoiceAmount: minInvoice ? Number(minInvoice) : undefined,
      });
      toast('Created discount rule', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Create failed', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New discount rule"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name || !value || create.isPending}
            onClick={submit}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sibling discount — 2nd child"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Discount type">
            <select
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as DiscountType)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {DISCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DISCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Calculation">
            <select
              value={calculationMethod}
              onChange={(e) => setCalculationMethod(e.target.value as CalculationMethod)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="PERCENTAGE">Percentage</option>
              <option value="FIXED_AMOUNT">Fixed amount</option>
            </select>
          </Field>
        </div>
        <Field label={calculationMethod === 'PERCENTAGE' ? 'Value (%)' : 'Value ($)'}>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
        {discountType === 'SIBLING' && (
          <Field label="Sibling order (2 = second child)">
            <input
              type="number"
              min="2"
              value={siblingOrder}
              onChange={(e) => setSiblingOrder(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </Field>
        )}
        <Field label="Fee category (optional)">
          <select
            value={feeCategoryId}
            onChange={(e) => setFeeCategoryId(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">— Any category —</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Academic year (optional)">
          <select
            value={academicYearId}
            onChange={(e) => setAcademicYearId(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">— Any year —</option>
            {(years.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Minimum invoice amount (optional)">
          <input
            type="number"
            step="0.01"
            min="0"
            value={minInvoice}
            onChange={(e) => setMinInvoice(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </Field>
      </div>
    </Modal>
  );
}

function GenerateInvoicesModal({
  scheduleId,
  onClose,
}: {
  scheduleId: string;
  onClose: () => void;
}) {
  const generate = useGenerateInvoicesFromFeeSchedule(scheduleId);
  const years = useAcademicYears();
  const { toast } = useToast();
  const [academicYearId, setAcademicYearId] = useState('');

  async function submit() {
    try {
      const run = await generate.mutateAsync({ academicYearId: academicYearId || undefined });
      toast(
        `Generated ${run.invoicesCreated} invoice(s) (${run.invoicesSkipped} skipped)`,
        'success',
      );
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Generation failed', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Generate invoices from fee schedule"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={generate.isPending}
            onClick={submit}
            className="rounded bg-campus-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Generate
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-gray-700">
          This will create one DRAFT invoice per eligible family. Existing non-cancelled invoices
          for the same fee schedule are skipped. Sibling and early-payment discounts are applied at
          generation time.
        </p>
        <Field label="Academic year (optional)">
          <select
            value={academicYearId}
            onChange={(e) => setAcademicYearId(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">— Any —</option>
            {(years.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
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
