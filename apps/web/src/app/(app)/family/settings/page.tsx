'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  useFamilySettings,
  useUpdateFamilySettings,
  type FamilySettingsDto,
  type UpdateFamilySettingsPayload,
} from '@/hooks/use-family-children';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';

/**
 * /family/settings — household-wide shared attributes. Children
 * inherit display name, address, doctor, and insurance from this
 * record by default; per-child overrides ship in the next commit
 * (inheritance toggle).
 *
 * Read-only for child viewers; the API's canEdit flag drives the
 * input disabled state and the assertNotChildViewer guard in the
 * service is the authoritative server-side block.
 */
export default function FamilySettingsPage() {
  const { data, isLoading, error } = useFamilySettings();
  const update = useUpdateFamilySettings();
  const { toast } = useToast();

  const [form, setForm] = useState<UpdateFamilySettingsPayload>({});
  const [initial, setInitial] = useState<UpdateFamilySettingsPayload>({});

  useEffect(() => {
    if (!data) return;
    const snapshot: UpdateFamilySettingsPayload = {
      displayName: data.displayName ?? '',
      addressLine1: data.addressLine1 ?? '',
      addressLine2: data.addressLine2 ?? '',
      city: data.city ?? '',
      state: data.state ?? '',
      postalCode: data.postalCode ?? '',
      country: data.country ?? '',
      homePhone: data.homePhone ?? '',
      doctorName: data.doctorName ?? '',
      doctorPhone: data.doctorPhone ?? '',
      doctorClinic: data.doctorClinic ?? '',
      insuranceProvider: data.insuranceProvider ?? '',
      insurancePolicy: data.insurancePolicy ?? '',
      insuranceGroup: data.insuranceGroup ?? '',
    };
    setForm(snapshot);
    setInitial(snapshot);
  }, [data]);

  if (isLoading) return <PageLoader label="Loading family settings…" />;
  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <BackLink />
        <p className="mt-4 text-sm text-red-600">Could not load family settings.</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <BackLink />
        <p className="mt-4 text-sm text-gray-600">No family record yet.</p>
      </div>
    );
  }

  const dirty = isDirty(form, initial);
  const editable = data.canEdit;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || !dirty) return;
    try {
      await update.mutateAsync(form);
      toast('Family settings saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <BackLink />
      <header className="mt-2 mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">Family Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Shared across your whole family. Children inherit these by default.
        </p>
        {!editable && (
          <p className="mt-2 text-xs text-amber-700">
            Read-only view — only a parent or guardian of this family can edit these fields.
          </p>
        )}
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <PrimaryContactCard data={data} />

        <Card title="Family name">
          <Field
            id="displayName"
            label="Display name"
            value={form.displayName ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, displayName: v }))}
            placeholder='e.g. "The Tromsness Family"'
            disabled={!editable}
            hint="Used in invitations and the family-page heading. Leave blank to use the household last name."
          />
        </Card>

        <Card title="Primary address">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="addressLine1"
              label="Street address"
              value={form.addressLine1 ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, addressLine1: v }))}
              disabled={!editable}
              className="sm:col-span-2"
            />
            <Field
              id="addressLine2"
              label="Apartment / unit"
              value={form.addressLine2 ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, addressLine2: v }))}
              disabled={!editable}
              className="sm:col-span-2"
            />
            <Field
              id="city"
              label="City"
              value={form.city ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, city: v }))}
              disabled={!editable}
            />
            <Field
              id="state"
              label="State / province"
              value={form.state ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, state: v }))}
              disabled={!editable}
            />
            <Field
              id="postalCode"
              label="ZIP / postal code"
              value={form.postalCode ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, postalCode: v }))}
              disabled={!editable}
            />
            <Field
              id="country"
              label="Country"
              value={form.country ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, country: v }))}
              disabled={!editable}
            />
            <Field
              id="homePhone"
              label="Home phone"
              type="tel"
              value={form.homePhone ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, homePhone: v }))}
              disabled={!editable}
              className="sm:col-span-2"
            />
          </div>
        </Card>

        <Card title="Family doctor">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="doctorName"
              label="Doctor name"
              value={form.doctorName ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, doctorName: v }))}
              disabled={!editable}
            />
            <Field
              id="doctorPhone"
              label="Doctor phone"
              type="tel"
              value={form.doctorPhone ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, doctorPhone: v }))}
              disabled={!editable}
            />
            <Field
              id="doctorClinic"
              label="Clinic"
              value={form.doctorClinic ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, doctorClinic: v }))}
              disabled={!editable}
              className="sm:col-span-2"
            />
          </div>
        </Card>

        <Card title="Family insurance">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="insuranceProvider"
              label="Provider"
              value={form.insuranceProvider ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, insuranceProvider: v }))}
              disabled={!editable}
              className="sm:col-span-2"
            />
            <Field
              id="insurancePolicy"
              label="Policy number"
              value={form.insurancePolicy ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, insurancePolicy: v }))}
              disabled={!editable}
            />
            <Field
              id="insuranceGroup"
              label="Group number"
              value={form.insuranceGroup ?? ''}
              onChange={(v) => setForm((f) => ({ ...f, insuranceGroup: v }))}
              disabled={!editable}
            />
          </div>
        </Card>

        {editable && (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!dirty || update.isPending}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60"
            >
              {update.isPending && <LoadingSpinner size="sm" />}
              <span>{update.isPending ? 'Saving…' : 'Save Changes'}</span>
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/family"
      className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700"
    >
      ← My Family
    </Link>
  );
}

function PrimaryContactCard({ data }: { data: FamilySettingsDto }) {
  return (
    <div className="rounded-card border border-gray-200 bg-gray-50/40 p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Primary point of contact</h2>
      {data.primaryContactName ? (
        <p className="mt-1 text-sm text-gray-700">
          <span className="font-medium">{data.primaryContactName}</span> is currently the primary
          contact for your family. Use the{' '}
          <Link href="/family" className="text-campus-700 hover:text-campus-600">
            Parents &amp; Guardians
          </Link>{' '}
          section to change who&rsquo;s primary.
        </p>
      ) : (
        <p className="mt-1 text-sm text-gray-700">
          No primary contact assigned. Visit{' '}
          <Link href="/family" className="text-campus-700 hover:text-campus-600">
            Parents &amp; Guardians
          </Link>{' '}
          to designate one.
        </p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  disabled,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
      />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function isDirty(a: UpdateFamilySettingsPayload, b: UpdateFamilySettingsPayload): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<
    keyof UpdateFamilySettingsPayload
  >;
  for (const k of keys) {
    if ((a[k] ?? '') !== (b[k] ?? '')) return true;
  }
  return false;
}
