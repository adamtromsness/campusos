'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useItAsset,
  useItAssetAssignments,
  useItAssetDocuments,
  useItDamageReports,
  useItRepairs,
} from '@/hooks/use-it';
import {
  IT_ASSET_STATUS_LABELS,
  IT_ASSET_STATUS_PILL,
  IT_DAMAGE_PILL,
  IT_DAMAGE_SEVERITY_LABELS,
  IT_REPAIR_STATUS_LABELS,
  IT_REPAIR_STATUS_PILL,
  formatItCurrency,
  formatItDate,
  formatItDateTime,
} from '@/lib/it-format';

export default function AssetDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const asset = useItAsset(id);
  const assignments = useItAssetAssignments(id);
  const documents = useItAssetDocuments(id);
  const damages = useItDamageReports({ assetId: id });
  const repairs = useItRepairs({ assetId: id });

  if (asset.isLoading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (!asset.data) {
    return <div className="p-6 text-sm text-rose-700">Asset not found.</div>;
  }
  const a = asset.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader title={a.assetTag} description={`${a.make ?? ''} ${a.model ?? ''}`.trim()} />
      <div className="rounded-md border border-gray-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs uppercase text-gray-500">Status</p>
            <span
              className={`mt-1 inline-block rounded px-2 py-0.5 text-xs ${IT_ASSET_STATUS_PILL[a.status]}`}
            >
              {IT_ASSET_STATUS_LABELS[a.status]}
            </span>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Category</p>
            <p className="mt-1 font-medium">{a.categoryName}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Serial</p>
            <p className="mt-1 font-mono text-xs">{a.serialNumber ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Cost / Warranty</p>
            <p className="mt-1">
              {formatItCurrency(a.purchaseCost)} · {formatItDate(a.warrantyExpiry)}
            </p>
          </div>
        </div>
        {a.currentAssigneeName ? (
          <div className="mt-3 rounded bg-sky-50 p-2 text-sm text-sky-800">
            Currently assigned to <strong>{a.currentAssigneeName}</strong>
          </div>
        ) : null}
        {a.notes ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700">{a.notes}</p>
        ) : null}
      </div>

      <Section title={`Assignment history (${assignments.data?.length ?? 0})`}>
        {(assignments.data?.length ?? 0) === 0 ? (
          <Empty>No assignment history.</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {assignments.data?.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-medium">{r.assigneeName}</p>
                  <p className="text-xs text-gray-500">
                    Assigned {formatItDateTime(r.assignedAt)}
                    {r.returnedAt ? ` · Returned ${formatItDateTime(r.returnedAt)}` : ''}
                  </p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    r.returnedAt ? 'bg-gray-100 text-gray-700' : 'bg-emerald-100 text-emerald-700'
                  }`}
                >
                  {r.returnedAt ? 'Returned' : 'Active'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Damage reports (${damages.data?.length ?? 0})`}>
        {(damages.data?.length ?? 0) === 0 ? (
          <Empty>No damage reports.</Empty>
        ) : (
          <ul className="space-y-2">
            {damages.data?.map((d) => (
              <li key={d.id} className="rounded border border-gray-200 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{d.reportedByName}</p>
                  <span className={`rounded px-2 py-0.5 text-xs ${IT_DAMAGE_PILL[d.severity]}`}>
                    {IT_DAMAGE_SEVERITY_LABELS[d.severity]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{formatItDateTime(d.reportedAt)}</p>
                <p className="mt-2 whitespace-pre-wrap text-gray-700">{d.description}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Repair records (${repairs.data?.length ?? 0})`}>
        {(repairs.data?.length ?? 0) === 0 ? (
          <Empty>No repair records.</Empty>
        ) : (
          <ul className="space-y-2">
            {repairs.data?.map((r) => (
              <li key={r.id} className="rounded border border-gray-200 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{r.repairType.replace('_', ' ')}</p>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${IT_REPAIR_STATUS_PILL[r.status]}`}
                  >
                    {IT_REPAIR_STATUS_LABELS[r.status]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Sent {formatItDate(r.sentForRepairAt)} · ETA {formatItDate(r.estimatedReturnDate)}
                </p>
                {r.vendorName ? (
                  <p className="text-xs text-gray-500">Vendor: {r.vendorName}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Documents (${documents.data?.length ?? 0})`}>
        {(documents.data?.length ?? 0) === 0 ? (
          <Empty>No documents.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {documents.data?.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded border border-gray-100 p-2"
              >
                <span>{d.fileName}</span>
                <span className="text-xs uppercase text-gray-500">{d.documentType}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">{title}</h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-500">{children}</p>;
}
