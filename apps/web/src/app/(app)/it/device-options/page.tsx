'use client';

import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useApproveItDeviceSelection,
  useItDeviceOptions,
  useItDeviceSelections,
  useRejectItDeviceSelection,
} from '@/hooks/use-it';
import {
  IT_CONTEXT_LABELS,
  IT_SELECTION_STATUS_LABELS,
  IT_SELECTION_STATUS_PILL,
  formatItCurrency,
  formatItDateTime,
} from '@/lib/it-format';

export default function DeviceOptionsPage() {
  const options = useItDeviceOptions(true);
  const selections = useItDeviceSelections({});
  const approve = useApproveItDeviceSelection();
  const reject = useRejectItDeviceSelection();
  const { toast } = useToast();

  async function handleApprove(id: string) {
    if (!confirm('Approve this device selection?')) return;
    try {
      await approve.mutateAsync({ id, body: {} });
      toast('Selection approved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function handleReject(id: string) {
    if (!confirm('Reject this device selection?')) return;
    try {
      await reject.mutateAsync(id);
      toast('Selection rejected');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Device options & selections"
        description="Onboarding catalogue + parent-active device selection workflow (ADR-066)"
      />

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Available device options</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {options.data?.map((o) => (
            <div
              key={o.id}
              className={`rounded-md border p-3 text-sm ${
                o.isActive ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-60'
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
                    <span key={s} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      {s}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="mt-2 text-xs text-gray-500">
                Cost difference: {formatItCurrency(o.costDifference ?? 0)}
              </p>
            </div>
          ))}
          {!options.isLoading && (options.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-gray-500">No device options configured.</p>
          ) : null}
        </div>
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Active selections</h2>
        {(selections.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No selections in progress.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {selections.data?.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">
                    {s.personName} · {s.optionName}
                  </p>
                  <p className="text-xs text-gray-500">
                    {IT_CONTEXT_LABELS[s.selectionContext]} · Selected{' '}
                    {formatItDateTime(s.selectedAt)}
                  </p>
                  {s.assetTag ? (
                    <p className="text-xs text-gray-500">Provisioned as {s.assetTag}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${IT_SELECTION_STATUS_PILL[s.status]}`}
                  >
                    {IT_SELECTION_STATUS_LABELS[s.status]}
                  </span>
                  {s.status === 'PENDING' || s.status === 'SELECTED' ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleApprove(s.id)}
                        className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReject(s.id)}
                        className="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
