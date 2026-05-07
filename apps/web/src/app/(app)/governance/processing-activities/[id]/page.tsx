'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { useProcessingActivity, useDpia } from '@/hooks/use-governance';
import {
  DPIA_RESIDUAL_PILL,
  DPIA_STATUS_LABELS,
  DPIA_STATUS_PILL,
  LEGAL_BASIS_LABELS,
  formatDate,
} from '@/lib/governance-format';

export default function ProcessingActivityDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const activity = useProcessingActivity(id);
  const dpia = useDpia(activity.data?.dpiaId ?? null);

  if (activity.isLoading || !activity.data) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  const a = activity.data;

  return (
    <div>
      <PageHeader title={a.activityName} description={a.purpose} />

      <Link
        href="/governance/processing-activities"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-campus-700"
      >
        ← Back to ROPA
      </Link>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
            Article 30 record
          </h3>
          <dl className="space-y-2 text-sm">
            <Field label="Legal basis" value={LEGAL_BASIS_LABELS[a.legalBasis] ?? a.legalBasis} />
            <Field label="Data categories" value={a.dataCategories.join(', ')} />
            <Field label="Data subjects" value={a.dataSubjects.join(', ')} />
            <Field label="Retention policy" value={a.retentionPolicyCategory ?? 'Not linked'} />
            <Field
              label="Cross-border transfer"
              value={
                a.transfersOutsideUkEea
                  ? `Yes — ${a.transferSafeguards ?? 'no safeguards documented'}`
                  : 'No'
              }
            />
            <Field
              label="Automated decision-making"
              value={a.automatedDecisionMaking ? 'Yes' : 'No'}
            />
            <Field label="Profiling" value={a.profiling ? 'Yes' : 'No'} />
            <Field
              label="High-risk processing"
              value={a.highRiskProcessing ? 'Yes — DPIA required' : 'No'}
            />
            <Field label="Last reviewed" value={formatDate(a.lastReviewedAt)} />
            {a.notes && <Field label="Notes" value={a.notes} />}
          </dl>
        </div>

        <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">DPIA</h3>
          {a.hasDpiaGap ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              <p className="font-semibold">DPIA required and not yet completed.</p>
              <p className="mt-1 text-xs">
                Article 35 mandates a DPIA for any processing likely to result in a high risk to the
                rights and freedoms of natural persons. This processing activity is flagged
                high-risk but has no DPIA linked.
              </p>
            </div>
          ) : !a.dpiaId ? (
            <p className="text-sm text-gray-500">No DPIA required for this activity.</p>
          ) : dpia.isLoading || !dpia.data ? (
            <p className="text-sm text-gray-500">Loading DPIA…</p>
          ) : (
            <dl className="space-y-2 text-sm">
              <Field label="DPIA title" value={dpia.data.dpiaTitle} />
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-gray-500">Status</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    DPIA_STATUS_PILL[dpia.data.status] ?? 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {DPIA_STATUS_LABELS[dpia.data.status] ?? dpia.data.status}
                </span>
              </div>
              {dpia.data.residualRiskLevel && (
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-gray-500">
                    Residual risk
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      DPIA_RESIDUAL_PILL[dpia.data.residualRiskLevel] ?? 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {dpia.data.residualRiskLevel}
                  </span>
                </div>
              )}
              <Field label="Trigger" value={dpia.data.triggerReason} />
              <Field label="Completed" value={formatDate(dpia.data.completedAt)} />
              {dpia.data.dpoOpinion && <Field label="DPO opinion" value={dpia.data.dpoOpinion} />}
              {dpia.data.risksIdentified && dpia.data.risksIdentified.length > 0 && (
                <div>
                  <div className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-gray-600">
                    Risks identified ({dpia.data.risksIdentified.length})
                  </div>
                  <ul className="space-y-2">
                    {dpia.data.risksIdentified.map((r, idx) => (
                      <li
                        key={idx}
                        className="rounded-md border border-gray-100 bg-gray-50 p-2 text-xs"
                      >
                        <div className="font-semibold text-gray-900">{r.riskDescription}</div>
                        <div className="mt-1 flex gap-2 text-gray-600">
                          <span>Likelihood: {r.likelihood}</span>
                          <span>Severity: {r.severity}</span>
                        </div>
                        <div className="mt-1 text-gray-700">Mitigation: {r.mitigationMeasures}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </dl>
          )}
        </div>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <span className="max-w-[60%] text-right text-sm text-gray-900">{value}</span>
    </div>
  );
}
