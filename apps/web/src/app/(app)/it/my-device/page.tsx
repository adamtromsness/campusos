'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAuthStore } from '@/lib/auth-store';
import { useMyChildren } from '@/hooks/use-children';
import {
  useCreateItDeviceSelection,
  useItDeviceOptions,
  useItDeviceSelections,
} from '@/hooks/use-it';
import {
  IT_CONTEXT_LABELS,
  IT_SELECTION_STATUS_LABELS,
  IT_SELECTION_STATUS_PILL,
  formatItCurrency,
  formatItDateTime,
} from '@/lib/it-format';
import type { ItDeviceOptionDto, ItSelectionContext } from '@/lib/types';

/**
 * /it/my-device — student / parent device-selection flow
 * (ADR-066 parent-active onboarding path).
 *
 * Students pick for themselves. Parents pick a child first, then
 * a device option. Both submit to /it/device-selections — the
 * service-layer authorisation enforces "students choose for
 * themselves; parents choose only for children linked via
 * sis_student_guardians".
 */
export default function MyDevicePage() {
  const user = useAuthStore((s) => s.user);
  const isParent = user?.activePersona?.type === 'PARENT';
  const isStudent = user?.activePersona?.type === 'STUDENT';
  const children = useMyChildren();
  const options = useItDeviceOptions();
  const create = useCreateItDeviceSelection();
  const { toast } = useToast();

  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [selectedOption, setSelectedOption] = useState<ItDeviceOptionDto | null>(null);
  const [context, setContext] = useState<ItSelectionContext>('ENROLMENT');

  const targetPersonId = isStudent ? user?.personId : selectedChildId ? selectedChildId : null;

  const myExisting = useItDeviceSelections({
    personId: targetPersonId ?? undefined,
  });

  async function submit() {
    if (!targetPersonId || !selectedOption) return;
    try {
      await create.mutateAsync({
        personId: targetPersonId,
        optionId: selectedOption.id,
        selectionContext: context,
      });
      toast(
        `Selection submitted · ${selectedOption.optionName} — IT will approve and provision shortly.`,
      );
      setSelectedOption(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not submit', 'error');
    }
  }

  if (!isStudent && !isParent) {
    return (
      <div className="p-6 text-sm text-gray-500">
        This page is for students choosing a device for themselves or parents choosing for their
        children.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Choose a device"
        description="Pick the device that best fits this year's needs. IT will provision it shortly."
      />

      {isParent ? (
        <section className="rounded-md border border-gray-200 bg-white p-4">
          <p className="mb-2 text-sm font-medium text-gray-700">Choose a child</p>
          <div className="flex flex-wrap gap-2">
            {children.data?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedChildId(c.personId)}
                className={`rounded-full border px-3 py-1 text-sm ${
                  selectedChildId === c.personId
                    ? 'border-campus-600 bg-campus-100 text-campus-800'
                    : 'border-gray-300 bg-white text-gray-700'
                }`}
              >
                {c.firstName} {c.lastName}
              </button>
            ))}
            {!children.isLoading && (children.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-gray-500">No children linked to your account.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {targetPersonId ? (
        <>
          <section className="rounded-md border border-gray-200 bg-white p-4">
            <p className="mb-2 text-sm font-medium text-gray-700">Why are you choosing?</p>
            <div className="flex gap-2">
              {(['ENROLMENT', 'REFRESH', 'REPLACEMENT'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setContext(c)}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    context === c
                      ? 'border-campus-600 bg-campus-100 text-campus-800'
                      : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {IT_CONTEXT_LABELS[c]}
                </button>
              ))}
            </div>
          </section>

          <section>
            <p className="mb-2 text-sm font-medium text-gray-700">Pick an option</p>
            <div className="grid gap-3 md:grid-cols-2">
              {options.data?.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setSelectedOption(o)}
                  className={`rounded-md border p-4 text-left transition ${
                    selectedOption?.id === o.id
                      ? 'border-campus-600 bg-campus-50'
                      : 'border-gray-200 bg-white hover:border-campus-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{o.optionName}</p>
                    <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
                      {o.deviceType}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{o.operatingSystem ?? '—'}</p>
                  {o.specifications ? (
                    <p className="mt-2 text-xs text-gray-700">{o.specifications}</p>
                  ) : null}
                  {o.softwareAvailable.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {o.softwareAvailable.map((s) => (
                        <span
                          key={s}
                          className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-gray-500">
                    Cost difference: {formatItCurrency(o.costDifference ?? 0)}
                  </p>
                </button>
              ))}
            </div>
          </section>

          <button
            type="button"
            disabled={!selectedOption || create.isPending}
            onClick={submit}
            className="w-full rounded-md bg-campus-600 px-4 py-2 text-white hover:bg-campus-700 disabled:opacity-50"
          >
            {create.isPending ? 'Submitting…' : 'Submit selection'}
          </button>
        </>
      ) : null}

      {(myExisting.data?.length ?? 0) > 0 ? (
        <section className="rounded-md border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Past selections</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {myExisting.data?.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="font-medium">{s.optionName}</p>
                  <p className="text-xs text-gray-500">
                    {IT_CONTEXT_LABELS[s.selectionContext]} · {formatItDateTime(s.selectedAt)}
                  </p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${IT_SELECTION_STATUS_PILL[s.status]}`}
                >
                  {IT_SELECTION_STATUS_LABELS[s.status]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
